import { createHash, randomBytes } from 'node:crypto';
import { io } from 'socket.io-client';
import { parseInvocation, parseAgentEvent, type AgentEvent } from '@space/contracts';
import type { InvokeCodex } from './codex.js';
import { ConnectorStore, platformOrigin, type Connection } from './storage.js';

export type AuthStatus = 'required' | 'ready' | 'error';
export { startCodex, type SpawnCodex, type InvokeCodex } from './codex.js';

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
export function connectPlatform(connection: Connection, status: () => AuthStatus, onUnauthorized: () => void, invoke?: InvokeCodex) {
  const socket = io(`${platformOrigin(connection.origin)}/agents`, {
    transports: ['websocket'], auth: { token: connection.credential },
    reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1_000,
    reconnectionDelayMax: 30_000, randomizationFactor: 0.5, timeout: 15_000,
  });
  let closed = false;
  let reconnect: NodeJS.Timeout | undefined;
  let reconnectDelay = 1_000;
  let claiming = false, halted = false, readyToClaim = false;
  let generation = 0, heartbeatRevision = 0;
  let active: AbortController | undefined;
  const seen = new Set<string>();
  let operations = Promise.resolve();
  const taskRpc = (name: string, payload: unknown, shouldSend = () => true): Promise<unknown> => {
    const operation = operations.then(() => new Promise<unknown>((resolve, reject) => {
      if (!shouldSend()) { resolve(true); return; }
      if (closed || !socket.connected) { reject(new Error('Space disconnected.')); return; }
      socket.timeout(8_000).emit(name, payload, (error: Error | null, ack?: { data?: unknown; error?: unknown }) => {
        if (error || ack?.error || !ack || !('data' in ack)) {
          if (ack?.error && unauthorized(ack.error)) rejected();
          reject(new Error(name === 'agent.task.claim' && ack?.error === 'agent_not_ready' ? 'agent_not_ready' : 'Space did not acknowledge this task operation.'));
        } else resolve(ack.data);
      });
    }));
    operations = operation.then(() => {}, () => {});
    return operation;
  };
  const accepted = async (name: string, payload: unknown = {}, shouldSend = () => true) => {
    if (await taskRpc(name, payload, shouldSend) !== true) throw new Error('Space rejected the task operation.');
  };
  const failTask = async () => {
    try { if (socket.connected && !closed) await accepted('agent.task.fail'); } catch { /* Server lease expiry handles a lost connection. */ }
  };
  const claim = async () => {
    if (status() !== 'ready') { readyToClaim = false; return; }
    if (!invoke || closed || halted || claiming || active || !socket.connected || !readyToClaim) return;
    claiming = true;
    let renewal: NodeJS.Timeout | undefined, deadline: NodeJS.Timeout | undefined;
    let terminal = false, terminalSubmitted = false;
    try {
      const data = await taskRpc('agent.task.claim', {});
      if (data === null) return;
      const request = parseInvocation(data);
      if (seen.has(request.execution_id)) throw new Error('Space returned an uncertain execution.');
      seen.add(request.execution_id);
      const controller = new AbortController();
      active = controller;
      if (closed || halted || !socket.connected) { controller.abort(); throw new Error('Space disconnected.'); }
      let renewing = false, lastSequence = 0;
      deadline = setTimeout(() => controller.abort(), 120_000);
      renewal = setInterval(() => {
        if (renewing || controller.signal.aborted || terminalSubmitted) return;
        renewing = true;
        void accepted('agent.task.renew', {}, () => !terminalSubmitted && !controller.signal.aborted).catch(() => { halted = true; controller.abort(); }).finally(() => { renewing = false; });
      }, 5_000);
      await invoke(request, async (value: AgentEvent) => {
        controller.signal.throwIfAborted();
        const event = parseAgentEvent(value);
        if (terminal || event.execution_id !== request.execution_id || event.sequence !== lastSequence + 1) throw new Error('Invalid Codex event sequence.');
        if (event.type === 'execution.completed' || event.type === 'execution.failed') {
          terminalSubmitted = true;
          clearInterval(renewal);
        }
        await accepted('agent.task.event', { event });
        lastSequence = event.sequence;
        terminal = event.type === 'execution.completed' || event.type === 'execution.failed';
      }, controller.signal);
      controller.signal.throwIfAborted();
      if (!terminal) throw new Error('Codex did not send a terminal event.');
      clearInterval(renewal);
      await accepted('agent.task.finish');
    } catch (error) {
      if (!active && error instanceof Error && error.message === 'agent_not_ready' && socket.connected && !closed) {
        readyToClaim = false;
        publish();
        return;
      }
      if (terminal && !active?.signal.aborted && socket.connected && !closed) {
        clearInterval(renewal);
        try { await accepted('agent.task.finish'); return; } catch { /* Finish is uncertain; stop below. */ }
      }
      // An unacknowledged claim or event is uncertain: never automatically rerun it.
      halted = true;
      active?.abort();
      await failTask();
    } finally {
      clearInterval(renewal); clearTimeout(deadline); active = undefined; claiming = false;
      if (halted) publish();
    }
  };
  const tasks = setInterval(() => { void claim(); }, 1_000);
  const close = () => { closed = true; active?.abort(); clearInterval(tasks); clearInterval(heartbeat); clearTimeout(reconnect); socket.disconnect(); };
  const rejected = () => { if (!closed) { close(); onUnauthorized(); } };
  const publish = () => {
    if (!socket.connected || closed) return;
    readyToClaim = false;
    const authStatus = halted ? 'error' : status();
    const revision = ++heartbeatRevision, currentGeneration = generation;
    socket.timeout(8_000).emit('agent.heartbeat', { auth_status: authStatus }, (error: Error | null, ack?: { data?: { installation_id?: string }; error?: unknown }) => {
      if (closed || currentGeneration !== generation || revision !== heartbeatRevision || error) return;
      if (ack?.error && unauthorized(ack.error)) { rejected(); return; }
      if (ack?.data?.installation_id && ack.data.installation_id !== connection.installation_id) { rejected(); return; }
      if (!ack?.error && ack?.data?.installation_id === connection.installation_id && authStatus === 'ready' && status() === 'ready' && !halted) {
        readyToClaim = true;
        void claim();
      }
    });
  };
  const heartbeat = setInterval(publish, 10_000);
  socket.on('connect', () => { generation++; readyToClaim = false; reconnectDelay = 1_000; publish(); });
  socket.on('disconnect', reason => {
    generation++; readyToClaim = false;
    if (active || claiming) { halted = true; active?.abort(); }
    // A graceful API restart also disconnects the namespace; recheck credentials on reconnect.
    if (reason !== 'io server disconnect' || closed) return;
    clearTimeout(reconnect);
    reconnect = setTimeout(() => { if (!closed) socket.connect(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  });
  socket.on('connect_error', error => { if (unauthorized(error)) rejected(); });
  return { close, publish };
}
