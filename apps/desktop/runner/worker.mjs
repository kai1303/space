// This entry is bundled at build time. Only the desktop main process owns its IPC pipe.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { runConnector, claudeEnvironment, resolveClaudeCommand, kiroEnvironment } from './runtime.mjs';

async function login(provider, directory, signal) {
  const claude = provider === 'claude';
  const env = await (claude ? claudeEnvironment : kiroEnvironment)(directory);
  const command = claude ? await resolveClaudeCommand() : 'kiro-cli';
  const result = once(process, 'message', { signal });
  process.send({ type: 'login', command, args: claude ? ['auth', 'login'] : ['login'], env });
  const [message] = await result;
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
