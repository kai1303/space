// This entry is bundled at build time. Only the desktop main process owns its IPC pipe.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { browserMcpTurn } from './browser-mcp.mjs';
import { runConnector } from './runtime.mjs';

async function login({ command, args, env }, signal) {
  const result = new Promise(resolve => {
    const cleanup = () => { process.off('message', receive); signal.removeEventListener('abort', abort); };
    const receive = message => {
      if (message !== 'signed-in' && message !== 'cancelled') return;
      cleanup(); resolve(message);
    };
    const abort = () => { cleanup(); resolve('cancelled'); };
    process.on('message', receive); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  process.send({ type: 'login', command, args, env });
  const message = await result;
  if (message !== 'signed-in') throw new Error('Provider sign-in was cancelled or failed.');
}

process.once('disconnect', () => {
  if (process.listenerCount('SIGTERM')) process.emit('SIGTERM');
  else process.exit(0);
});
process.once('message', async ({ provider, origin, code, directory }) => {
  try {
    await runConnector(['--provider', provider, '--url', origin, ...(code ? ['--pair', code] : [])], {
      directory, login,
      webVault: (request, signal) => new Promise(resolve => {
        const finish = result => {
          process.off('message', receive); signal.removeEventListener('abort', abort); resolve(result);
        };
        const receive = message => {
          if (message?.type === 'web-vault-result' && message.id === request.id) finish(message.result);
        };
        const abort = () => {
          if (process.connected) process.send({type: 'web-vault-cancel', id: request.id});
          finish({status: 'unavailable'});
        };
        if (signal.aborted || !process.connected) return finish({status: 'unavailable'});
        process.on('message', receive); signal.addEventListener('abort', abort, {once: true});
        process.send({type: 'web-vault', request}, error => { if (error) abort(); });
      }),
      browserTurn: connection => async (request, signal) => {
        if (provider !== 'codex' || !request.context?.handoff?.browser_url) return;
        const id = randomUUID();
        const cancel = () => { if (process.connected) process.send({ type: 'vault-cancel', id }); };
        signal.addEventListener('abort', cancel, { once: true });
        return browserMcpTurn((action, input) => new Promise(resolve => {
          const finish = status => {
            process.off('message', receive);
            signal.removeEventListener('abort', abort);
            resolve(status);
          };
          const abort = () => finish('unavailable');
          const receive = message => {
            if (message?.type === 'vault-result' && message.id === id) finish(message.status);
          };
          if (!process.connected || signal.aborted) return abort();
          process.on('message', receive);
          signal.addEventListener('abort', abort, { once: true });
          process.send({ type: 'vault-fill', id, action, input, page: request.context.handoff.browser_url, session: request.session_id, installation: connection.installation_id, workspace: connection.workspace_id }, error => { if (error) abort(); });
        }), signal);
      },
      paired: () => { writeFileSync(join(directory, 'paired'), '', { mode: 0o600 }); process.send({ type: 'paired' }); },
      revoked: () => rmSync(join(directory, 'paired'), { force: true }),
      announce: url => promisify(execFile)('/usr/bin/open', [url]),
    });
  } catch (error) {
    if (process.connected) process.send({ type: 'failure', message: error.message });
    process.exitCode = 1;
  } finally {
    if (process.connected) process.disconnect();
  }
});
