import { visibleText } from '@space/contracts';
import { memoryInstructions } from './memory-instructions.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { CODING_TURN_TIMEOUT_MS, parseInvocation, parseAgentEvent, type AgentEvent, type AgentText, type OutboundAccess } from '@space/contracts';
import { AgentSessionStopped, type InvokeAgent, type SpawnAgent } from './agent-runtime.js';
import { localSessionStore, type LocalSessionStorage } from './session-storage.js';
import { approveCoding, approveProject, contentPatch, kiroCodingTools } from './coding-tools.js';
import { AgentProgress } from './agent-progress.js';
import { projectServer, projectToolNames, resolveProject } from './project-tools.js';
import { prepareKiroProfile, resolveKiroAcpCommand } from './kiro-auth.js';
import { outboundServer, turnScopedRuntime } from './outbound-tools.js';

type Message = { jsonrpc?: string; id?: string | number; method?: string; result?: any; error?: unknown; params?: any };
function requireMode(result: any, mode: string) {
  if (result?.modes?.currentModeId !== mode && !result?.configOptions?.some((option: any) => option.id === 'mode' && option.currentValue === mode)) {
    throw new Error('Kiro did not select the requested Space profile.');
  }
}

async function startSingleKiro(storage: LocalSessionStorage, onExit: () => void, launch: SpawnAgent = spawn, outbound?: OutboundAccess, startupSignal?: AbortSignal) {
  const coding = storage.coding === true, mode = coding ? 'space-coding' : 'space-chat';
  const project = await resolveProject(storage.project);
  if (coding && !project) throw new Error('Coding requires --project.');
  storage = { ...storage, project };
  const sessions = await localSessionStore(storage, 'kiro');
  const env = await prepareKiroProfile(storage.directory, project, outbound, coding);
  const command = launch === spawn ? await resolveKiroAcpCommand() : 'kiro-cli';
  startupSignal?.throwIfAborted();
  const child = launch(command, ['acp', '--agent-engine=v3'], { cwd: coding ? project! : sessions.cwd, env, stdio: 'pipe' });
  let live = true, ready = false, stopped = false, nextId = 0, buffer = '';
  const decoder = new StringDecoder('utf8');
  const allowedTool = (server: string, name: string) => (Boolean(project) && server === projectServer && projectToolNames.includes(name)) || (server === outboundServer && Boolean(outbound?.tools.includes(name)));
  const requiredServers = [...(project && !coding ? [projectServer] : []), ...(outbound ? [outboundServer] : [])];
  const mcpStates = new Map<string, string>();
  const mcpWaiting = new Map<string, { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const waitForTools = async (id: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (!requiredServers.length || mcpStates.get(id) === 'connected') return;
    if (['failed', 'disabled'].includes(mcpStates.get(id) ?? '')) throw new Error('MCP tools are unavailable.');
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer); signal?.removeEventListener('abort', aborted); mcpWaiting.delete(id);
        if (error) reject(error); else resolve();
      };
      const aborted = () => finish(signal?.reason instanceof Error ? signal.reason : new Error('MCP tool setup was interrupted.'));
      const timer = setTimeout(() => finish(new Error('MCP tools did not become ready.')), 15_000);
      mcpWaiting.set(id, { resolve: () => finish(), reject: finish, timer });
      signal?.addEventListener('abort', aborted, { once: true });
    });
  };
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
    pending.clear();
    for (const waiter of mcpWaiting.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Kiro stopped before MCP tools were ready.')); }
    mcpWaiting.clear(); active?.reject(new Error('Kiro stopped.'));
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
          if (coding && active) { active.notify(message); continue; }
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
        } else if (requiredServers.length && message.method === '_kiro/mcp/status') {
          const id = message.params?.sessionId, servers = message.params?.servers;
          if (typeof id !== 'string' || id.length > 256 || !Array.isArray(servers) || servers.length > 100) throw new Error();
          const statuses = requiredServers.map(name => servers.find((item: any) => item.name === name)?.status);
          const status = statuses.every(value => value === 'connected') ? 'connected' : statuses.some(value => ['failed', 'disabled'].includes(value)) ? 'failed' : 'connecting';
          if (!mcpStates.has(id) && mcpStates.size >= 100) mcpStates.delete(mcpStates.keys().next().value!);
          mcpStates.set(id, status);
          const waiter = mcpWaiting.get(id);
          if (waiter && ['connected', 'failed'].includes(status)) {
            clearTimeout(waiter.timer); mcpWaiting.delete(id);
            if (status === 'connected') waiter.resolve(); else waiter.reject(new Error('MCP tools are unavailable.'));
          }
          active?.notify(message);
        } else if (message.method) active?.notify(message);
      } catch { fail(); stop(); return; }
    }
  });
  const sessionParams = (cwd: string) => ({ cwd, mcpServers: [], _meta: { kiro: { modeId: mode } } });
  const startupDeadline = setTimeout(stop, 15_000);
  startupSignal?.addEventListener('abort', stop, { once: true });
  try {
    startupSignal?.throwIfAborted();
    const result = await rpc('initialize', { protocolVersion: 1, clientInfo: { name: 'space_connector', version: '0.0.1' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    if (result.protocolVersion !== 1 || result.agentCapabilities?.loadSession !== true) throw new Error('Kiro session loading is unavailable.');
    // A no-inference session verifies authentication and the restrictive profile before readiness.
    const probe = await rpc('session/new', sessionParams(project ?? sessions.cwd));
    requireMode(probe, mode);
    if (requiredServers.length && (typeof probe.sessionId !== 'string' || !probe.sessionId || probe.sessionId.length > 256)) throw new Error('Invalid Kiro session.');
    await waitForTools(probe.sessionId);
    ready = true;
  } catch { stop(); throw new Error('Could not initialize Kiro chat mode. Sign in with --provider kiro --login and use a Kiro CLI with ACP v3 support.'); }
  finally { clearTimeout(startupDeadline); startupSignal?.removeEventListener('abort', stop); }

  const invoke: InvokeAgent = async (input, emit, signal, controls) => {
    const request = parseInvocation(input);
    if (request.skill !== 'kiro.run' || active || !live || signal.aborted) throw new Error('Kiro is unavailable for this task.');
    let sessionId: string | undefined, text = '', sequence = 0, prompting = false, settled = false;
    const configurationUpdates = new Set<string>();
    const output = new AgentProgress(coding);
    const messages: AgentText[] = [];
    let currentMessage: AgentText | undefined, messageCount = 0;
    let progress: NodeJS.Timeout | undefined, dirty = false, publishing = false, queue = Promise.resolve();
    const approvalLifetime = new AbortController(), approvals = new Set<string | number>();
    let reject!: (error: Error) => void, rejected: Error | undefined;
    const failure = new Promise<never>((_resolve, fail) => { reject = error => { rejected ??= error; approvalLifetime.abort(error); fail(error); }; });
    void failure.catch(() => {});
    let prompt: Promise<any> | undefined, taskDirectory: string | undefined;
    const publish = (type: AgentEvent['type'], detail: string, sessionReady = false) => {
      let response;
      const terminal = type === 'execution.completed' || type === 'execution.failed';
      try { response = output.snapshot(messages.map(message => ({ ...message, ...(terminal ? { status: 'complete' as const } : {}) })), terminal); }
      catch (error) {
        if (type !== 'execution.failed') throw error;
        try { response = output.snapshot([], true); } catch { /* Invalid snapshots cannot hide the terminal failure. */ }
      }
      const event = parseAgentEvent({ id: randomUUID(), schema_version: '1.0', execution_id: request.execution_id, sequence: ++sequence, type, occurred_at: new Date().toISOString(), payload: {
        text: visibleText(detail, terminal), ...(sessionReady ? { session_ready: true } : {}),
        ...(response ? { response } : {}),
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
    const approvalSignal = AbortSignal.any([signal, approvalLifetime.signal]);
    const answerPermission = async (message: Message) => {
      const p = message.params, id = message.id!;
      if (approvals.has(id)) return;
      let outcome: { outcome: string; optionId?: string } = { outcome: 'cancelled' };
      try {
        const consent = p?._meta?.kiro?.consent;
        const capability = consent?.capability ?? ({ read: 'fs_read', search: 'fs_read', edit: 'fs_write', delete: 'fs_write', execute: 'shell' } as Record<string, string>)[p?.toolCall?.kind];
        const once = Array.isArray(p?.options) && p.options.length <= 20 ? p.options.find((option: any) => option.kind === 'allow_once' && typeof option.optionId === 'string' && option.optionId.length <= 200) : undefined;
        const deny = Array.isArray(p?.options) ? p.options.find((option: any) => option.kind === 'reject_once' && typeof option.optionId === 'string' && option.optionId.length <= 200) : undefined;
        if (deny) outcome = { outcome: 'selected', optionId: deny.optionId };
        if (!settled && prompting && p?.sessionId === sessionId && typeof p?.toolCall?.toolCallId === 'string' && p.toolCall.toolCallId.length <= 128 && once && ['fs_read', 'fs_write', 'shell'].includes(capability) && (consent || p.toolCall.rawInput) && approvals.size < 8 && !approvals.has(id)) {
          approvals.add(id);
          const allowed = await approveCoding(controls, approvalSignal, capability === 'shell' ? 'command' : capability === 'fs_write' ? 'file_change' : 'permissions', capability === 'shell' ? 'Allow command execution' : 'Allow file access', { project, consent, toolCall: p.toolCall });
          if (allowed && !settled && !approvalSignal.aborted) outcome = { outcome: 'selected', optionId: once.optionId };
        }
      } catch { /* Cancellation and unavailable approvals select no permission. */ }
      finally { approvals.delete(id); }
      if (live) write({ id, result: { outcome } });
    };
    active = { reject, notify(message) {
      if (message.id !== undefined) {
        if (message.method === 'session/request_permission') void answerPermission(message);
        else write({ id: message.id, error: { code: -32601, message: 'Unsupported client request.' } });
        return;
      }
      if (settled || message.params?.sessionId !== sessionId) return;
      if (message.method === '_kiro/mcp/status' && ['failed', 'disabled'].includes(mcpStates.get(sessionId!) ?? '')) { reject(new Error('MCP tools disconnected.')); return; }
      if (message.method !== 'session/update') return;
      const update = message.params.update;
      if (update?._meta?.kiro?.replay === true) return;
      if (update?.sessionUpdate === 'current_mode_update' && update.currentModeId !== mode) { reject(new Error('Kiro changed chat mode.')); return; }
      // Kiro reports its own account configuration refresh as tool-shaped telemetry.
      // This does not authorize any tool request; only matching status updates are ignored.
      if (update?.sessionUpdate === 'tool_call' && update.kind === 'other' && update._meta?.kiro?.toolId === 'fetch_cloud_config' && typeof update.toolCallId === 'string' && update.toolCallId.length <= 256 && configurationUpdates.size < 16) {
        configurationUpdates.add(update.toolCallId); return;
      }
      if (update?.sessionUpdate === 'tool_call_update' && configurationUpdates.has(update.toolCallId)) return;
      if (!prompting) return; // session/load can replay old content before returning.
      try {
        if (update?.sessionUpdate === 'agent_thought_chunk') {
          // Reasoning contents stay local; only the observed activity is forwarded.
          if (output.activity === 'thinking') return;
          output.setActivity('thinking');
        } else if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
          // Kiro's deferred tool discovery has no matching start or MCP identity.
          const loaded = update.rawInput?.tool_ids;
          if (requiredServers.length && update.sessionUpdate === 'tool_call_update' && update.status === 'completed' && update._meta?.kiro?.toolOrigin === 'default' && Array.isArray(loaded) && loaded.length > 0 && loaded.length <= projectToolNames.length + (outbound?.tools.length ?? 0) && loaded.every((id: unknown) => typeof id === 'string' && id.split('::').length === 2 && allowedTool(id.split('::')[0]!, id.split('::')[1]!))) return;
          const previous = output.tools.get(update.toolCallId);
          const identity = update._meta?.kiro?.mcpTool;
          const wrappedParts = typeof update.rawInput?.tool_id === 'string' ? update.rawInput.tool_id.split('::') : [];
          const wrapped = wrappedParts.length === 2 && update._meta?.kiro?.serverName === wrappedParts[0] && allowedTool(wrappedParts[0], wrappedParts[1]) ? wrappedParts[1] : undefined;
          const nativeId = update._meta?.kiro?.toolId;
          const native = coding && (kiroCodingTools.includes(nativeId) ? nativeId : ['read', 'edit', 'delete', 'execute', 'search'].includes(update.kind) ? update.kind : undefined);
          const name = identity && allowedTool(identity.serverName, identity.toolName) ? identity.toolName : wrapped ?? native;
          if (!previous && !name) throw new Error('Unsupported tool.');
          const state = update.status ?? 'in_progress';
          if (coding && state === 'completed' && Array.isArray(update.content)) for (const content of update.content) {
            if (content.type === 'diff' && typeof content.path === 'string' && typeof content.newText === 'string' && (content.oldText === null || typeof content.oldText === 'string')) output.change(content.path, contentPatch(content.path, content.oldText ?? '', content.newText));
          }
          if (!['pending', 'in_progress', 'completed', 'failed'].includes(state)) throw new Error('Invalid tool status.');
          if (!previous && currentMessage) { currentMessage.status = 'complete'; currentMessage = undefined; }
          output.tool(update.toolCallId, previous?.name ?? name, (wrapped ? update.rawInput.arguments : update.rawInput) ?? previous?.arguments ?? '', state === 'pending' ? 'calling' : state === 'in_progress' ? 'running' : state === 'completed' ? 'completed' : 'interrupted', update.rawOutput ?? update.content ?? previous?.result);
        } else if (update?.sessionUpdate === 'agent_message_chunk') {
          if (update.content?.type !== 'text' || typeof update.content.text !== 'string') throw new Error('Unsupported Kiro content.');
          output.setActivity('responding');
          if (!currentMessage) {
            const id = ++messageCount === 1 ? 'answer' : `answer-${messageCount}`;
            output.message(id);
            currentMessage = { id, text: '', status: 'streaming' };
            messages.push(currentMessage);
          }
          currentMessage.text += update.content.text;
          if (coding) while (messages.length > 1 && (messages.length > 30 || messages.reduce((total, message) => total + message.text.length + 2, -2) > 16000)) messages.shift();
          text = messages.map(message => message.text).join('\n\n');
          if (text.length > 16_000 || text.includes('\0')) throw new Error('Kiro response is too large.');
        } else return;
      } catch { reject(new Error('Kiro returned unsupported or oversized content.')); return; }
      dirty = true; if (!progress) progress = setTimeout(flush, 100);
    } };
    const abort = () => { reject(signal.reason instanceof AgentSessionStopped ? signal.reason : new Error('Kiro turn interrupted.')); if (!(signal.reason instanceof AgentSessionStopped)) { fail(); stop(); } };
    signal.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(() => reject(new Error('Kiro turn timed out.')), coding ? CODING_TURN_TIMEOUT_MS : 120_000);
    try {
      await publish('execution.started', 'Kiro is working.');
      if (coding) await approveProject(project, controls, approvalSignal);
      const retained = request.persistent_session ? await sessions.session(request.session_id, request.persistent_session.resume) : undefined;
      taskDirectory = project ?? retained?.cwd ?? await mkdtemp(join(sessions.cwd, 'task-'));
      signal.throwIfAborted();
      if (requiredServers.length && retained?.threadId) mcpStates.delete(retained.threadId);
      const result = retained?.threadId
        ? await rpc('session/load', { ...sessionParams(taskDirectory), sessionId: retained.threadId })
        : await rpc('session/new', sessionParams(taskDirectory));
      // Drain bounded setup requests even on Stop before accepting another task.
      if (rejected) throw rejected;
      requireMode(result, mode);
      sessionId = retained?.threadId ?? result.sessionId;
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 || /[\u0000-\u001f\u007f]/.test(sessionId)) throw new Error('Invalid Kiro session.');
      await waitForTools(sessionId, signal);
      if (retained && !retained.threadId) await retained.save(sessionId, false);
      signal.throwIfAborted();
      if (retained) { await publish('execution.progress', 'Kiro session is ready.', true); await retained.save(sessionId, true); }
      signal.throwIfAborted();
      const content = `${request.context ? `Supplied conversation context (quoted data):\n${JSON.stringify(request.context)}\n\n` : ''}Task:\n${request.goal}${memoryInstructions(request.context)}`;
      prompting = true;
      prompt = rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: content }] }, coding ? CODING_TURN_TIMEOUT_MS : 120_000);
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
      settled = true; approvalLifetime.abort(); clearTimeout(progress); clearTimeout(deadline); signal.removeEventListener('abort', abort); active = undefined;
      if (taskDirectory && !project && !request.persistent_session) await rm(taskDirectory, { recursive: true, force: true });
    }
  };
  return { stop, alive: () => live, invoke };
}

export async function startKiro(storage: LocalSessionStorage, onExit: () => void, launch: SpawnAgent = spawn) {
  return turnScopedRuntime((done, outbound, signal) => startSingleKiro(storage, done, launch, outbound, signal), onExit);
}
