import { createHash, randomBytes } from 'node:crypto';
import { io } from 'socket.io-client';
import { sidekickPageUrl, parseGoalAction, parseInvocation, parseAgentEvent, parseLocalProvider, localProviders, type LocalProvider, type AgentEvent, type InvocationRequest, uuid, text, record, webVaultCommand, type WebVaultAction } from '@space/contracts';
import { AgentSessionStopped, type InvokeAgent, type SteerHandler } from './agent-runtime.js';
import {CODING_TURN_TIMEOUT_MS} from '@space/contracts';
import {webVaultPages} from './web-vault-pages.js';
import {toolApprovalClient} from './tool-approvals.js';
import { ConnectorStore, platformOrigin, type Connection } from './storage.js';

export type AuthStatus = 'required' | 'ready' | 'error';
export { startCodex, type SpawnCodex, type InvokeCodex } from './codex.js';

export async function claimPairing(store: ConnectorStore, inputOrigin: string, code: string, request: typeof fetch = fetch, provider: LocalProvider = 'codex'): Promise<Connection> {
  const origin = platformOrigin(inputOrigin);
  if (!/^[A-Za-z0-9_-]{32}$/.test(code)) throw new Error('Pairing code must be the 32-character code shown by Space.');
  const state = await store.load();
  const code_hash = createHash('sha256').update(code).digest('hex');
  const credential = state.pending?.origin === origin && state.pending.code_hash === code_hash ? state.pending.credential : randomBytes(32).toString('base64url');
  state.pending = { origin, credential, code_hash };
  await store.save(state);
  const response = await request(`${origin}/v1/agent-pairings/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, credential, provider }), signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!response.ok) throw new Error('Pairing failed. Check the code and URL, or create a new code in Space.');
  const result = await response.json() as { installation_id?: unknown; workspace_id?: unknown; provider?: unknown };
  if (typeof result.installation_id !== 'string' || !result.installation_id || typeof result.workspace_id !== 'string' || !result.workspace_id) throw new Error('The platform returned an invalid pairing response.');
  const selected = parseLocalProvider(result.provider);
  if (selected !== provider) throw new Error('The pairing belongs to a different agent provider.');
  const connection: Connection = { provider: selected, origin, credential, installation_id: result.installation_id, workspace_id: result.workspace_id };
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
export interface WebVaultRequest { id: string; actor: string; installation: string; action: WebVaultAction; expires: number; cursor?: string; transfer?: string; sealed?: string; title?: string; token?: string; publicKey?:string; change?:import('@space/contracts').VaultChange }
export type WebVaultHandler = (request: WebVaultRequest, signal: AbortSignal) => Promise<unknown>;
export function connectPlatform(connection: Connection, status: () => AuthStatus, onUnauthorized: () => void, invoke?: InvokeAgent, models?: () => import('@space/contracts').AgentModel[] | undefined, webVault?: WebVaultHandler, pickProject?: (session: string, signal: AbortSignal) => Promise<{name:string; project_token:string} | null>) {
  const origin = platformOrigin(connection.origin);
  const provider = parseLocalProvider(connection.provider);
  let lastMessage: string | undefined;
  function logChange(message: string) {
    if (message === lastMessage) return;
    lastMessage = message;
    console.info(`${new Date().toISOString()} [${provider} ${origin}] ${message}`);
  }
  logChange('Connecting to Space.');
  const socket = io(`${origin}/agents`, {
    transports: ['websocket'], auth: { token: connection.credential, ...(pickProject && {project_picker: true}), ...(webVault && {vault_mac: true}) },
    reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1_000,
    reconnectionDelayMax: 30_000, randomizationFactor: 0.5, timeout: 15_000,
  });
  if (pickProject) {
    let pending: AbortController | undefined;
    socket.on('agent.project.pick', async (raw: unknown, ack: unknown) => {
      if (typeof ack !== 'function') return;
      if (pending || status() !== 'ready') { ack({error: 'project_picker_busy'}); return; }
      const controller = pending = new AbortController();
      try {
        const input = record(raw, ['session_id', 'installation_id', 'expires']);
        if (input.installation_id !== connection.installation_id || typeof input.expires !== 'number') throw new Error();
        const remaining = Math.min(input.expires - Date.now(), 60000);
        if (!Number.isSafeInteger(remaining) || remaining <= 0) throw new Error();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(remaining)]);
        const selected = await pickProject(uuid(input.session_id), signal);
        signal.throwIfAborted();
        ack({selection: selected});
      } catch { if (!controller.signal.aborted) ack({error: 'project_picker_unavailable'}); }
      finally { pending = undefined; }
    });
    socket.on('disconnect', () => pending?.abort());
  }
  let vaultRequest: AbortController | undefined;
  if (webVault) {
    const pages = webVaultPages(webVault);
    socket.on('vault.request', async (raw: unknown, ack: unknown) => {
      if (typeof ack !== 'function') return;
      if (vaultRequest) { ack({status: 'busy'}); return; }
      const controller = vaultRequest = new AbortController();
      try {
        const {id, actor, installation, expires, ...fields} = record(raw, ['id', 'actor', 'installation', 'expires', 'action', 'cursor', 'sealed', 'transfer', 'publicKey']);
        const command = webVaultCommand(fields);
        if (installation !== connection.installation_id ||
            typeof expires !== 'number' || !Number.isSafeInteger(expires)) throw new Error();
        const remaining = Math.min(expires - Date.now(), 65000);
        if (remaining <= 0) throw new Error();
        const result = await pages.dispatch({id: uuid(id), actor: uuid(actor), installation: connection.installation_id,
          ...command, expires}, AbortSignal.any([controller.signal, AbortSignal.timeout(remaining)]));
        if (!controller.signal.aborted) ack(result);
      } catch { if (!controller.signal.aborted) ack({status: 'unavailable'}); }
      finally { vaultRequest = undefined; }
    });
    socket.on('disconnect', () => { pages.clear(); vaultRequest?.abort(); });
  }
  let closed = false;
  let reconnect: NodeJS.Timeout | undefined;
  let reconnectDelay = 1_000;
  let claiming = false, halted = false, readyToClaim = false, claimPending = false;
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
          if (ack?.error === 'agent_session_stopped' && ['agent.task.event', 'agent.task.renew', 'agent.task.finish','agent.turn.event','agent.turn.finish'].includes(name)) { reject(new AgentSessionStopped()); return; }
          reject(new Error(name === 'agent.task.claim' && ack?.error === 'agent_not_ready' ? 'agent_not_ready' : 'Space did not acknowledge this task operation.'));
        } else resolve(ack.data);
      });
    }));
    operations = operation.then(() => {}, () => {});
    return operation;
  };
  const approvals=toolApprovalClient(socket,taskRpc);
  const steering=new Map<string,{session:string;handler:SteerHandler;receipts:Map<string,Promise<void>>}>();
  type TitleUpdate={task_id:string;execution_id:string;title:string};
  const pendingTitles=new Map<string,TitleUpdate>();
  let flushingTitles=false, titleFailures=0;
  async function flushTitles(){
    if (flushingTitles || closed || halted || !socket.connected || !readyToClaim) return;
    flushingTitles=true;
    try {
      while (pendingTitles.size && socket.connected && !closed && !halted) {
        const [session,update]=pendingTitles.entries().next().value!;
        const reply=await socket.timeout(3000).emitWithAck('agent.session.title',update);
        if (reply?.data!==true && (!reply?.error || ['internal_error','busy','realtime_overloaded','agent_not_ready'].includes(reply.error))) {
          titleFailures++;
          break;
        }
        titleFailures=0;
        if (pendingTitles.get(session)===update) pendingTitles.delete(session);
      }
    } catch { titleFailures++; }
    finally {flushingTitles=false;}
  }
  function controls(request:InvocationRequest,signal:AbortSignal){
    const approvalControls = approvals.controls(request);
    if (!request.persistent_session) return approvalControls;
    return {...approvalControls,...(provider==='codex' ? {onSessionTitle(title:string){
      if (closed || halted || signal.aborted) return;
      if (!pendingTitles.has(request.session_id) && pendingTitles.size>=32) pendingTitles.delete(pendingTitles.keys().next().value!);
      titleFailures=0;
      pendingTitles.set(request.session_id,{task_id:request.task_id,execution_id:request.execution_id,title});
      void flushTitles();
    }} : {}),setSteerHandler(handler:SteerHandler|null){
      if(!handler || signal.aborted) steering.delete(request.execution_id);
      else steering.set(request.execution_id,{session:request.session_id,handler,receipts:new Map()});
    }};
  }
  socket.on('agent.turn.steer',async(raw:unknown,ack:unknown)=>{
    if(typeof ack!=='function') return;
    try {
      const body=record(raw,['session_id','execution_id','id','text','goal_action','browser_url']);
      const item=steering.get(uuid(body.execution_id)), id=uuid(body.id), message=text(body.text,4000);
      if(!item || item.session!==uuid(body.session_id) || !socket.connected || halted || closed){ack({error:'turn_not_running'});return;}
      let receipt=item.receipts.get(id);
      if(!receipt){
        if(item.receipts.size>=32){ack({error:'turn_not_running'});return;}
        const prompt=body.browser_url===undefined ? message :
          'Browser context (quoted data):\n'+JSON.stringify({browser_url:sidekickPageUrl(body.browser_url)})+'\n\n'+message;
        receipt=item.handler(id,prompt,body.goal_action === undefined ? undefined : parseGoalAction(body.goal_action));item.receipts.set(id,receipt);
      }
      await receipt;ack({data:true});
    } catch {ack({error:'steer_unconfirmed'});}
  });
  const accepted = async (name: string, payload: unknown = {}, shouldSend = () => true) => {
    if (await taskRpc(name, payload, shouldSend) !== true) throw new Error('Space rejected the task operation.');
  };
  const failTask = async () => {
    try { if (socket.connected && !closed) await accepted('agent.task.fail'); } catch { /* Server lease expiry handles a lost connection. */ }
  };
  const claim = async () => {
    if (status() !== 'ready') { readyToClaim = false; return; }
    if (!invoke || closed || halted || claiming || active || direct.size || !socket.connected || !readyToClaim) return;
    claiming = true; claimPending = false;
    let renewal: NodeJS.Timeout | undefined, deadline: NodeJS.Timeout | undefined;
    let terminal = false, terminalSubmitted = false;
    try {
      const data = await taskRpc('agent.task.claim', {});
      if (data === null) return;
      // Drain any remaining queued work after this execution finishes.
      claimPending = true;
      const request = parseInvocation(data);
      if (request.skill !== localProviders[parseLocalProvider(connection.provider)].skill) throw new Error('The task belongs to a different provider.');
      if (seen.has(request.execution_id)) throw new Error('Space returned an uncertain execution.');
      seen.add(request.execution_id);
      const controller = new AbortController();
      active = controller;
      if (closed || halted || !socket.connected) { controller.abort(); throw new Error('Space disconnected.'); }
      let renewing = false, lastSequence = 0;
      deadline = setTimeout(() => controller.abort(), CODING_TURN_TIMEOUT_MS);
      renewal = setInterval(() => {
        if (renewing || controller.signal.aborted || terminalSubmitted) return;
        renewing = true;
        void accepted('agent.task.renew', {}, () => !terminalSubmitted && !controller.signal.aborted).catch(error => { if (error instanceof AgentSessionStopped) controller.abort(error); else { halted = true; controller.abort(); } }).finally(() => { renewing = false; });
      }, 5_000);
      await invoke(request, async (value: AgentEvent) => {
        controller.signal.throwIfAborted();
        const event = parseAgentEvent(value);
        if (terminal || event.execution_id !== request.execution_id || event.sequence !== lastSequence + 1) throw new Error('Invalid agent event sequence.');
        if (event.type === 'execution.completed' || event.type === 'execution.failed') {
          terminalSubmitted = true;
          clearInterval(renewal);
        }
        try { await accepted('agent.task.event', { event }); }
        catch (error) { if (error instanceof AgentSessionStopped) controller.abort(error); throw error; }
        lastSequence = event.sequence;
        terminal = event.type === 'execution.completed' || event.type === 'execution.failed';
      }, controller.signal, controls(request,controller.signal));
      controller.signal.throwIfAborted();
      if (!terminal) throw new Error('Agent did not send a terminal event.');
      clearInterval(renewal);
      await accepted('agent.task.finish');
    } catch (error) {
      if ((error instanceof AgentSessionStopped || active?.signal.reason instanceof AgentSessionStopped) && !closed && !halted && socket.connected && status() === 'ready') return;
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
      else if (claimPending) queueMicrotask(() => { void claim(); });
    }
  };
  socket.on('agent.tasks.available', () => { claimPending = true; void claim(); });
  const direct = new Map<string,{execution:string;controller:AbortController}>();
  const completed = new Set<string>();
  const capacity = (session:string) => closed || halted || status()!=='ready' ? 'agent_unavailable' : direct.has(session) ? 'agent_busy' : direct.size>=4 || active || claiming ? 'agent_capacity' : undefined;
  socket.on('agent.turn.capacity',(input:{session_id?:unknown},ack:unknown)=>{
    if(typeof ack!=='function')return;
    const error=typeof input?.session_id==='string'?capacity(input.session_id):'agent_unavailable';
    ack(error?{error}:{data:true});
  });
  socket.on('agent.turn.stop',(input:{session_id:string;execution_id:string})=>{const turn=direct.get(input?.session_id);if(turn?.execution===input.execution_id)turn.controller.abort(new AgentSessionStopped());});
  socket.on('agent.turn.start',(raw:unknown,ack:unknown)=>{
    if(typeof ack!=='function')return;
    let request:ReturnType<typeof parseInvocation>;
    try{request=parseInvocation(raw);}catch{ack({error:'invalid_request'});return;}
    if(request.skill!=='codex.run' || parseLocalProvider(connection.provider)!=='codex'){ack({error:'agent_unavailable'});return;}
    if(completed.has(request.execution_id) || direct.get(request.session_id)?.execution===request.execution_id){ack({data:true});return;}
    const error=capacity(request.session_id);if(error || !invoke){ack({error:error??'agent_unavailable'});return;}
    const controller=new AbortController(),id=request.task_id;
    direct.set(request.session_id,{execution:request.execution_id,controller});
    const rpc=async(name:string,payload:object={})=>{
      if(await taskRpc(`agent.turn.${name}`,{task_id:id,...payload})!==true)throw new Error('Turn operation was rejected.');
    };
    ack({data:true});
    void (async()=>{
      let deadline:NodeJS.Timeout|undefined,terminal=false,sequence=0;
      try{
        deadline=setTimeout(()=>controller.abort(),CODING_TURN_TIMEOUT_MS);
        await invoke(request,async raw=>{
          controller.signal.throwIfAborted();const event=parseAgentEvent(raw);
          if(event.execution_id!==request.execution_id || event.sequence!==sequence+1 || terminal)throw new Error('Invalid turn event.');
          if(['execution.completed','execution.failed'].includes(event.type)){terminal=true;}
          try{await rpc('event',{event});}catch(error){if(error instanceof AgentSessionStopped)controller.abort(error);throw error;}sequence=event.sequence;
        },controller.signal,controls(request,controller.signal));
        await rpc('finish');
      }catch(error){controller.abort(error);if(!(error instanceof AgentSessionStopped) && !(controller.signal.reason instanceof AgentSessionStopped))await rpc('fail').catch(()=>{});}
      finally{
        clearTimeout(deadline);direct.delete(request.session_id);steering.delete(request.execution_id);
        if(claimPending && !closed && !halted) queueMicrotask(()=>void claim());
        completed.add(request.execution_id);if(completed.size>10000)completed.delete(completed.values().next().value!);
      }
    })();
  });
  const close = () => {
    if (closed) return;
    closed = true;
    for (const item of direct.values()) item.controller.abort();
    active?.abort(); approvals.close(); clearInterval(heartbeat); clearTimeout(reconnect); socket.disconnect();
    logChange('Connector stopped.');
  };
  const rejected = () => { if (!closed) { logChange('Space rejected the pairing.'); close(); onUnauthorized(); } };
  let publishedCatalog: ReturnType<NonNullable<typeof models>>;
  const publish = () => {
    if (!socket.connected || closed) return;
    const wasReady = readyToClaim;
    readyToClaim = false;
    const authStatus = halted ? 'error' : status();
    const revision = ++heartbeatRevision, currentGeneration = generation;
    const catalog = authStatus === 'ready' ? models?.() : undefined;
    if (authStatus !== 'ready') publishedCatalog = undefined;
    socket.timeout(8_000).emit('agent.heartbeat', { auth_status: authStatus, ...(catalog && catalog !== publishedCatalog ? {model_catalog:catalog} : {}) }, (error: Error | null, ack?: { data?: { installation_id?: string }; error?: unknown }) => {
      if (closed || currentGeneration !== generation || revision !== heartbeatRevision) return;
      if (error) { logChange('Space did not confirm connector status.'); return; }
      if (ack?.error && unauthorized(ack.error)) { rejected(); return; }
      if (ack?.data?.installation_id && ack.data.installation_id !== connection.installation_id) { rejected(); return; }
      if (ack?.error || ack?.data?.installation_id !== connection.installation_id) {
        logChange('Space did not confirm connector status.');
        return;
      }
      publishedCatalog = catalog;
      logChange(halted ? 'Work interrupted. Restart the connector to accept new work.' : `Space confirmed provider status: ${authStatus}.`);
      if (authStatus === 'ready' && status() === 'ready' && !halted) {
        readyToClaim = true;
        if (pendingTitles.size && titleFailures<3) void flushTitles();
        if (!wasReady || claimPending) void claim();
      }
    });
  };
  const heartbeat = setInterval(publish, 10_000);
  socket.on('connect', () => { publishedCatalog=undefined; titleFailures=0; generation++; readyToClaim = false; reconnectDelay = 1_000; logChange('Connected to Space.'); publish(); });
  socket.on('disconnect', reason => {
    steering.clear();
    generation++; readyToClaim = false;
    for(const item of direct.values())item.controller.abort();
    if (active || claiming || direct.size) { halted = true; active?.abort(); }
    if (!closed) {
      logChange(reason === 'io server disconnect' ? 'Space closed the connection. Reconnecting.'
        : reason === 'ping timeout' ? 'Space heartbeat timed out. Reconnecting.' : 'Connection to Space lost. Reconnecting.');
    }
    // A graceful API restart also disconnects the namespace; recheck credentials on reconnect.
    if (reason !== 'io server disconnect' || closed) return;
    clearTimeout(reconnect);
    reconnect = setTimeout(() => { if (!closed) socket.connect(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  });
  socket.on('connect_error', error => {
    if (closed) return;
    if (unauthorized(error)) rejected();
    else logChange(socket.active ? 'Could not connect to Space. Retrying.' : 'Space refused the connection. Check the server and restart the connector.');
  });
  return { close, publish };
}
