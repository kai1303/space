import type { FastifyInstance } from 'fastify';
import { uuid } from '@space/contracts';
import type { ScheduledMessageStore } from '@space/postgres/scheduled-messages';

// Scheduled sends, like Slack. The schedule id is chosen by the client so a retried request is idempotent.
export function registerScheduledMessageRoutes(app: FastifyInstance, scheduled: ScheduledMessageStore) {
  app.post<{ Params: { channelId: string } }>('/v1/channels/:channelId/scheduled-messages', { bodyLimit: 131072 }, async (r, reply) =>
    reply.code(201).send(await scheduled.schedule(r.actorId, uuid(r.params.channelId), r.body)));
  app.get<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/scheduled-messages', r =>
    scheduled.list(r.actorId, uuid(r.params.workspaceId)));
  app.patch<{ Params: { id: string } }>('/v1/scheduled-messages/:id', r => scheduled.reschedule(r.actorId, uuid(r.params.id), r.body));
  app.post<{ Params: { id: string } }>('/v1/scheduled-messages/:id/send', r => scheduled.sendNow(r.actorId, uuid(r.params.id)));
  app.delete<{ Params: { id: string } }>('/v1/scheduled-messages/:id', r => scheduled.cancel(r.actorId, uuid(r.params.id)));
}
