#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { supportsModelSettings, parseLocalProvider, localProviders, type AgentModel, type LocalProvider } from '@space/contracts';
import { resolveProject } from './project-tools.js';
import type { AgentRuntime } from './agent-runtime.js';
import type { LoginCommand } from './native-login.js';
import { createProvider } from './provider-factory.js';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { ConnectorStore, platformOrigin } from './storage.js';
import { claimPairing, connectPlatform, type AuthStatus } from './runtime.js';

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
  login(command: LoginCommand, signal: AbortSignal): Promise<void>;
}

export async function runConnector(args = process.argv.slice(2), host?: ConnectorHost) {
  const options = parseOptions(args);
  if (options.help) {
    console.log('Space Connector\n\n  --provider <' + Object.keys(localProviders).join('|') + '>     Select the local agent (default: codex)\n  --url <origin> --pair <code>  Pair this computer with Space\n  --project <absolute-path>   Enable file tools within this project folder\n  --coding                    Enable native coding tools with owner approvals (requires --project)\n  --connect                   Prompt for a new pairing code\n  --login                     Sign in to the selected provider\n  --logout                    Sign out of the selected provider\n\nRun without arguments to reconnect. Pairing codes are prompted when omitted.\nKeep this terminal running. The selected provider CLI must be installed on PATH. Kiro requires ACP v3. Claude opens its native local login flow.');
    return;
  }
  const project = await resolveProject(options.project);
  const provider = parseLocalProvider(options.provider);
  const store = new ConnectorStore(host?.directory ?? connectorDirectory(provider));
  const unlock = await store.lock();
  const controller = new AbortController();
  let runtime: AgentRuntime | undefined;
  let models: AgentModel[] | undefined;
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
    const createSession = () => createProvider(provider, {
      store, state, signal: controller.signal, announce: host?.announce, login: host?.login,
      storage: state.connection && {directory:store.directory, connection:state.connection, project, coding:options.coding},
      publish: () => platform?.publish(),
      async activate(start, readyMessage) {
        if (controller.signal.aborted) return;
        status = 'required';
        platform?.publish();
        runtime?.stop();
        runtime = await start(() => {
          status = 'error';
          platform?.publish();
          console.error(`${localProviders[provider].name} stopped. Restart the connector to retry.`);
        });
        if (controller.signal.aborted) { runtime.stop(); return; }
        models = await runtime.listModels?.().catch(() => {
          console.warn(`${localProviders[provider].name} model discovery failed. Using provider defaults.`);
          return [];
        });
        status = runtime.alive() ? 'ready' : 'error';
        platform?.publish();
        if (status === 'ready') console.log(readyMessage);
      },
    });
    if (options.logout) { await createSession().logout(); return; }
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
    const session = createSession();
    const currentStatus = (): AuthStatus => {
      if (status === 'ready' && (!runtime?.alive() || (session.renewal && (session.renewal.expiresAt() ?? 0) <= Date.now()))) return 'error';
      return status;
    };
    platform = connectPlatform(state.connection, currentStatus, () => {
      host?.revoked();
      console.error('Space rejected this connector credential. Create a new pairing code and run with --pair.');
      process.exitCode = 1;
      stop();
    }, async (request, emit, signal, controls) => {
      if (currentStatus() !== 'ready' || !runtime?.alive()) throw new Error('The agent is not ready.');
      // The provider may have changed since a queued turn was admitted.
      if (models && request.codex_settings && !supportsModelSettings(models,request.codex_settings)) {
        for (const [index,type] of (['execution.started','execution.failed'] as const).entries()) {
          signal.throwIfAborted();
          await emit({id:randomUUID(),schema_version:request.schema_version,execution_id:request.execution_id,sequence:index+1,
            type,occurred_at:new Date().toISOString(),payload:{text:type === 'execution.started' ? 'Checking model selection.' : 'The selected model or reasoning effort is no longer available. Choose another and send again.'}});
        }
        return;
      }
      await runtime.invoke(request, emit, signal, controls);
    }, () => models);
    try {
      await session.start({paired, login:options.login, desktop:Boolean(host)});
    } catch (error) {
      if (!controller.signal.aborted) {
        status = 'error';
        platform.publish();
        if (host) throw error;
        console.error(error instanceof Error ? error.message : 'Provider authorization failed. Run with --login to retry.');
      }
    }
    let refreshing = false;
    const scheduleRenewal = () => {
      const refresh = session.renewal;
      const expiresAt = refresh?.expiresAt();
      if (!refresh || expiresAt === undefined || status !== 'ready' || controller.signal.aborted) return;
      renewal = setTimeout(() => {
        if (refreshing || status !== 'ready' || controller.signal.aborted) return;
        refreshing = true;
        renewalTask = (async () => {
          try {
            await refresh.refresh();
          } catch (error) {
            status = 'error';
            runtime?.stop();
            platform?.publish();
            if (!controller.signal.aborted) console.error(error instanceof Error ? error.message : 'Provider renewal failed. Restart the connector to retry.');
          } finally { refreshing = false; scheduleRenewal(); }
        })();
      }, credentialRenewalDelay(expiresAt));
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
