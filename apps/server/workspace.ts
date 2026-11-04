import type { FastifyInstance } from 'fastify';
import { uuid } from '@space/contracts';
import { WorkspaceStore } from '@space/postgres/workspace';
import { UserStore } from '@space/postgres/users';

export function registerWorkspaceRoutes(app: FastifyInstance, store: WorkspaceStore) {
  const users = new UserStore(store.pool);
  app.get('/v1/me', request => users.profile(request.actorId));
  app.patch('/v1/me', { bodyLimit: 220_000 }, request => users.updateProfile(request.actorId, request.body));
  app.post('/v1/workspaces', async (request, reply) =>
    reply.code(201).send(await store.create(request.actorId, request.body)));
  app.get('/v1/workspaces', request => store.list(request.actorId, request.query));
  app.get<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId', request =>
    store.read(request.actorId, uuid(request.params.workspaceId)));
  app.patch<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId', request =>
    store.rename(request.actorId, uuid(request.params.workspaceId), request.body));
  app.get<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/members', request =>
    store.members(request.actorId, uuid(request.params.workspaceId), request.query));
  app.get<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/directory', request =>
    store.directory(request.actorId, uuid(request.params.workspaceId), request.query));
  app.post<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/transfer-ownership', request => store.transferOwnership(request.actorId, uuid(request.params.workspaceId), request.body));
  app.get<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/members.csv', async (request,reply) => reply.type('text/csv; charset=utf-8').header('content-disposition','attachment; filename=workspace-members.csv').send(await store.exportMembers(request.actorId,uuid(request.params.workspaceId))));
  app.post<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/members', async (request, reply) =>
    reply.code(201).send(await store.addMember(request.actorId, uuid(request.params.workspaceId), request.body)));
  app.patch<{ Params: { workspaceId: string; userId: string } }>('/v1/workspaces/:workspaceId/members/:userId', request =>
    store.changeRole(request.actorId, uuid(request.params.workspaceId), uuid(request.params.userId), request.body));
  app.delete<{ Params: { workspaceId: string; userId: string } }>('/v1/workspaces/:workspaceId/members/:userId', async (request, reply) => {
    await store.removeMember(request.actorId, uuid(request.params.workspaceId), uuid(request.params.userId));
    return reply.code(204).send();
  });
}
