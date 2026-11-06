import {randomUUID} from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { EventBus } from '@space/events';
import { AppError, record, uuid, HUDDLE_CAPACITY, type HuddleAdmission } from '@space/contracts';
import { HuddleStore } from '@space/postgres/huddles';
import { RealtimeWork } from './realtime-work.js';
import type { HuddleMedia } from './huddle-media.js';

export const HUDDLE_WEBHOOK='/v1/huddles/webhook';
export class HuddleService {
 constructor(readonly store:HuddleStore,readonly media:HuddleMedia){}
 async provision(id:string):Promise<void> {
  const h=await this.store.raw(id);
  if(!h||h.state==='ended'){await this.media.remove(id);return;}
  if(h.state==='active')return;
  await this.media.create(id);
  await this.store.ready(id);
  // A concurrent revocation must never resurrect this room, including on redelivery after a crash.
  if((await this.store.raw(id))?.state!=='active')await this.media.remove(id);
 }
 async join(actor:string,channel:string):Promise<HuddleAdmission> {
  const h=await this.store.start(actor,channel);
  await this.provision(h.id);
  if(!await this.media.exists(h.id)){await this.store.end(h.id);throw new AppError(409,'huddle_ended');}
  const token=await this.media.token(h.id,actor,await this.store.name(actor));
  const current=await this.store.current(actor,channel);
  if(current?.id!==h.id||current.state!=='active')throw new AppError(409,'huddle_ended');
  return {huddle:current,url:this.media.url,token};
 }
}

export function registerHuddles(app:FastifyInstance,store:HuddleStore,getEvents:()=>Promise<EventBus>,media?:HuddleMedia) {
 const work=new RealtimeWork(4,32),service=media?new HuddleService(store,media):undefined;
 const enabled=()=>{if(!service)throw new AppError(503,'huddles_unavailable');return service;};
 app.get('/v1/huddles/config',async()=>({enabled:!!media,capacity:HUDDLE_CAPACITY}));
 app.get<{Params:{workspaceId:string};Querystring:{after?:string}}>('/v1/workspaces/:workspaceId/huddles',r=>{
  enabled();return store.list(r.actorId,uuid(r.params.workspaceId),r.query.after?uuid(r.query.after):undefined);
 });
 app.get<{Params:{channelId:string}}>('/v1/channels/:channelId/huddle',r=>{enabled();return store.current(r.actorId,uuid(r.params.channelId));});
 app.post<{Params:{channelId:string}}>('/v1/channels/:channelId/huddle/join',r=>{
  record(r.body,[]);return work.run(r.actorId,()=>enabled().join(r.actorId,uuid(r.params.channelId)));
 });
 // LiveKit signs the exact request bytes, independently of Space cookies.
 app.register(async hooks=>{
  hooks.addContentTypeParser('application/webhook+json',{parseAs:'string'},(_req,body,done)=>done(null,body));
  hooks.post(HUDDLE_WEBHOOK,async r=>{
   enabled();if(typeof r.body!=='string')throw new AppError(400,'invalid_webhook');
   let event;
   try{event=await media!.webhook(r.body,r.headers.authorization);}catch{throw new AppError(401,'invalid_webhook');}
   const match=/^space-huddle-([0-9a-f-]{36})$/.exec(event.room?.name??'');
   // Terminal updates are monotone and idempotent, so duplicate or reordered callbacks cannot reopen a room.
   if(event.event==='room_finished'&&match)await store.end(uuid(match[1]));
   return {ok:true};
  });
 });
 let stop:(()=>Promise<void>)|undefined;
 if(service)app.addHook('onReady',async()=>{
  const bus=await getEvents();
  stop=await bus.subscribe('huddle.*.*',{durable:'channel-huddles',queue:'channel-huddles',maxPending:4},async delivery=>{
   const at=Date.parse(delivery.event.available_at??'');
   if(at>Date.now()){await delivery.retry(at-Date.now());return;}
   const id=uuid(delivery.event.aggregate_id);
   try{
    if(delivery.event.kind==='huddle.provision')await service.provision(id);
    else if(delivery.event.kind==='huddle.close')await media!.remove(id);
    await delivery.ack();
   }catch{
    const attempts=Number(delivery.event.data.attempts??0)+1;
    if(attempts>=8){
     // Retain exhausted obligations in the durable WORK stream for operator replay.
     await bus.publish({id:randomUUID(),schema:delivery.event.schema,kind:'huddle_failure',aggregate_id:id,
      data:{operation:delivery.event.kind,attempts,original_event_id:delivery.event.id}});
     app.log.error({huddleId:id,operation:delivery.event.kind},'huddle_media_retry_exhausted');
     await delivery.ack();
    }else{delivery.event.data.attempts=attempts;await delivery.retry(30_000);}
   }
  });
 });
 app.addHook('preClose',async()=>{await stop?.();});
}
