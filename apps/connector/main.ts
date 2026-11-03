#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { ConnectorStore, platformOrigin, type Credentials } from './storage.js';
import { authorize, refreshCredentials, revokeCredentials } from './oauth.js';
import { claimPairing, connectPlatform, startCodex, type AuthStatus } from './runtime.js';

export function parseOptions(args: string[]) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    connect: { type: 'boolean', default: false }, url: { type: 'string' }, pair: { type: 'string' }, login: { type: 'boolean', default: false },
    logout: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (values.logout && (values.login || values.pair || values.url || values.connect)) throw new Error('Use --logout by itself.');
  if (values.pair !== undefined && !/^[A-Za-z0-9_-]{32}$/.test(values.pair)) throw new Error('Use the 32-character pairing code from Space.');
  return { url: values.url ? platformOrigin(values.url) : undefined, pair: values.pair, login: values.login, logout: values.logout, help: values.help, connect: values.connect };
}

export async function runConnector(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) {
    console.log('Space Connector\n\n  --url <origin> --pair <code>  Pair this computer with Space\n  --connect                   Prompt for a new pairing code\n  --login                     Continue with ChatGPT again\n  --logout                    Remove local ChatGPT tokens\n\nRun without arguments to reconnect. Pairing codes are prompted when omitted.\nKeep this terminal running. Codex CLI must be installed on PATH.');
    return;
  }
  const store = new ConnectorStore();
  const unlock = await store.lock();
  const controller = new AbortController();
  let codex: Awaited<ReturnType<typeof startCodex>> | undefined;
  let platform: ReturnType<typeof connectPlatform> | undefined;
  let renewal: NodeJS.Timeout | undefined;
  let renewalTask: Promise<void> | undefined;
  let status: AuthStatus = 'required';
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const stop = () => { controller.abort(); finish(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    let state = await store.load();
    if (options.logout) {
      if (state.credentials) {
        const revoked = await revokeCredentials(state.credentials);
        delete state.credentials;
        await store.save(state);
        console.log(revoked ? 'Signed out of ChatGPT on this computer.' : 'Local ChatGPT tokens removed. Remote revocation was not confirmed; disconnect the app in ChatGPT Settings.');
      } else console.log('No local ChatGPT tokens are saved.');
      return;
    }
    let paired = false;
    if (options.connect || options.pair || !state.connection) {
      const origin = options.url ?? state.pending?.origin ?? state.connection?.origin;
      if (!origin) throw new Error('Provide --url with the Space platform origin when pairing this computer.');
      let code = options.pair;
      if (!code) {
        if (!process.stdin.isTTY) throw new Error('Provide --pair with the pairing code from Space.');
        const input = createInterface({ input: process.stdin, output: process.stdout });
        try { code = (await input.question('Pairing code from Space: ', { signal: controller.signal })).trim(); }
        finally { input.close(); }
      }
      await claimPairing(store, origin, code);
      state = await store.load();
      paired = true;
      console.log('This computer is paired with Space. ChatGPT credentials stay on this computer.');
    } else if (options.url && options.url !== state.connection.origin) {
      throw new Error('The saved connector uses a different platform. Provide a new --pair code to change it.');
    }
    if (!state.connection) throw new Error('Pairing did not save a connection.');
    platform = connectPlatform(state.connection, () => {
      if (status === 'ready' && (!codex?.alive() || !state.credentials || state.credentials.expires_at <= Date.now())) return 'error';
      return status;
    }, () => {
      console.error('Space rejected this connector credential. Create a new pairing code and run with --pair.');
      process.exitCode = 1;
      stop();
    }, async (request, emit, signal) => {
      if (status !== 'ready' || !codex?.alive()) throw new Error('Codex is not ready.');
      await codex.invoke(request, emit, signal);
    });
    async function activate(credentials: Credentials) {
      if (controller.signal.aborted) return;
      status = 'required';
      platform?.publish();
      codex?.stop();
      codex = await startCodex(credentials.access_token, () => {
        status = 'error';
        platform?.publish();
        console.error('Codex app-server stopped. Restart the connector to retry.');
      });
      if (controller.signal.aborted) { codex.stop(); return; }
      status = codex.alive() ? 'ready' : 'error';
      platform?.publish();
      if (status === 'ready') console.log('Connected: ChatGPT authorization and Codex initialization are ready.');
    }
    try {
      if (options.login || (paired && !state.credentials)) {
        const credentials = await authorize(state.host_id, state.registration, { signal: controller.signal });
        state.registration = { client_id: credentials.client_id, subject: credentials.subject, issuer: credentials.issuer };
        state.credentials = credentials;
        await store.save(state);
        await activate(credentials);
      } else if (state.credentials) {
        state.credentials = await refreshCredentials(state.credentials, { signal: controller.signal });
        await store.save(state);
        await activate(state.credentials);
      } else console.log('ChatGPT authorization is required. Stop the connector, then run it with --login.');
    } catch (error) {
      if (!controller.signal.aborted) {
        status = 'error';
        platform.publish();
        console.error(error instanceof Error ? error.message : 'Local ChatGPT authorization failed. Run with --login to retry.');
      }
    }
    let refreshing = false;
    renewal = setInterval(() => {
      if (refreshing || status !== 'ready' || !state.credentials || state.credentials.expires_at > Date.now() + 60_000) return;
      refreshing = true;
      renewalTask = (async () => {
        try {
          state.credentials = await refreshCredentials(state.credentials!, { signal: controller.signal });
          await store.save(state);
          await activate(state.credentials);
        } catch {
          status = 'error';
          codex?.stop();
          platform?.publish();
          if (!controller.signal.aborted) console.error('ChatGPT renewal failed. Restart the connector with --login.');
        } finally { refreshing = false; }
      })();
    }, 15_000);
    await finished;
  } finally {
    if (renewal) clearInterval(renewal);
    controller.abort();
    await renewalTask;
    codex?.stop();
    platform?.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await unlock();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runConnector().catch(error => {
    // Do not dump error objects/stacks from OAuth, sockets, or child processes.
    console.error(error instanceof Error ? error.message : 'Connector failed.');
    process.exitCode = 1;
  });
}
