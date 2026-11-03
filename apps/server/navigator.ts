import type { FastifyInstance } from 'fastify';
import { record, text, uuid } from '@space/contracts';
import type { NavigatorStore } from '@space/postgres/navigator';
export function registerNavigatorRoutes(app:FastifyInstance,store:NavigatorStore) {
 app.get<{Params:{channelId:string}}>('/v1/channels/:channelId/navigator',r=>store.read(r.actorId,uuid(r.params.channelId)));
 app.patch<{Params:{channelId:string}}>('/v1/channels/:channelId/navigator',r=>store.configure(r.actorId,uuid(r.params.channelId),r.body));
 app.get<{Params:{channelId:string};Querystring:{thread_id?:unknown}}>('/v1/channels/:channelId/navigator/suggestions',r=>{const query=record(r.query,['thread_id']);return store.suggestions(r.actorId,uuid(r.params.channelId),query.thread_id===undefined?undefined:uuid(query.thread_id));});
 app.post<{Params:{id:string}}>('/v1/navigator/suggestions/:id/accept',r=>{const v=record(r.body,['installation_id','skill']);return store.accept(r.actorId,uuid(r.params.id),uuid(v.installation_id),text(v.skill,80));});
 app.post<{Params:{id:string}}>('/v1/navigator/suggestions/:id/dismiss',async(r,reply)=>{record(r.body,[]);await store.dismiss(r.actorId,uuid(r.params.id));return reply.code(204).send();});
 app.get<{Params:{id:string}}>('/v1/threads/:id/agent-subscription',r=>store.subscription(r.actorId,uuid(r.params.id)));
 app.post<{Params:{id:string}}>('/v1/threads/:id/agent-subscription/close',async(r,reply)=>{record(r.body,[]);await store.closeSubscription(r.actorId,uuid(r.params.id));return reply.code(204).send();});
}
