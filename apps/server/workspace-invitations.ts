import type { FastifyInstance } from 'fastify';
import { uuid } from '@space/contracts';
import type { WorkspaceInvitationStore } from '@space/postgres/workspace-invitations';

export function registerWorkspaceInvitationRoutes(app: FastifyInstance, store: WorkspaceInvitationStore) {
  type Workspace = {workspaceId:string};
  type Invitation = Workspace & {invitationId:string};
  app.get<{Params:Workspace}>('/v1/workspaces/:workspaceId/invitations',request=>store.list(request.actorId,uuid(request.params.workspaceId),request.query));
  app.post<{Params:Workspace}>('/v1/workspaces/:workspaceId/invitations',{bodyLimit:20_000},async(request,reply)=>reply.code(201).send(await store.create(request.actorId,uuid(request.params.workspaceId),request.body)));
  app.post<{Params:Invitation}>('/v1/workspaces/:workspaceId/invitations/:invitationId/resend',{bodyLimit:1024},request=>store.resend(request.actorId,uuid(request.params.workspaceId),uuid(request.params.invitationId),request.body));
  app.delete<{Params:Invitation}>('/v1/workspaces/:workspaceId/invitations/:invitationId',async(request,reply)=>{
    await store.revoke(request.actorId,uuid(request.params.workspaceId),uuid(request.params.invitationId));return reply.code(204).send();
  });
  app.get<{Params:{token:string}}>('/v1/invitations/:token',request=>store.preview(request.actorId,request.params.token));
  app.post<{Params:{token:string}}>('/v1/invitations/:token/accept',{bodyLimit:1024},request=>store.accept(request.actorId,request.params.token));
}
