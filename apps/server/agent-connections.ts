import type { EventBus } from '@space/events';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { AppError, localProviderForConnector, record, text, uuid } from '@space/contracts';
import type { AgentConnectionStore } from '@space/postgres/agent-connections';
import type { PostgresStore } from '@space/postgres/store';
import {registerDirectTurns} from './direct-turns.js';
import { registerLocalCodexTasks } from './local-codex.js';
import { SubscriptionIndex, type RealtimeWork } from './realtime-work.js';

export function registerAgentConnectionRoutes(app: FastifyInstance, store: AgentConnectionStore) {
  app.get('/v1/agents/connectors', () => store.connectors);
  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/agents', r => store.channelAgents(r.actorId, uuid(r.params.channelId)));
  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/local-codex', async r => (await store.channelAgents(r.actorId, uuid(r.params.channelId))).filter(agent => localProviderForConnector(agent.connector_id)).map(({ id, name, provider, enabled_in_channel, inherits_owner_access }) => ({ id, name, provider, enabled_in_channel, inherits_owner_access })));
  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/local-agents', async r => (await store.channelAgents(r.actorId, uuid(r.params.channelId))).filter(agent => localProviderForConnector(agent.connector_id)).map(({ id, name, provider, enabled_in_channel, inherits_owner_access }) => ({ id, name, provider, enabled_in_channel, inherits_owner_access })));
  app.post<{ Params: { installationId: string; channelId: string } }>('/v1/agents/connections/:installationId/channels/:channelId', r => {
    const input = record(r.body, ['enabled', 'skill']);
    if (typeof input.enabled !== 'boolean') throw new AppError(400, 'invalid_enabled');
    return store.setChannelEnabled(r.actorId, uuid(r.params.installationId), uuid(r.params.channelId), input.enabled, input.skill === undefined ? undefined : text(input.skill, 80));
  });
  const claims = new Map<string, { count: number; until: number }>();
  app.post<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/agent-pairings', async (r, reply) =>
    reply.code(201).send(await store.createPairing(r.actorId, uuid(r.params.workspaceId), r.body)));
  app.get<{ Params: { pairingId: string } }>('/v1/agent-pairings/:pairingId', r => store.pairingStatus(r.actorId, uuid(r.params.pairingId)));
  app.post<{ Params: { pairingId: string } }>('/v1/agent-pairings/:pairingId/cancel', r => {
    record(r.body, []); return store.cancelPairing(r.actorId, uuid(r.params.pairingId));
  });
  app.post('/v1/agent-pairings/claim', async (r, reply) => {
    const now = Date.now();
    for (const [key, value] of claims) if (value.until <= now) claims.delete(key);
    const bucket = claims.get(r.ip) ?? { count: 0, until: now + 60_000 };
    if (claims.size >= 10_000 && !claims.has(r.ip) || ++bucket.count > 30) throw new AppError(429, 'rate_limited');
    claims.set(r.ip, bucket);
    return reply.code(201).send(await store.claim(r.body));
  });
  app.get<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/participants', r => store.participants(r.actorId, uuid(r.params.workspaceId), r.query));
  app.post<{ Params: { installationId: string } }>('/v1/agents/connections/:installationId/revoke', r => {
    record(r.body, []); return store.revoke(r.actorId, uuid(r.params.installationId));
  });
}
export function registerAgentConnections(app: FastifyInstance, io: Server, store: AgentConnectionStore, tasks: PostgresStore, onOutbox: (listener: (keys?: readonly string[]) => void) => () => void, getEvents: () => Promise<EventBus>, work: RealtimeWork) {
  const agents = io.of('/agents');
  agents.use(async (socket, next) => {
    socket.conn.once('close', () => work.cancel(socket.id));
    try {
      const auth = record(socket.handshake.auth, ['token']);
      socket.data.agent = await work.run(socket.id, () => store.connect(auth.token));
      if (socket.conn.readyState !== 'open') return;
      socket.data.token = auth.token;
      next();
    } catch (error) { next(new Error(error instanceof AppError ? error.code : 'internal_error')); }
  });
  const checks = new SubscriptionIndex();
  const stopWakes = onOutbox(keys => checks.wake(keys));
  agents.on('connection', socket => {
    registerDirectTurns(socket,store,tasks,work);
    const identity = socket.data.agent as Awaited<ReturnType<AgentConnectionStore['connect']>>;
    const delivery = registerLocalCodexTasks(socket, store, tasks, getEvents, work, identity.connector_id === 'codex.local');
    let checking = false, dirty = false;
    const stopCheck = checks.add(['global', `workspace:${identity.workspace_id}`, `actor:${identity.owner_id}`], () => {
      dirty = true;
      if (checking) return;
      checking = true;
      void (async () => {
        while (dirty && socket.connected) {
          dirty = false;
          try { await work.run(socket.id, () => store.authenticateConnection(socket.data.token,identity.connection_id)); }
          catch (error) { if (error instanceof AppError && ['unauthorized','realtime_overloaded'].includes(error.code)) socket.disconnect(true); }
        }
      })().finally(() => { checking = false; });
    });
    let working = false, count = 0, windowStart = Date.now();
    socket.on('agent.heartbeat', async (input: unknown, ack: unknown) => {
      if (typeof ack !== 'function') return;
      if (Date.now() - windowStart >= 1000) { count = 0; windowStart = Date.now(); }
      if (working || ++count > 5) { ack({ error: 'busy' }); return; }
      working = true;
      try {
        await delivery.ready;
        ack({ data: await work.run(socket.id, () => store.heartbeat(socket.data.token, identity.connection_id, input)) });
        delivery.notifyReady();
      }
      catch (e) {
        const code = e instanceof AppError ? e.code : 'internal_error'; ack({ error: code });
        if (code === 'unauthorized') socket.disconnect(true);
      } finally { working = false; }
    });
    let titleWrites=0;
    socket.on('agent.session.title',async (raw:unknown,ack:unknown)=>{
      if (typeof ack!=='function') return;
      if (titleWrites>=4) { ack({error:'busy'}); return; }
      titleWrites++;
      try {
        const input=record(raw,['task_id','execution_id','title']);
        await work.run(socket.id,async ()=>{
          await store.authenticateConnection(socket.data.token,identity.connection_id);
          await tasks.syncCodexTitle(identity.id,identity.connection_id,uuid(input.task_id),uuid(input.execution_id),text(input.title,160));
        });
        ack({data:true});
      } catch(error) { ack({error:error instanceof AppError?error.code:'internal_error'}); }
      finally {titleWrites--;}
    });
    socket.on('disconnect', () => { stopCheck(); work.cancel(socket.id); void work.run(`disconnect:${socket.id}`, () => store.disconnect(identity.id, identity.connection_id)).catch(() => {}); });
  });
  app.addHook('preClose', async () => { stopWakes(); agents.local.disconnectSockets(true); });
}
