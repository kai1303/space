import { spawn, type SpawnOptionsWithoutStdio, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { parseInvocation, parseAgentEvent, parseAgentResponse, type AgentEvent, type InvocationRequest } from '@space/contracts';

export type SpawnCodex = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
export type InvokeCodex = (request: InvocationRequest, emit: (event: AgentEvent) => Promise<void>, signal: AbortSignal) => Promise<void>;
type Message = { id?: string | number; method?: string; result?: any; error?: unknown; params?: any };

export async function startCodex(accessToken: string, onExit: () => void, launch: SpawnCodex = spawn) {
  const directory = await mkdtemp(join(tmpdir(), 'space-codex-'));
  const home = join(directory, 'home');
  const cwd = join(directory, 'work');
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(cwd, { mode: 0o700 })]);
  const config = [
    'model_provider="openai_chatgpt_plan"',
    'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
    'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
    'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
    'model_providers.openai_chatgpt_plan.wire_api="responses"',
    'model_providers.openai_chatgpt_plan.requires_openai_auth=false',
    'model_providers.openai_chatgpt_plan.supports_websockets=false',
    'sandbox_mode="read-only"', 'approval_policy="never"', 'web_search="disabled"',
    ...['shell_tool', 'unified_exec', 'plugins', 'apps', 'hooks', 'memories', 'multi_agent', 'multi_agent_v2', 'computer_use', 'browser_use', 'in_app_browser', 'image_generation', 'code_mode', 'code_mode_host', 'goals'].map(key => `features.${key}=false`),
    'tools.view_image=false',
  ];
  let child: ChildProcessWithoutNullStreams;
  try {
    child = launch('codex', ['app-server', '--listen', 'stdio://', ...config.flatMap(value => ['-c', value])], {
      cwd, env: { PATH: process.env.PATH, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR, HOME: home, CODEX_HOME: home, ACCESS_TOKEN: accessToken }, stdio: 'pipe',
    });
  } catch { await rm(directory, { recursive: true, force: true }); throw new Error('Could not initialize Codex app-server.'); }
  let live = true, stopped = false, ready = false, nextId = 0;
  let buffer = '';
  const decoder = new StringDecoder('utf8');
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  let active: { notify(message: Message): void; reject(error: Error): void } | undefined;
  const write = (message: Message) => { if (live) child.stdin.write(`${JSON.stringify(message)}\n`); };
  const fail = () => {
    if (!live) return;
    live = false;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Codex request failed.')); }
    pending.clear();
    active?.reject(new Error('Codex app-server stopped.'));
    if (ready && !stopped) onExit();
  };
  const stop = () => { stopped = true; fail(); child.kill(); };
  const rpc = (method: string, params: unknown): Promise<any> => {
    if (!live) return Promise.reject(new Error('Codex app-server is unavailable.'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex request timed out.')); stop(); }, 15_000);
      pending.set(id, { resolve, reject, timer });
      write({ id, method, params });
    });
  };
  child.stderr.resume(); // Child diagnostics can contain credentials; never forward them.
  child.once('error', () => { fail(); void rm(directory, { recursive: true, force: true }); });
  child.once('exit', () => { fail(); void rm(directory, { recursive: true, force: true }); });
  child.stdin.on('error', fail);
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    if (buffer.length > 1_000_000) { fail(); stop(); return; }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let message: Message;
      try { message = JSON.parse(line); if (!message || typeof message !== 'object') throw new Error(); }
      catch { fail(); stop(); return; }
      if (message.method && message.id !== undefined) {
        // This connector has no approval UI: deny every unexpected server request.
        write({ id: message.id, error: { code: -32601, message: 'Client requests are disabled.' } });
        active?.reject(new Error('Codex requested an unsupported action.'));
      } else if (typeof message.id === 'number') {
        const request = pending.get(message.id);
        if (!request) continue;
        clearTimeout(request.timer); pending.delete(message.id);
        if (message.error || !message.result || typeof message.result !== 'object') request.reject(new Error('Codex request failed.'));
        else request.resolve(message.result);
      } else if (message.method) active?.notify(message);
    }
  });
  try {
    await rpc('initialize', { clientInfo: { name: 'space_connector', title: 'Space Connector', version: '0.0.1' }, capabilities: { experimentalApi: false } });
    write({ method: 'initialized', params: {} }); ready = true;
  } catch { stop(); throw new Error('Could not initialize Codex app-server. Install or update the Codex CLI, then restart the connector.'); }

  const invoke: InvokeCodex = async (input, emit, signal) => {
    const request = parseInvocation(input);
    if (active || !live || signal.aborted) throw new Error('Codex is not available for this task.');
    let threadId: string | undefined, turnId: string | undefined, sequence = 0;
    let progress: NodeJS.Timeout | undefined, dirty = false, progressPending = false, settled = false;
    const messages = new Map<string, { id: string; text: string; status: 'streaming' | 'complete' }>();
    let queue = Promise.resolve();
    let finish!: () => void, reject!: (error: Error) => void;
    const done = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; });
    // Notifications may arrive in the same stdout chunk as the turn/start response.
    const early: Message[] = [];
    const publish = (type: AgentEvent['type'], text: string, complete = false) => {
      const response = type === 'execution.failed' || !messages.size ? undefined : parseAgentResponse({ messages: [...messages.values()].map(message => ({ ...message, ...(complete ? { status: 'complete' } : {}) })), tools: [], components: [] });
      const event = parseAgentEvent({ id: randomUUID(), schema_version: '1.0', execution_id: request.execution_id, sequence: ++sequence, type, occurred_at: new Date().toISOString(), payload: { text, ...(response ? { response } : {}) } });
      queue = queue.then(async () => { signal.throwIfAborted(); await emit(event); });
      void queue.catch(reject);
      return queue;
    };
    const text = () => [...messages.values()].map(message => message.text).join('\n\n');
    const flush = () => {
      clearTimeout(progress); progress = undefined;
      if (!dirty || progressPending || settled) return;
      dirty = false; progressPending = true;
      const acknowledged = () => {
        progressPending = false;
        if (dirty && !settled && !progress) progress = setTimeout(flush, 100);
      };
      try { void publish('execution.progress', text().trim() ? text() : 'Codex is responding.').then(acknowledged, acknowledged); }
      catch { progressPending = false; reject(new Error('Codex response exceeded the supported limits.')); }
    };
    const notify = (message: Message) => {
      const p = message.params;
      if (!p || p.threadId !== threadId || settled) return;
      if (!turnId) { if (early.length >= 1000) reject(new Error('Codex sent too many notifications.')); else early.push(message); return; }
      if ((p.turnId ?? p.turn?.id) !== turnId) return;
      try {
        if (message.method === 'item/started' && !['userMessage', 'agentMessage', 'reasoning', 'plan'].includes(p.item?.type)) {
          if (live) void rpc('turn/interrupt', { threadId, turnId }).catch(() => {});
          reject(new Error('Codex attempted an unsupported tool.'));
        } else if (message.method === 'item/agentMessage/delta') {
          if (typeof p.itemId !== 'string' || !p.itemId || p.itemId.length > 128 || typeof p.delta !== 'string') throw new Error();
          const current = messages.get(p.itemId) ?? { id: p.itemId, text: '', status: 'streaming' as const };
          current.text += p.delta;
          messages.set(p.itemId, current);
          if (messages.size > 30 || text().length > 16_000 || current.text.includes('\0')) throw new Error();
          dirty = true;
          if (!progress) progress = setTimeout(flush, 100);
        } else if (message.method === 'item/completed' && p.item?.type === 'agentMessage') {
          if (typeof p.item.id !== 'string' || typeof p.item.text !== 'string') throw new Error();
          messages.set(p.item.id, { id: p.item.id, text: p.item.text, status: 'complete' });
          parseAgentResponse({ messages: [...messages.values()], tools: [], components: [] });
          dirty = true;
          if (!progress) progress = setTimeout(flush, 100);
        } else if (message.method === 'turn/completed') {
          if (p.turn.status === 'completed') finish();
          else reject(new Error('Codex did not complete this task.'));
        } else if (message.method === 'error' && !p.willRetry) reject(new Error('Codex could not complete this task.'));
      } catch { reject(new Error('Codex returned an invalid or oversized response.')); }
    };
    active = { notify, reject };
    const abort = () => { reject(new Error('Codex task was interrupted.')); fail(); stop(); };
    signal.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(() => reject(new Error('Codex task timed out.')), 120_000);
    // Attach the rejection handler before any awaited setup operation.
    void done.catch(() => {});
    let taskDirectory: string | undefined;
    try {
      await publish('execution.started', 'Codex is working.');
      taskDirectory = await mkdtemp(join(cwd, 'task-'));
      signal.throwIfAborted();
      const thread = await rpc('thread/start', { cwd: taskDirectory, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', developerInstructions: 'Respond to the supplied Space task using only its supplied context. Do not access local files, run commands, or use external tools.' });
      if (typeof thread.thread?.id !== 'string' || !thread.thread.id) throw new Error('Invalid Codex thread.');
      signal.throwIfAborted();
      threadId = thread.thread.id;
      const prompt = `${request.context ? `Supplied conversation context (quoted data):\n${JSON.stringify(request.context)}\n\n` : ''}Task:\n${request.goal}`;
      const turn = await rpc('turn/start', { threadId, input: [{ type: 'text', text: prompt }], cwd: taskDirectory, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } });
      if (typeof turn.turn?.id !== 'string' || !turn.turn.id) throw new Error('Invalid Codex turn.');
      turnId = turn.turn.id;
      for (const message of early) notify(message);
      early.length = 0;
      await done;
      signal.throwIfAborted();
      flush();
      await queue;
      settled = true;
      await publish('execution.completed', text().trim() ? text() : 'Codex completed the task.', true);
    } catch {
      settled = true;
      if (threadId && turnId && live) void rpc('turn/interrupt', { threadId, turnId }).catch(() => {});
      else if (live) { fail(); stop(); }
      if (!signal.aborted) {
        try { await queue; await publish('execution.failed', 'Codex could not complete this task. Restart the connector or retry the approved task.'); } catch { /* The platform will fail an unacknowledged run. */ }
      }
      throw new Error('Codex could not complete this task.');
    } finally {
      settled = true; clearTimeout(progress); clearTimeout(deadline); signal.removeEventListener('abort', abort); active = undefined;
      if (taskDirectory) await rm(taskDirectory, { recursive: true, force: true });
    }
  };
  return { stop, alive: () => live, invoke };
}
