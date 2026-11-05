import { registerReplySuggestions } from './reply-suggestions.js';
import type { FastifyInstance } from 'fastify';
import { record, uuid } from '@space/contracts';
import type { ChatStore } from '@space/postgres/chat';

export function registerChatRoutes(app: FastifyInstance, chat: ChatStore) {
  registerReplySuggestions(app, chat);
  app.get<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/notifications', r => chat.notifications.activity(r.actorId, uuid(r.params.workspaceId), r.query));
  app.patch<{ Params: { workspaceId: string; id: string } }>('/v1/workspaces/:workspaceId/notifications/:id', r => chat.notifications.markRead(r.actorId, uuid(r.params.workspaceId), r.params.id, r.body));
  app.post<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/notifications/read', r => chat.notifications.markAllRead(r.actorId, uuid(r.params.workspaceId), r.body));
  app.post<{ Params: { workspaceId: string; id: string } }>('/v1/workspaces/:workspaceId/notifications/:id/claim', r => chat.notifications.claim(r.actorId, uuid(r.params.workspaceId), r.params.id, r.body));
  app.get<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/notification-settings', r => chat.notifications.settings(r.actorId, uuid(r.params.workspaceId)));
  app.patch<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/notification-settings', r => chat.notifications.updateSettings(r.actorId, uuid(r.params.workspaceId), r.body));
  app.get<{ Params: { threadId: string } }>('/v1/threads/:threadId/notification-subscription', r => chat.notifications.subscription(r.actorId, uuid(r.params.threadId)));
  app.patch<{ Params: { threadId: string } }>('/v1/threads/:threadId/notification-subscription', r => chat.notifications.subscription(r.actorId, uuid(r.params.threadId), record(r.body, ['following'])));

  app.get<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/direct-messages', r => chat.directMessages.list(r.actorId, uuid(r.params.workspaceId), r.query));
  app.post<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/direct-messages', r => chat.directMessages.open(r.actorId, uuid(r.params.workspaceId), r.body));
  app.get<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/direct-message-people', r => chat.directMessages.people(r.actorId, uuid(r.params.workspaceId), r.query));
  app.patch<{ Params: { channelId: string } }>('/v1/channels/:channelId/direct-message', r => chat.directMessages.visibility(r.actorId, uuid(r.params.channelId), r.body));
  app.get<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/unread', r => chat.unread.summary(r.actorId, uuid(r.params.workspaceId)));
  app.post<{ Params: { channelId: string } }>('/v1/channels/:channelId/read', r => chat.unread.markRead(r.actorId, uuid(r.params.channelId), r.body));
  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/mentions', r => chat.mentions.search(r.actorId, uuid(r.params.channelId), r.query));
  app.get<{ Params: { channelId: string; kind: string; id: string } }>('/v1/channels/:channelId/mentions/:kind/:id', r => chat.mentions.detail(r.actorId, uuid(r.params.channelId), r.params.kind, r.params.id));
  app.get<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/mention-settings', r => chat.mentions.settings(r.actorId, uuid(r.params.workspaceId)));
  app.patch<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/mention-settings', r => chat.mentions.updateSettings(r.actorId, uuid(r.params.workspaceId), r.body));
  app.get<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/mentions', r => chat.mentions.activity(r.actorId, uuid(r.params.workspaceId), r.query));
  app.post<{ Params: { workspaceId: string; id: string } }>('/v1/workspaces/:workspaceId/mentions/:id/read', r => { record(r.body, []); return chat.mentions.markRead(r.actorId, uuid(r.params.workspaceId), r.params.id); });

  app.get<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/channels', r => chat.channels(r.actorId, uuid(r.params.workspaceId), r.query));
  app.post<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/channels', async (r, reply) => reply.code(201).send(await chat.createChannel(r.actorId, uuid(r.params.workspaceId), r.body)));
  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId', r => chat.details(r.actorId, uuid(r.params.channelId)));
  app.patch<{ Params: { channelId: string } }>('/v1/channels/:channelId', r => chat.updateChannel(r.actorId, uuid(r.params.channelId), r.body));
  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/members', r => chat.members(r.actorId, uuid(r.params.channelId), r.query));
  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/history', r => chat.history(r.actorId, uuid(r.params.channelId), r.query));
  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/messages', r => chat.messageHistory(r.actorId, uuid(r.params.channelId), r.query));
  app.get<{ Params: { channelId: string; messageId: string } }>('/v1/channels/:channelId/messages/:messageId', r => chat.sourceMessage(r.actorId, uuid(r.params.channelId), uuid(r.params.messageId)));
  app.post<{ Params: { channelId: string } }>('/v1/channels/:channelId/messages', { bodyLimit: 131072 }, async (r, reply) => reply.code(201).send(await chat.send(r.actorId, uuid(r.params.channelId), r.body)));
  app.post<{ Params: { channelId: string; messageId: string } }>('/v1/channels/:channelId/messages/:messageId/reactions', r => chat.react(r.actorId, uuid(r.params.channelId), uuid(r.params.messageId), r.body));
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
