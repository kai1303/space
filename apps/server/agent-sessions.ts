import type { FastifyInstance } from 'fastify';
import { record, text, uuid } from '@space/contracts';
import type { AgentSessionStore } from '@space/postgres/agent-sessions';
export function registerAgentSessionRoutes(app: FastifyInstance, sessions: AgentSessionStore) {
  app.get<{ Params: { threadId: string } }>('/v1/threads/:threadId/agent-sessions', request => sessions.list(request.actorId, uuid(request.params.threadId)));
  app.post<{ Params: { threadId: string } }>('/v1/threads/:threadId/agent-sessions', async (request, reply) => reply.code(201).send(await sessions.create(request.actorId, uuid(request.params.threadId), request.body)));
  app.get<{ Params: { sessionId: string } }>('/v1/agent-sessions/:sessionId', request => sessions.read(request.actorId, uuid(request.params.sessionId), request.query));
  app.post<{ Params: { sessionId: string } }>('/v1/agent-sessions/:sessionId/messages', async (request, reply) => reply.code(201).send(await sessions.send(request.actorId, uuid(request.params.sessionId), request.body, text(request.headers['idempotency-key'], 128))));
  for (const operation of ['stop', 'end'] as const) app.post<{ Params: { sessionId: string } }>(`/v1/agent-sessions/:sessionId/${operation}`, request => {
    record(request.body, []);
    return sessions.control(request.actorId, uuid(request.params.sessionId), operation);
  });
}
