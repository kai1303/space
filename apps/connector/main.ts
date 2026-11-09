#!/usr/bin/env node
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseLocalProvider, type LocalProvider } from '@space/contracts';
import { resolveProject } from './project-tools.js';
import type { AgentRuntime } from './agent-runtime.js';
import { startKiro } from './kiro.js';
import { claudeIdentity, claudeLogin } from './claude-auth.js';
import { kiroIdentity, kiroLogin } from './kiro-auth.js';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { ConnectorStore, platformOrigin, type Credentials } from './storage.js';
import { authorize, refreshCredentials, revokeCredentials } from './oauth.js';
import { claimPairing, connectPlatform, startCodex, type AuthStatus } from './runtime.js';

export function parseOptions(args: string[]) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    coding: { type: 'boolean', default: false }, provider: { type: 'string' }, project: { type: 'string' }, connect: { type: 'boolean', default: false }, url: { type: 'string' }, pair: { type: 'string' }, login: { type: 'boolean', default: false },
    logout: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (values.logout && (values.login || values.pair || values.url || values.connect || values.project || values.coding)) throw new Error('Use --logout by itself.');
  if (values.pair !== undefined && !/^[A-Za-z0-9_-]{32}$/.test(values.pair)) throw new Error('Use the 32-character pairing code from Space.');
  if (values.coding && (!values.project || !isAbsolute(values.project))) throw new Error('--coding requires an absolute --project folder path.');
  const provider = values.provider === undefined ? undefined : parseLocalProvider(values.provider);
  return { ...(values.coding ? { coding: true } : {}), ...(provider ? { provider } : {}), ...(values.project ? { project: values.project } : {}), url: values.url ? platformOrigin(values.url) : undefined, pair: values.pair, login: values.login, logout: values.logout, help: values.help, connect: values.connect };
}

export function connectorDirectory(provider: LocalProvider) {
  return join(homedir(), '.config', provider === 'codex' ? 'space-connector' : `space-connector-${provider}`);
}

export function credentialRenewalDelay(expiresAt: number, now = Date.now()) {
  const remaining = expiresAt - now;
  return Math.max(1000, remaining > 60_000 ? remaining - 60_000 : Math.floor(remaining * 0.8));
}

interface ConnectorHost {
  directory: string;
  paired(): void;
  revoked(): void;
  announce(url: string): Promise<void>;
  login(provider: 'kiro' | 'claude', directory: string, signal: AbortSignal): Promise<void>;
}

export async function runConnector(args = process.argv.slice(2), host?: ConnectorHost) {
  const options = parseOptions(args);
  if (options.help) {
    console.log('Space Connector\n\n  --provider <codex|kiro|claude>     Select the local agent (default: codex)\n  --url <origin> --pair <code>  Pair this computer with Space\n  --project <absolute-path>   Enable file tools within this project folder\n  --coding                    Enable native coding tools with owner approvals (requires --project)\n  --connect                   Prompt for a new pairing code\n  --login                     Sign in to the selected provider\n  --logout                    Sign out of the selected provider\n\nRun without arguments to reconnect. Pairing codes are prompted when omitted.\nKeep this terminal running. The selected provider CLI must be installed on PATH. Kiro requires ACP v3. Claude opens its native local login flow.');
    return;
  }
  const project = await resolveProject(options.project);
  const provider = parseLocalProvider(options.provider);
  const store = new ConnectorStore(host?.directory ?? connectorDirectory(provider));
  const unlock = await store.lock();
  const controller = new AbortController();
  let runtime: AgentRuntime | undefined;
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
      if (provider === 'claude') { await claudeLogin(store.directory, controller.signal, true); console.log('Signed out of Claude for Space on this computer.'); return; }
      if (provider === 'kiro') { await kiroLogin(store.directory, controller.signal, true); console.log('Signed out of Kiro for Space on this computer.'); return; }
      if (state.credentials) {
        const revoked = await revokeCredentials(state.credentials);
        delete state.credentials;
        await store.save(state);
        console.log(revoked ? 'Signed out of ChatGPT on this computer.' : 'Local ChatGPT tokens removed. Remote revocation was not confirmed; disconnect the app in ChatGPT Settings.');
      } else console.log('No local ChatGPT tokens are saved.');
      return;
    }
    if (project) console.log(`${options.coding ? 'Coding tools with owner approvals' : 'Project file tools'} enabled: ${project}`);
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
      await claimPairing(store, origin, code, undefined, provider);
      state = await store.load();
      paired = true;
      host?.paired();
      console.log('This computer is paired with Space. Provider credentials stay on this computer.');
    } else if (options.url && options.url !== state.connection.origin) {
      throw new Error('The saved connector uses a different platform. Provide a new --pair code to change it.');
    }
    if (!state.connection) throw new Error('Pairing did not save a connection.');
    if (parseLocalProvider(state.connection.provider) !== provider) throw new Error('The saved connection belongs to a different provider.');
    platform = connectPlatform(state.connection, () => {
      if (status === 'ready' && (!runtime?.alive() || (provider === 'codex' && (!state.credentials || state.credentials.expires_at <= Date.now())))) return 'error';
      return status;
    }, () => {
      host?.revoked();
      console.error('Space rejected this connector credential. Create a new pairing code and run with --pair.');
      process.exitCode = 1;
      stop();
    }, async (request, emit, signal, controls) => {
      if (status !== 'ready' || !runtime?.alive()) throw new Error('The agent is not ready.');
      await runtime.invoke(request, emit, signal, controls);
    });
    async function activate(credentials: Credentials) {
      if (controller.signal.aborted) return;
      status = 'required';
      platform?.publish();
      runtime?.stop();
      runtime = await startCodex(credentials.access_token, () => {
        status = 'error';
        platform?.publish();
        console.error('Codex app-server stopped. Restart the connector to retry.');
      }, undefined, { directory: store.directory, connection: state.connection!, identity: credentials, project, coding: options.coding });
      if (controller.signal.aborted) { runtime.stop(); return; }
      status = runtime.alive() ? 'ready' : 'error';
      platform?.publish();
      if (status === 'ready') console.log('ChatGPT authorization and Codex initialization are ready.');
    }
    const signIn = (agent: 'kiro' | 'claude') => host
      ? host.login(agent, store.directory, controller.signal)
      : (agent === 'kiro' ? kiroLogin : claudeLogin)(store.directory, controller.signal);
    try {
      if (provider === 'kiro') {
        if (options.login) await signIn('kiro');
        let identity;
        try { identity = await kiroIdentity(store.directory, controller.signal); }
        catch (error) {
          if ((!paired && !host) || options.login || controller.signal.aborted) throw error;
          console.log('Sign in to Kiro for Space. This uses separate local credentials.');
          await signIn('kiro');
          identity = await kiroIdentity(store.directory, controller.signal);
        }
        if (!controller.signal.aborted) {
          runtime = await startKiro({ directory: store.directory, connection: state.connection, identity, project, coding: options.coding }, () => {
            status = 'error'; platform?.publish(); console.error('Kiro stopped. Restart the connector to retry.');
          });
          if (controller.signal.aborted) runtime.stop();
          else { status = runtime.alive() ? 'ready' : 'error'; platform.publish(); console.log('Kiro authorization and chat mode are ready.'); }
        }
      } else if (provider === 'claude') {
        if (options.login) await signIn('claude');
        let auth;
        try { auth = await claudeIdentity(store.directory, controller.signal); }
        catch (error) {
          if ((!paired && !host) || options.login || controller.signal.aborted) throw error;
          console.log('Sign in to Claude for Space using Claude Code’s local login.');
          await signIn('claude');
          auth = await claudeIdentity(store.directory, controller.signal);
        }
        if (!controller.signal.aborted) {
          const { startClaude } = await import('./claude.js');
          runtime = await startClaude(auth, { directory: store.directory, connection: state.connection, project, coding: options.coding }, () => {
            status = 'error'; platform?.publish(); console.error('Claude stopped. Check your local sign-in and restart the connector.');
          });
          if (controller.signal.aborted) runtime.stop();
          else { status = 'ready'; platform.publish(); console.log('Claude local sign-in and runtime are ready.'); }
        }
      } else if (options.login || (host && paired) || ((paired || host) && !state.credentials)) {
        const credentials = await authorize(state.host_id, state.registration, { signal: controller.signal, announce: host?.announce });
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
        if (host) throw error;
        console.error(error instanceof Error ? error.message : 'Local ChatGPT authorization failed. Run with --login to retry.');
      }
    }
    let refreshing = false;
    const scheduleRenewal = () => {
      if (provider !== 'codex' || status !== 'ready' || !state.credentials || controller.signal.aborted) return;
      renewal = setTimeout(() => {
        if (refreshing || status !== 'ready' || !state.credentials || controller.signal.aborted) return;
        refreshing = true;
        renewalTask = (async () => {
          try {
            state.credentials = await refreshCredentials(state.credentials!, { signal: controller.signal });
            await store.save(state);
            await activate(state.credentials);
          } catch {
            status = 'error';
            runtime?.stop();
            platform?.publish();
            if (!controller.signal.aborted) console.error('ChatGPT renewal failed. Restart the connector with --login.');
          } finally { refreshing = false; scheduleRenewal(); }
        })();
      }, credentialRenewalDelay(state.credentials.expires_at));
    };
    scheduleRenewal();
    await finished;
  } finally {
    if (renewal) clearTimeout(renewal);
    controller.abort();
    await renewalTask;
    runtime?.stop();
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
