import { parseSidebarAssignment, uuid } from '@space/contracts';
import type { SidebarSectionStore } from '@space/postgres/sidebar-sections';
import type { FastifyInstance } from 'fastify';
import { expectedActor } from './expected-actor.js';

type Workspace = { workspaceId: string };
type Section = Workspace & { sectionId: string };

export function registerSidebarSectionRoutes(app: FastifyInstance, store: SidebarSectionStore) {
  const sections = '/v1/workspaces/:workspaceId/sidebar-sections';
  app.get<{ Params: Workspace }>(sections, request =>
    store.snapshot(expectedActor(request), uuid(request.params.workspaceId)));
  app.post<{ Params: Workspace }>(sections, async (request, reply) =>
    reply.code(201).send(await store.create(expectedActor(request), uuid(request.params.workspaceId), request.body)));
  app.patch<{ Params: Section }>(`${sections}/:sectionId`, request =>
    store.update(expectedActor(request), uuid(request.params.workspaceId), uuid(request.params.sectionId), request.body));
  app.delete<{ Params: Section }>(`${sections}/:sectionId`, request =>
    store.remove(expectedActor(request), uuid(request.params.workspaceId), uuid(request.params.sectionId)));
  app.put<{ Params: Workspace & { channelId: string } }>('/v1/workspaces/:workspaceId/sidebar-section-assignments/:channelId', request =>
    store.move(expectedActor(request), uuid(request.params.workspaceId), uuid(request.params.channelId), parseSidebarAssignment(request.body)));
}
