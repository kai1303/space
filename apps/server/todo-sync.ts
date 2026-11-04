import type { FastifyInstance } from 'fastify';
import type { TodoSyncStore } from '@space/postgres/todo-sync';

export const TODO_SYNC_PATH='/v1/todo-sync/:sourceId/items';
export function registerTodoSyncRoutes(app: FastifyInstance, store: TodoSyncStore) {
  const base='/v1/workspaces/:workspaceId/hub/todo-sources';
  type Owner={Params:{workspaceId:string;sourceId:string}};
  app.get<Owner>(base,r=>store.sources(r.actorId,r.params.workspaceId,r.query));
  app.post<Owner>(`${base}/:sourceId`,async(r,reply)=>reply.code(201).send(await store.credentials(r.actorId,r.params.workspaceId,r.params.sourceId,'create',r.body)));
  for(const [path,action] of [['token','rotate'],['revoke','revoke']] as const) {
    app.post<Owner>(`${base}/:sourceId/${path}`,r=>store.credentials(r.actorId,r.params.workspaceId,r.params.sourceId,action,r.body));
  }
  const bearer=(authorization:string|undefined)=>authorization?.startsWith('Bearer ')?authorization.slice(7):undefined;
  app.post<{Params:{sourceId:string}}>(TODO_SYNC_PATH,r=>store.sync(r.params.sourceId,bearer(r.headers.authorization),r.body));
  app.get<{Params:{sourceId:string}}>(TODO_SYNC_PATH,r=>store.receipts(r.params.sourceId,bearer(r.headers.authorization),r.query));
}
