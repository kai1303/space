import type { FastifyInstance } from 'fastify';
import { uuid } from '@space/contracts';
import type { WorkspaceSettingsStore } from '@space/postgres/workspace-settings';

export function registerWorkspaceSettingsRoutes(app: FastifyInstance, store: WorkspaceSettingsStore) {
  app.get<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/settings', request => store.read(request.actorId, uuid(request.params.workspaceId)));
  app.patch<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/settings', {bodyLimit:220_000}, request => store.update(request.actorId, uuid(request.params.workspaceId), request.body));
  app.get<{ Params: { slug: string } }>('/v1/workspaces/by-slug/:slug', request => store.resolveSlug(request.actorId, request.params.slug));
  app.post<{ Params: { slug: string } }>('/v1/workspaces/by-slug/:slug/join', request => store.joinByDomain(request.actorId, request.params.slug));
}
