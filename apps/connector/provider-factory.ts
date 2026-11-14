import { type LocalProvider, localProviders } from '@space/contracts';
import type { AgentRuntime } from './agent-runtime.js';
import { claudeIdentity, claudeLogin, claudeLoginCommand } from './claude-auth.js';
import { kiroIdentity, kiroLogin, kiroLoginCommand } from './kiro-auth.js';
import { startKiro } from './kiro.js';
import { startCodex } from './codex.js';
import { authorize, refreshCredentials, revokeCredentials } from './oauth.js';
import type { LoginCommand } from './native-login.js';
import type { LocalSessionStorage } from './session-storage.js';
import type { ConnectorStore, Credentials, LocalState } from './storage.js';

type RuntimeStorage = Omit<LocalSessionStorage, 'identity'>;
type StartRuntime = (onExit: () => void) => Promise<AgentRuntime>;

interface ProviderContext {
  store: ConnectorStore;
  state: LocalState;
  signal: AbortSignal;
  storage?: RuntimeStorage;
  announce?: (url: string) => Promise<void>;
  login?: (command: LoginCommand, signal: AbortSignal) => Promise<void>;
  publish(): void;
  activate(start: StartRuntime, readyMessage: string): Promise<void>;
}
interface Startup { paired: boolean; login: boolean; desktop: boolean }
interface ProviderSession {
  start(options: Startup): Promise<void>;
  logout(): Promise<void>;
  renewal?: { expiresAt(): number | undefined; refresh(): Promise<void> };
}

type ProviderFactory = (context: ProviderContext) => ProviderSession;

function nativeProvider<Auth>(provider: LocalProvider, adapter: {
  identity(directory: string, signal: AbortSignal): Promise<Auth>;
  login(directory: string, signal: AbortSignal, logout?: boolean): Promise<void>;
  loginCommand(directory: string): Promise<LoginCommand>;
  start(auth: Auth, storage: RuntimeStorage, onExit: () => void): Promise<AgentRuntime>;
  ready: string;
}): ProviderFactory {
  return ({ store, signal, storage, activate, login }) => {
    const signIn = async () => {
      if (login) await login(await adapter.loginCommand(store.directory), signal);
      else await adapter.login(store.directory, signal);
    };
    return {
      async start(options) {
        if (!storage) throw new Error('Pair the connector before starting the provider.');
        if (options.login) await signIn();
        let auth: Auth;
        try { auth = await adapter.identity(store.directory, signal); }
        catch (error) {
          if (!(options.paired || options.desktop) || options.login || signal.aborted) throw error;
          await signIn();
          auth = await adapter.identity(store.directory, signal);
        }
        if (!signal.aborted) await activate(done => adapter.start(auth, storage, done), adapter.ready);
      },
      async logout() {
        await adapter.login(store.directory, signal, true);
        console.log(`Signed out of ${localProviders[provider].name} for Space on this computer.`);
      },
    };
  };
}

const codexProvider: ProviderFactory = ({ store, state, storage, signal, announce, publish, activate }) => {
  async function saveAndStart(credentials: Credentials) {
    state.credentials = credentials;
    await store.save(state);
    if (!storage) throw new Error('Pair the connector before starting Codex.');
    if (!signal.aborted) await activate(done => startCodex(credentials.access_token, done, undefined,
      { ...storage, identity: credentials }), 'ChatGPT authorization and Codex initialization are ready.');
  }
  async function refresh() {
    if (!state.credentials) throw new Error('ChatGPT sign-in is required.');
    await saveAndStart(await refreshCredentials(state.credentials, {signal, onRetry(reason, delay) {
      console.error(`${reason} Retrying in ${delay / 1000}s.`); publish();
    }}));
  }
  return {
    async start({ login, paired, desktop }) {
      if (login || (desktop && paired) || ((paired || desktop) && !state.credentials)) {
        const credentials = await authorize(state.host_id, state.registration, {signal, announce});
        state.registration = { client_id: credentials.client_id, subject: credentials.subject, issuer: credentials.issuer };
        await saveAndStart(credentials);
      } else if (state.credentials) await refresh();
      else console.log('ChatGPT authorization is required. Stop the connector, then run it with --login.');
    },
    async logout() {
      if (!state.credentials) { console.log('No local ChatGPT tokens are saved.'); return; }
      const revoked = await revokeCredentials(state.credentials);
      delete state.credentials;
      await store.save(state);
      console.log(revoked ? 'Signed out of ChatGPT on this computer.' : 'Local ChatGPT tokens removed. Remote revocation was not confirmed; disconnect the app in ChatGPT Settings.');
    },
    renewal: { expiresAt: () => state.credentials?.expires_at, refresh },
  };
};

const factories: Record<LocalProvider, ProviderFactory> = {
  codex: codexProvider,
  kiro: nativeProvider('kiro', {
    identity: kiroIdentity, login: kiroLogin,
    loginCommand: kiroLoginCommand,
    start: (identity, storage, done) => startKiro({ ...storage, identity }, done),
    ready: 'Kiro authorization and chat mode are ready.',
  }),
  claude: nativeProvider('claude', {
    identity: claudeIdentity, login: claudeLogin,
    loginCommand: claudeLoginCommand,
    async start(auth, storage, done) {
      const { startClaude } = await import('./claude.js');
      return startClaude(auth, storage, done);
    },
    ready: 'Claude local sign-in and runtime are ready.',
  }),
};

export function createProvider(provider: LocalProvider, context: ProviderContext): ProviderSession {
  return factories[provider](context);
}
