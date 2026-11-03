import type { FastifyInstance } from 'fastify';
import { record, uuid } from '@space/contracts';
import type { ChatStore } from '@space/postgres/chat';

export function registerChatRoutes(app: FastifyInstance, chat: ChatStore) {
  app.get<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/channels', r => chat.channels(r.actorId, uuid(r.params.workspaceId), r.query));
  app.post<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/channels', async (r, reply) => reply.code(201).send(await chat.createChannel(r.actorId, uuid(r.params.workspaceId), r.body)));
  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId', r => chat.details(r.actorId, uuid(r.params.channelId)));
  app.patch<{ Params: { channelId: string } }>('/v1/channels/:channelId', r => chat.updateChannel(r.actorId, uuid(r.params.channelId), r.body));
  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/members', r => chat.members(r.actorId, uuid(r.params.channelId), r.query));
  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/history', r => chat.history(r.actorId, uuid(r.params.channelId), r.query));
  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/messages', r => chat.messageHistory(r.actorId, uuid(r.params.channelId), r.query));
  app.post<{ Params: { channelId: string } }>('/v1/channels/:channelId/messages', { bodyLimit: 131072 }, async (r, reply) => reply.code(201).send(await chat.send(r.actorId, uuid(r.params.channelId), r.body)));
  app.post<{ Params: { channelId: string } }>('/v1/channels/:channelId/join', r => {
    record(r.body, []);
    return chat.join(r.actorId, uuid(r.params.channelId));
  });
  app.post<{ Params: { channelId: string } }>('/v1/channels/:channelId/members', async (r, reply) => reply.code(201).send(await chat.addMember(r.actorId, uuid(r.params.channelId), r.body)));
  app.delete<{ Params: { channelId: string; userId: string } }>('/v1/channels/:channelId/members/:userId', async (r, reply) => {
    await chat.removeMember(r.actorId, uuid(r.params.channelId), uuid(r.params.userId));
    return reply.code(204).send();
  });
  app.get<{ Params: { threadId: string } }>('/v1/threads/:threadId/history', r => chat.threadHistory(r.actorId, uuid(r.params.threadId), r.query));
  app.get<{ Params: { threadId: string } }>('/v1/threads/:threadId/messages', r => chat.threadMessages(r.actorId, uuid(r.params.threadId), r.query));
}
