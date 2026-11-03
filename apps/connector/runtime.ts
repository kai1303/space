import { createHash, randomBytes } from 'node:crypto';
import { spawn, type SpawnOptionsWithoutStdio, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { io } from 'socket.io-client';
import { ConnectorStore, platformOrigin, type Connection } from './storage.js';

export type AuthStatus = 'required' | 'ready' | 'error';
export type SpawnCodex = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
export async function startCodex(accessToken: string, onExit: () => void, launch: SpawnCodex = spawn): Promise<{ stop(): void; alive(): boolean }> {
  const config = [
    'model_provider="openai_chatgpt_plan"',
    'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
    'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
    'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
    'model_providers.openai_chatgpt_plan.wire_api="responses"',
    'model_providers.openai_chatgpt_plan.requires_openai_auth=false',
    'model_providers.openai_chatgpt_plan.supports_websockets=false',
  ];
  const child = launch('codex', ['app-server', '--listen', 'stdio://', ...config.flatMap(value => ['-c', value])], { env: { ...process.env, ACCESS_TOKEN: accessToken }, stdio: 'pipe' });
  let live = true;
  let stopped = false;
  let ready = false;
  let buffer = '';
  const stop = () => { stopped = true; live = false; child.kill(); };
  child.stderr.resume(); // Do not forward child diagnostics, which may contain credentials.
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { stop(); reject(new Error('Codex initialize timed out. Check the installed Codex CLI.')); }, 15_000);
    const failed = () => {
      live = false;
      clearTimeout(timeout);
      if (!ready) reject(new Error('Could not initialize Codex app-server. Install or update the Codex CLI, then restart the connector.'));
      else if (!stopped) onExit();
    };
    child.once('error', failed);
    child.once('exit', failed);
    child.stdin.on('error', failed);
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 1_000_000) { stop(); failed(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: { id?: unknown; error?: unknown; result?: unknown };
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== 1 || ready) continue;
        if (message.error || !message.result || typeof message.result !== 'object') { stop(); failed(); return; }
        clearTimeout(timeout);
        ready = true;
        child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
        resolve();
      }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'space_connector', title: 'Space Connector', version: '0.0.1' }, capabilities: { experimentalApi: false } } })}\n`);
  });
  return { stop, alive: () => live };
}

export async function claimPairing(store: ConnectorStore, inputOrigin: string, code: string, request: typeof fetch = fetch): Promise<Connection> {
  const origin = platformOrigin(inputOrigin);
  if (!/^[A-Za-z0-9_-]{32}$/.test(code)) throw new Error('Pairing code must be the 32-character code shown by Space.');
  const state = await store.load();
  const code_hash = createHash('sha256').update(code).digest('hex');
  const credential = state.pending?.origin === origin && state.pending.code_hash === code_hash ? state.pending.credential : randomBytes(32).toString('base64url');
  state.pending = { origin, credential, code_hash };
  await store.save(state);
  const response = await request(`${origin}/v1/agent-pairings/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, credential }), signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!response.ok) throw new Error('Pairing failed. Check the code and URL, or create a new code in Space.');
  const result = await response.json() as { installation_id?: unknown; workspace_id?: unknown };
  if (typeof result.installation_id !== 'string' || !result.installation_id || typeof result.workspace_id !== 'string' || !result.workspace_id) throw new Error('The platform returned an invalid pairing response.');
  const connection: Connection = { origin, credential, installation_id: result.installation_id, workspace_id: result.workspace_id };
  state.connection = connection;
  delete state.pending;
  await store.save(state);
  return connection;
}

function unauthorized(error: unknown): boolean {
  if (typeof error === 'string') return /unauthorized|unauthenticated|revoked|invalid.token/i.test(error);
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; message?: unknown; data?: { code?: unknown } };
  return [value.code, value.data?.code, value.message].some(item => typeof item === 'string' && /unauthorized|unauthenticated|revoked|invalid.token/i.test(item));
}
export function connectPlatform(connection: Connection, status: () => AuthStatus, onUnauthorized: () => void) {
  const socket = io(`${platformOrigin(connection.origin)}/agents`, {
    transports: ['websocket'], auth: { token: connection.credential },
    reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1_000,
    reconnectionDelayMax: 30_000, randomizationFactor: 0.5, timeout: 15_000,
  });
  let closed = false;
  let reconnect: NodeJS.Timeout | undefined;
  let reconnectDelay = 1_000;
  const close = () => { closed = true; clearInterval(heartbeat); clearTimeout(reconnect); socket.disconnect(); };
  const rejected = () => { if (!closed) { close(); onUnauthorized(); } };
  const publish = () => {
    if (!socket.connected || closed) return;
    socket.timeout(8_000).emit('agent.heartbeat', { auth_status: status() }, (error: Error | null, ack?: { data?: { installation_id?: string }; error?: unknown }) => {
      if (error) return;
      if (ack?.error && unauthorized(ack.error)) rejected();
      if (ack?.data?.installation_id && ack.data.installation_id !== connection.installation_id) rejected();
    });
  };
  const heartbeat = setInterval(publish, 10_000);
  socket.on('connect', () => { reconnectDelay = 1_000; publish(); });
  socket.on('disconnect', reason => {
    // A graceful API restart also disconnects the namespace; recheck credentials on reconnect.
    if (reason !== 'io server disconnect' || closed) return;
    clearTimeout(reconnect);
    reconnect = setTimeout(() => { if (!closed) socket.connect(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  });
  socket.on('connect_error', error => { if (unauthorized(error)) rejected(); });
  return { close, publish };
}
