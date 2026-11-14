import type { FastifyInstance } from 'fastify';
import { expectedActor } from './expected-actor.js';
import { uuid } from '@space/contracts';
import type { WorkspaceHubStore } from '@space/postgres/workspace-hub';

export function registerWorkspaceHubRoutes(app: FastifyInstance, store: WorkspaceHubStore) {
  const base = '/v1/workspaces/:workspaceId/hub';
  app.post<{ Params: { workspaceId: string; threadId: string } }>(`${base}/threads/:threadId/read`, r =>
    store.readThread(expectedActor(r), r.params.workspaceId, r.params.threadId, r.body));
  app.get<{ Params: { workspaceId:string; threadId:string } }>(`${base}/threads/:threadId/replies`, r =>
    store.earlierThreadReplies(expectedActor(r),r.params.workspaceId,r.params.threadId,r.query));
  app.post<{ Params: { workspaceId:string; threadId:string } }>(`${base}/threads/:threadId/unread`, r =>
    store.markThreadUnread(expectedActor(r),r.params.workspaceId,r.params.threadId,r.body));
  app.get<{ Params: { workspaceId: string } }>(`${base}/starred-sessions`, r => store.starredSessions(r.actorId, uuid(r.params.workspaceId), r.query));
  app.get<{ Params: { workspaceId: string; sessionId: string } }>(`${base}/starred-sessions/:sessionId`, r => store.sessionStarState(r.actorId, uuid(r.params.workspaceId), uuid(r.params.sessionId)));
  app.post<{ Params: { workspaceId: string; sessionId: string } }>(`${base}/starred-sessions/:sessionId`, r => store.starSession(r.actorId, uuid(r.params.workspaceId), uuid(r.params.sessionId), r.body));
  for (const view of ['threads', 'sent', 'saved'] as const) {
    app.get<{ Params: { workspaceId: string } }>(`${base}/${view}`, r => store.messages(r.actorId, uuid(r.params.workspaceId), view, r.query));
  }
  for (const view of ['files', 'todos', 'starred'] as const) {
    app.get<{ Params: { workspaceId: string } }>(`${base}/${view}`, r => store[view](r.actorId, uuid(r.params.workspaceId), r.query));
  }
  for (const action of ['star', 'view'] as const) {
  app.post<{ Params: { workspaceId: string; id: string } }>(`${base}/files/:id/${action}`, r => store.fileState(r.actorId, uuid(r.params.workspaceId), uuid(r.params.id), action, r.body));
  }
  app.post<{ Params: { workspaceId: string } }>(`${base}/todos/cleanup`, r => store.cleanupTodos(r.actorId, uuid(r.params.workspaceId), r.body));
  app.get<{ Params: { workspaceId: string; id: string } }>(`${base}/todos/:id`, r => store.todoDetail(r.actorId, uuid(r.params.workspaceId), uuid(r.params.id)));
  app.post<{ Params: { workspaceId: string; id: string } }>(`${base}/todos/:id`, r => store.todo(r.actorId, uuid(r.params.workspaceId), uuid(r.params.id), r.body));
  app.post<{ Params:{workspaceId:string;channelId:string} }>(`${base}/saved/state/:channelId`, r=>store.savedState(expectedActor(r),uuid(r.params.workspaceId),uuid(r.params.channelId),r.body));
  app.post<{ Params:{workspaceId:string} }>(`${base}/saved/cleanup`, r=>store.cleanupSaved(expectedActor(r),uuid(r.params.workspaceId),r.body));
  app.post<{ Params: { workspaceId: string; messageId: string } }>(`${base}/saved/:messageId`, r => store.saved(expectedActor(r), uuid(r.params.workspaceId), uuid(r.params.messageId), r.body));
  app.get<{ Params: { workspaceId: string; channelId: string } }>('/v1/workspaces/:workspaceId/hub/starred/:channelId', r => store.starState(r.actorId, uuid(r.params.workspaceId), uuid(r.params.channelId)));
  app.post<{ Params: { workspaceId: string; channelId: string } }>(`${base}/starred/:channelId`, r => store.star(r.actorId, uuid(r.params.workspaceId), uuid(r.params.channelId), r.body));
}
