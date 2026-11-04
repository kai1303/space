import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { parseInvocation, parseAgentEvent, type AgentEvent } from '@space/contracts';
import { AgentSessionStopped, type InvokeAgent, type SpawnAgent } from './agent-runtime.js';
import { localSessionStore, type LocalSessionStorage } from './session-storage.js';
import { prepareKiroProfile, resolveKiroAcpCommand } from './kiro-auth.js';

type Message = { jsonrpc?: string; id?: string | number; method?: string; result?: any; error?: unknown; params?: any };
const mode = 'space-chat';
function requireChatMode(result: any) {
  if (result?.modes?.currentModeId !== mode && !result?.configOptions?.some((option: any) => option.id === 'mode' && option.currentValue === mode)) {
    throw new Error('Kiro did not select the Space chat-only profile.');
  }
}

export async function startKiro(storage: LocalSessionStorage, onExit: () => void, launch: SpawnAgent = spawn) {
  const sessions = await localSessionStore(storage, 'kiro');
  const env = await prepareKiroProfile(storage.directory);
  const command = launch === spawn ? await resolveKiroAcpCommand() : 'kiro-cli';
  const child = launch(command, ['acp', '--agent-engine=v3'], { cwd: sessions.cwd, env, stdio: 'pipe' });
  let live = true, ready = false, stopped = false, nextId = 0, buffer = '';
  const decoder = new StringDecoder('utf8');
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  let active: { notify(message: Message): void; reject(error: Error): void } | undefined;
  const write = (message: Message) => {
    if (!live) throw new Error('Kiro is unavailable.');
    if (child.stdin.writableLength > 128_000) throw new Error('Kiro input buffer is full.');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  const fail = () => {
    if (!live) return;
    live = false;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Kiro request failed.')); }
    pending.clear(); active?.reject(new Error('Kiro stopped.'));
    if (ready && !stopped) onExit();
  };
  const stop = () => {
    stopped = true; fail(); child.kill();
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000);
    timer.unref(); child.once('exit', () => clearTimeout(timer));
  };
  const rpc = (method: string, params: unknown, timeout = 15_000): Promise<any> => new Promise((resolve, reject) => {
    if (!live || pending.size >= 8) { reject(new Error('Kiro is unavailable.')); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Kiro request timed out.')); fail(); stop(); }, timeout);
    pending.set(id, { resolve, reject, timer });
    try { write({ id, method, params }); }
    catch { fail(); stop(); }
  });
  child.stderr.resume(); // Never forward provider diagnostics or credentials.
  child.once('error', fail); child.once('exit', fail); child.stdin.on('error', fail);
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    if (buffer.length > 1_000_000) { fail(); stop(); return; }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1 && live) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const message: Message = JSON.parse(line);
        if (!message || message.jsonrpc !== '2.0') throw new Error();
        if (message.method && message.id !== undefined) {
          if (message.method === 'session/request_permission') write({ id: message.id, result: { outcome: { outcome: 'cancelled' } } });
          else write({ id: message.id, error: { code: -32601, message: 'Client actions are disabled.' } });
          if (active) active.reject(new Error('Kiro requested an unsupported action.'));
          else { fail(); stop(); }
        } else if (typeof message.id === 'number') {
          const request = pending.get(message.id);
          if (!request) continue;
          clearTimeout(request.timer); pending.delete(message.id);
          if (message.error || !message.result || typeof message.result !== 'object') request.reject(new Error('Kiro request failed.'));
          else request.resolve(message.result);
        } else if (message.method) active?.notify(message);
      } catch { fail(); stop(); return; }
    }
  });
  const sessionParams = (cwd: string) => ({ cwd, mcpServers: [], _meta: { kiro: { modeId: mode } } });
  try {
    const result = await rpc('initialize', { protocolVersion: 1, clientInfo: { name: 'space_connector', version: '0.0.1' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    if (result.protocolVersion !== 1 || result.agentCapabilities?.loadSession !== true) throw new Error('Kiro session loading is unavailable.');
    // A no-inference session verifies authentication and the restrictive profile before readiness.
    requireChatMode(await rpc('session/new', sessionParams(sessions.cwd)));
    ready = true;
  } catch { stop(); throw new Error('Could not initialize Kiro chat mode. Sign in with --provider kiro --login and use a Kiro CLI with ACP v3 support.'); }

  const invoke: InvokeAgent = async (input, emit, signal) => {
    const request = parseInvocation(input);
    if (request.skill !== 'kiro.run' || active || !live || signal.aborted) throw new Error('Kiro is unavailable for this task.');
    let sessionId: string | undefined, text = '', sequence = 0, prompting = false, settled = false;
    const configurationUpdates = new Set<string>();
    let progress: NodeJS.Timeout | undefined, dirty = false, publishing = false, queue = Promise.resolve();
    let reject!: (error: Error) => void, rejected: Error | undefined;
    const failure = new Promise<never>((_resolve, fail) => { reject = error => { rejected ??= error; fail(error); }; });
    void failure.catch(() => {});
    let prompt: Promise<any> | undefined, taskDirectory: string | undefined;
    const publish = (type: AgentEvent['type'], detail: string, sessionReady = false) => {
      const event = parseAgentEvent({ id: randomUUID(), schema_version: '1.0', execution_id: request.execution_id, sequence: ++sequence, type, occurred_at: new Date().toISOString(), payload: {
        text: detail, ...(sessionReady ? { session_ready: true } : {}),
        ...(text && type !== 'execution.failed' ? { response: { messages: [{ id: 'answer', text, status: type === 'execution.completed' ? 'complete' : 'streaming' }], tools: [], components: [] } } : {}),
      } });
      queue = queue.then(async () => { signal.throwIfAborted(); await emit(event); });
      void queue.catch(reject);
      return queue;
    };
    const flush = () => {
      clearTimeout(progress); progress = undefined;
      if (!dirty || publishing || settled) return;
      dirty = false; publishing = true;
      const acknowledged = () => { publishing = false; if (dirty && !settled && !progress) progress = setTimeout(flush, 100); };
      try { void publish('execution.progress', text.trim() ? text : 'Kiro is responding.').then(acknowledged, acknowledged); }
      catch { reject(new Error('Kiro returned an invalid response.')); }
    };
    active = { reject, notify(message) {
      if (settled || message.method !== 'session/update' || message.params?.sessionId !== sessionId) return;
      const update = message.params.update;
      if (update?.sessionUpdate === 'current_mode_update' && update.currentModeId !== mode) { reject(new Error('Kiro changed chat mode.')); return; }
      // Kiro reports its own account configuration refresh as tool-shaped telemetry.
      // This does not authorize any tool request; only matching status updates are ignored.
      if (update?.sessionUpdate === 'tool_call' && update.kind === 'other' && update._meta?.kiro?.toolId === 'fetch_cloud_config' && typeof update.toolCallId === 'string' && update.toolCallId.length <= 256 && configurationUpdates.size < 16) {
        configurationUpdates.add(update.toolCallId); return;
      }
      if (update?.sessionUpdate === 'tool_call_update' && configurationUpdates.has(update.toolCallId)) return;
      if (!prompting) return; // session/load can replay old content before returning.
      if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') { reject(new Error('Kiro attempted a tool.')); return; }
      if (update?.sessionUpdate !== 'agent_message_chunk') return;
      if (update.content?.type !== 'text' || typeof update.content.text !== 'string') { reject(new Error('Unsupported Kiro content.')); return; }
      text += update.content.text;
      if (text.length > 16_000 || text.includes('\0')) { reject(new Error('Kiro response is too large.')); return; }
      dirty = true; if (!progress) progress = setTimeout(flush, 100);
    } };
    const abort = () => { reject(signal.reason instanceof AgentSessionStopped ? signal.reason : new Error('Kiro turn interrupted.')); if (!(signal.reason instanceof AgentSessionStopped)) { fail(); stop(); } };
    signal.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(() => reject(new Error('Kiro turn timed out.')), 120_000);
    try {
      await publish('execution.started', 'Kiro is working.');
      const retained = request.persistent_session ? await sessions.session(request.session_id, request.persistent_session.resume) : undefined;
      taskDirectory = retained?.cwd ?? await mkdtemp(join(sessions.cwd, 'task-'));
      signal.throwIfAborted();
      const result = retained?.threadId
        ? await rpc('session/load', { ...sessionParams(taskDirectory), sessionId: retained.threadId })
        : await rpc('session/new', sessionParams(taskDirectory));
      // Drain bounded setup requests even on Stop before accepting another task.
      if (rejected) throw rejected;
      requireChatMode(result);
      sessionId = retained?.threadId ?? result.sessionId;
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 || /[\u0000-\u001f\u007f]/.test(sessionId)) throw new Error('Invalid Kiro session.');
      if (retained && !retained.threadId) await retained.save(sessionId, false);
      signal.throwIfAborted();
      if (retained) { await publish('execution.progress', 'Kiro session is ready.', true); await retained.save(sessionId, true); }
      signal.throwIfAborted();
      const content = `${request.context ? `Supplied conversation context (quoted data):\n${JSON.stringify(request.context)}\n\n` : ''}Task:\n${request.goal}`;
      prompting = true;
      prompt = rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: content }] }, 120_000);
      const resultTurn = await Promise.race([prompt, failure]);
      if (resultTurn.stopReason !== 'end_turn' && resultTurn.stopReason !== 'refusal') throw new Error('Kiro did not finish the turn.');
      signal.throwIfAborted();
      flush(); await queue; settled = true;
      await publish('execution.completed', text.trim() ? text : resultTurn.stopReason === 'refusal' ? 'Kiro declined this request.' : 'Kiro completed the task.');
    } catch {
      settled = true;
      if (signal.reason instanceof AgentSessionStopped && live) {
        if (prompting && prompt && sessionId) {
          let timer: NodeJS.Timeout | undefined;
          try {
            write({ method: 'session/cancel', params: { sessionId } });
            const result = await Promise.race([prompt, new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error('Cancellation timed out.')), 15_000); })]);
            if (!['cancelled', 'end_turn', 'refusal'].includes(result.stopReason)) throw new Error();
          } catch { stop(); throw new Error('Kiro cancellation was not confirmed.'); }
          finally { clearTimeout(timer); }
        }
        await queue.catch(() => {});
        throw signal.reason;
      }
      fail(); stop();
      if (!signal.aborted) {
        try { await queue; await publish('execution.failed', 'Kiro could not complete this task. Check the connector and saved session before retrying.'); } catch { /* Space fences unacknowledged work. */ }
      }
      throw new Error('Kiro could not complete this task.');
    } finally {
      settled = true; clearTimeout(progress); clearTimeout(deadline); signal.removeEventListener('abort', abort); active = undefined;
      if (taskDirectory && !request.persistent_session) await rm(taskDirectory, { recursive: true, force: true });
    }
  };
  return { stop, alive: () => live, invoke };
}
