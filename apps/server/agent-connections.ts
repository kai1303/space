import type { FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { AppError, record, uuid } from '@space/contracts';
import type { AgentConnectionStore } from '@space/postgres/agent-connections';
import type { PostgresStore } from '@space/postgres/store';
import { registerLocalCodexTasks } from './local-codex.js';

export function registerAgentConnectionRoutes(app: FastifyInstance, store: AgentConnectionStore) {
  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/local-codex', r => store.channelAgents(r.actorId, uuid(r.params.channelId)));
  app.post<{ Params: { installationId: string; channelId: string } }>('/v1/agents/connections/:installationId/channels/:channelId', r => {
    const input = record(r.body, ['enabled']);
    if (typeof input.enabled !== 'boolean') throw new AppError(400, 'invalid_enabled');
    return store.setChannelEnabled(r.actorId, uuid(r.params.installationId), uuid(r.params.channelId), input.enabled);
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
export function registerAgentConnections(app: FastifyInstance, io: Server, store: AgentConnectionStore, tasks: PostgresStore) {
  const agents = io.of('/agents');
  agents.use(async (socket, next) => {
    try {
      const auth = record(socket.handshake.auth, ['token']);
      socket.data.agent = await store.connect(auth.token);
      socket.data.token = auth.token;
      next();
    } catch { next(new Error('unauthorized')); }
  });
  agents.on('connection', socket => {
    registerLocalCodexTasks(socket, store, tasks);
    const identity = socket.data.agent as { id: string; connection_id: string };
    let working = false, count = 0, windowStart = Date.now();
    socket.on('agent.heartbeat', async (input: unknown, ack: unknown) => {
      if (typeof ack !== 'function') return;
      if (Date.now() - windowStart >= 1000) { count = 0; windowStart = Date.now(); }
      if (working || ++count > 5) { ack({ error: 'busy' }); return; }
      working = true;
      try { ack({ data: await store.heartbeat(socket.data.token, identity.connection_id, input) }); }
      catch (e) {
        const code = e instanceof AppError ? e.code : 'internal_error'; ack({ error: code });
        if (code === 'unauthorized') socket.disconnect(true);
      } finally { working = false; }
    });
    socket.on('disconnect', () => { void store.disconnect(identity.id, identity.connection_id).catch(() => {}); });
  });
  let timer: ReturnType<typeof setInterval>;
  let expiring = false;
  app.addHook('onReady', async () => {
    timer = setInterval(() => {
      if (!expiring) {
        expiring = true;
        void tasks.expireLocalDeliveries().catch(() => app.log.error('local_delivery_cleanup_failed')).finally(() => { expiring = false; });
      }
      for (const socket of agents.sockets.values()) {
        void store.authenticate(socket.data.token).catch(() => socket.disconnect(true));
      }
    }, 10_000);
    timer.unref();
  });
  app.addHook('preClose', async () => { clearInterval(timer); agents.local.disconnectSockets(true); });
}
