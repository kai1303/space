import { registerRequestMetrics, type MonitoringListener } from './request-metrics.js';
import { HuddleStore } from '@space/postgres/huddles';
import {ToolApprovalStore} from '@space/postgres/tool-approvals';
import {registerToolApprovals} from './tool-approvals.js';
import { registerHuddles, HUDDLE_WEBHOOK } from './huddles.js';
import type { HuddleMedia } from './huddle-media.js';
import {registerOutbound,type OutboundOptions} from './outbound.js';
import { CallStore } from '@space/postgres/calling';
import { registerCalling } from './calling.js';
import { SearchStore } from '@space/postgres/search';
import { registerSearch } from './search.js';
import type { TypesenseOptions } from './typesense.js';
import { WorkspaceSettingsStore } from '@space/postgres/workspace-settings';
import { WorkspaceInvitationStore } from '@space/postgres/workspace-invitations';
import { WorkspaceRetentionStore } from '@space/postgres/workspace-retention';
import { registerWorkspaceSettingsRoutes } from './workspace-settings.js';
import { registerWorkspaceInvitationRoutes } from './workspace-invitations.js';
import { registerWorkspaceRetention } from './workspace-retention.js';
import { registerInvitationEmailDelivery, type InvitationEmailConfig, type createInvitationMailer } from './invitation-email.js';
import { WorkspaceHubStore } from '@space/postgres/workspace-hub';
import { registerWorkspaceHubRoutes } from './workspace-hub.js';
import { TodoSyncStore } from '@space/postgres/todo-sync';
import { TODO_SYNC_PATH, registerTodoSyncRoutes } from './todo-sync.js';
import { registerEventDeadlines } from './event-deadlines.js';
import { AgentSessionStore } from '@space/postgres/agent-sessions';
import {directTurns} from './direct-turns.js';
import { registerAgentSessionRoutes } from './agent-sessions.js';
import { NavigatorStore } from '@space/postgres/navigator';
import { registerNavigatorRoutes } from './navigator.js';
import { AgentConnectionStore } from '@space/postgres/agent-connections';
import { registerAgentConnectionRoutes, registerAgentConnections } from './agent-connections.js';
import type { IncomingHttpHeaders } from 'node:http';
import { registerAuthRoutes, assertTrustedOrigin, type Authentication } from './auth.js';
import Fastify, { LogController } from 'fastify';
import { AppError, record, text, uuid } from '@space/contracts';
import type { PostgresStore } from '@space/postgres/store';
import { WorkspaceStore } from '@space/postgres/workspace';
import { ChatStore } from '@space/postgres/chat';
import { registerChatRoutes } from './chat.js';
import { registerRealtime, type RealtimeOptions } from './realtime.js';
import { registerWorkspaceRoutes } from './workspace.js';
import { AssetStore } from '@space/postgres/assets';
import { registerAssetRoutes } from './assets.js';
import type { AssetStorage } from './storage.js';
import { MemoryStore } from '@space/postgres/memory';
import { createAgentMemoryReader, createMemoryProviders, registerMemoryRoutes, type MemoryOptions } from './memory.js';
import { MEMORY_MCP_PATH, registerMemoryMcp } from './memory-mcp.js';

declare module 'fastify' {
  interface FastifyRequest { actorId: string }
}

export function createApi(store: PostgresStore, options: { monitoring?: MonitoringListener; huddles?: HuddleMedia; outbound?: OutboundOptions; search?: TypesenseOptions; invitationEmail?: {config:InvitationEmailConfig;mailer:ReturnType<typeof createInvitationMailer>}; pairedConnectors?: import('@space/contracts').PairedConnector[]; logger?: boolean; realtime?: RealtimeOptions; auth?: Authentication; allowDevelopmentTokens?: boolean; trustedProxies?: string[]; storage?: AssetStorage; memory?: MemoryOptions } = {}) {
  if (options.allowDevelopmentTokens && process.env.NODE_ENV === 'production') throw new Error('Development tokens are forbidden in production');
  const authenticate = async (headers: IncomingHttpHeaders, socketToken?: unknown) => {
    const actor = await options.auth?.actor(headers);
    if (actor) return actor;
    const token = socketToken ?? (headers.authorization?.startsWith('Bearer ') ? headers.authorization.slice(7) : undefined);
    if (options.allowDevelopmentTokens && typeof token === 'string' && token.length <= 256) return store.authenticate(token);
    throw new AppError(401, 'unauthorized');
  };
  const app = Fastify({
    logger: options.logger ? {serializers:{req:(request:{method?:string;url?:string})=>({method:request.method,url:request.url?.replace(/(\/invitations\/)[^/?]+/,'$1[redacted]').replace(/([?&]invite=)[^&]+/,'$1[redacted]')})}} : false,
    trustProxy: options.trustedProxies ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 32768,
    requestTimeout: 15_000,
  });
  if (options.monitoring) registerRequestMetrics(app, options.monitoring);
  app.server.headersTimeout = 10_000;
  app.server.maxHeadersCount = 50;
  app.decorateRequest('actorId', '');
  registerOutbound(app,store,options.outbound);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    if (['/healthz','/readyz'].includes(request.routeOptions.url ?? '') && request.method === 'GET') return;
    if (request.routeOptions.url === MEMORY_MCP_PATH) return;
    if (request.routeOptions.url === HUDDLE_WEBHOOK) return;
    // This route authenticates a source-scoped token itself; it never grants actor access.
    if (request.routeOptions.url === TODO_SYNC_PATH) return;
    if (options.auth && request.routeOptions.url === '/v1/auth/*') return;
    if (request.method === 'POST' && request.routeOptions.url === '/v1/agent-pairings/claim') return;
    request.actorId = await authenticate(request.headers);
    if (options.auth && request.headers.cookie && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) assertTrustedOrigin(options.auth, request.headers.origin);
  });
  app.addHook('preParsing', async request => {
    if (request.routeOptions.url === HUDDLE_WEBHOOK) return;
    if (['POST', 'PATCH', 'PUT'].includes(request.method) && request.routeOptions.url && request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      throw new AppError(415, 'json_required');
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) return reply.code(error.status).send({ error: error.code });
    const failure = error as { code?: string; statusCode?: number; message?: string; cause?: {code?:string;message?:string} };
    const databaseFailure = failure.cause ?? failure;
    if(databaseFailure.code === '23514' && databaseFailure.message?.includes('guest_channel_limit')) return reply.code(409).send({error:'guest_channel_limit'});
    if (failure.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: 'body_too_large' });
    if (failure.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return reply.code(415).send({ error: 'json_required' });
    if (failure.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || failure.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') return reply.code(400).send({ error: 'invalid_json' });
    if (failure.code?.startsWith('FST_') && failure.statusCode === 400) return reply.code(400).send({ error: 'invalid_request' });
    // Exceptions can contain database credentials or input; log only a correlation ID.
    request.log.error({ requestId: request.id }, 'api_request_failed');
    return reply.code(500).send({ error: 'internal_error' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));
  if (options.auth) registerAuthRoutes(app, options.auth);
  registerWorkspaceRoutes(app, new WorkspaceStore(store.pool));
  registerWorkspaceSettingsRoutes(app, new WorkspaceSettingsStore(store.pool));
  const invitations = new WorkspaceInvitationStore(store.pool, {emailEncryptionKey:options.invitationEmail?.config.encryptionKey});
  registerWorkspaceInvitationRoutes(app, invitations);
  registerWorkspaceHubRoutes(app, new WorkspaceHubStore(store.pool));
  registerTodoSyncRoutes(app, new TodoSyncStore(store.pool));

  app.get('/healthz', async () => {
    await store.health();
    return { status: 'ok' };
  });
  app.post('/v1/tasks', async (request, reply) => {
    const key = text(request.headers['idempotency-key'], 128);
    const task = await store.createTask(request.actorId, request.body, key);
    return reply.code(201).send(task);
  });
  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId', request =>
    store.readTask(request.actorId, uuid(request.params.taskId)));
  app.get<{ Params: { taskId: string }; Querystring: { after?: unknown } }>('/v1/tasks/:taskId/events', request => {
    const cursor = request.query.after ?? '0';
    if (typeof cursor !== 'string' || !/^\d+$/.test(cursor)) throw new AppError(400, 'invalid_cursor');
    return store.events(request.actorId, uuid(request.params.taskId), Number(cursor));
  });
  for (const action of ['approve', 'reject'] as const) {
    app.post<{ Params: { taskId: string } }>(`/v1/tasks/:taskId/${action}`, async request => {
      const id = uuid(request.params.taskId);
      await store.readTask(request.actorId, id);
      record(request.body, []);
      const task=action === 'approve' ? await store.approveTask(request.actorId, id) : await store.rejectTask(request.actorId, id);
      if(action==='approve' && task.status==='running')await immediate.dispatch(task.id);
      return task;
    });
  }
  app.post<{ Params: { taskId: string } }>('/v1/tasks/:taskId/control', async request => {
    await store.readTask(request.actorId, uuid(request.params.taskId));
    throw new AppError(409, 'control_unsupported');
  });
  app.get<{ Querystring: { workspace_id?: unknown } }>('/v1/agents/installations', request =>
    store.installations(request.actorId, uuid(request.query.workspace_id)));

  const chat = new ChatStore(store.pool);
  registerChatRoutes(app, chat);
  registerNavigatorRoutes(app, new NavigatorStore(store.pool));
  const memory = new MemoryStore(store.pool), memoryProviders = createMemoryProviders(options.memory);
  store.memoryReader = createAgentMemoryReader(memory, memoryProviders);
  registerMemoryRoutes(app, memory, memoryProviders);
  registerMemoryMcp(app, memory, memoryProviders, options.auth?.origins, process.env.MEMORY_MCP_ALLOWED_HOSTS?.split(',').map(host => host.trim()).filter(Boolean));
  const assets = new AssetStore(store.pool);
  registerAssetRoutes(app, assets, options.storage);
  const connections = new AgentConnectionStore(store.pool, { connectors: options.pairedConnectors });
  registerAgentConnectionRoutes(app, connections);
  const { io, onOutbox, getEvents, work, health, invalidate } = registerRealtime(app, authenticate, chat, { ...options.realtime, ...(options.auth ? { allowedOrigins: [...options.auth.origins], strictOrigins: true } : {}) });
  const immediate = directTurns(app,io,store,invalidate);
  registerAgentSessionRoutes(app,new AgentSessionStore(store.pool,store),immediate.accepted,immediate.stop);
  app.get('/readyz', async (_request, reply) => {
    try {
      const realtime = await health();
      return reply.code(realtime.ready ? 200 : 503).send({status:realtime.ready ? 'ready' : 'unavailable', realtime});
    } catch { return reply.code(503).send({status:'unavailable'}); }
  });
  registerCalling(app, io, new CallStore(store.pool), authenticate, getEvents, work, onOutbox);
  registerHuddles(app, new HuddleStore(store.pool), getEvents, options.huddles);
  registerAgentConnections(app, io, connections, store, onOutbox, getEvents, work);
  registerToolApprovals(app,io,new ToolApprovalStore(store.pool),connections,work,onOutbox,invalidate);
  registerSearch(app, new SearchStore(store.pool), getEvents, options.search);
  registerEventDeadlines(app, getEvents, store, assets, options.storage);
  registerWorkspaceRetention(app,getEvents,new WorkspaceRetentionStore(store.pool),options.storage);
  if(options.invitationEmail) registerInvitationEmailDelivery(app,getEvents,invitations,options.invitationEmail.mailer);
  return app;
}
