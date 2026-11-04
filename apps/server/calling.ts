import type {FastifyInstance} from 'fastify';
import type {Server,Socket} from 'socket.io';
import type {IncomingHttpHeaders} from 'node:http';
import {AppError,record,uuid,parseCallStart,parseCallSignal,type CallSignal,type DmCall,type CallSession} from '@space/contracts';
import type {CallStore} from '@space/postgres/calling';
import type {EventBus} from '@space/events';
import type {RealtimeWork} from './realtime-work.js';
import {callIceConfig} from './calling-config.js';

function publicCall(call:DmCall|null,actor:string,device?:string):CallSession|null {
 if(!call)return null;
 const {caller_device,callee_device,...data}=call;
 return {...data,selected:!!device&&(actor===call.caller_id?caller_device:callee_device)===device};
}
type Envelope={actor:string;device:string;from:string;expires:number;signal:CallSignal};
export function registerCalling(app:FastifyInstance,io:Server,store:CallStore,authenticate:(headers:IncomingHttpHeaders,token?:unknown)=>Promise<string>,getEvents:()=>Promise<EventBus>,work:RealtimeWork,onOutbox:(listener:(keys?:readonly string[])=>void)=>()=>void){
 // Validate deployment config before accepting calls, without exposing the shared TURN secret.
 callIceConfig('configuration');
 app.get<{Params:{channelId:string}}>('/v1/channels/:channelId/calls',async r=>(await store.history(r.actorId,uuid(r.params.channelId))).map(call=>publicCall(call,r.actorId)));
 const listeners=new Map<string,Set<(envelope:Envelope)=>void>>();
 let bus:EventBus,stopSignals:(()=>void)|undefined,stopReconnect:(()=>void)|undefined,stopDeadlines:(()=>Promise<void>)|undefined;
 app.addHook('onReady',async()=>{
  bus=await getEvents();
  stopSignals=await bus.subscribeTransient('call.*',value=>{
   const e=value as Envelope;
   if(!e||typeof e.actor!=='string'||typeof e.device!=='string'||!Number.isFinite(e.expires)||e.expires<Date.now())return;
   for(const receive of listeners.get(e.actor)??[])receive(e);
  });
  stopReconnect=bus.onReconnect(()=>io.local.emit('call.reconnect'));
  stopDeadlines=await bus.subscribe('call.deadline.*',{durable:'call-deadlines',queue:'call-deadlines',maxPending:4},async delivery=>{
   const at=Date.parse(delivery.event.available_at??'');
   if(Number.isFinite(at)&&at>Date.now()){await delivery.retry(at-Date.now());return;}
   await store.expire(uuid(delivery.event.aggregate_id));await delivery.ack();
  });
 });
 app.addHook('preClose',async()=>{stopSignals?.();stopReconnect?.();await stopDeadlines?.();});
 io.on('connection',(socket:Socket)=>{
  const actor=socket.data.actor as string;
  let device:string|undefined,lastId:string|undefined,latest:DmCall|null=null,serialized='',running=false,pending=false;
  let command=false,windowAt=Date.now(),commands=0,signals=0;
  const auth=async()=>{if(await authenticate(socket.handshake.headers,socket.data.token)!==actor)throw new AppError(401,'unauthorized');};
  const fail=(error:unknown)=>{
   if(!socket.connected)return;
   socket.emit('call.error',{error:error instanceof AppError?error.code:'call_unavailable'});
   if(error instanceof AppError&&error.status===401){socket.emit('chat.error',{error:'unauthorized'});socket.disconnect(true);}
  };
  const refresh=()=>{
   if(!device||!socket.connected)return;
   pending=true;if(running)return;running=true;
   void (async()=>{
    while(pending&&socket.connected){pending=false;
     const call=await work.run(socket.id,async()=>{await auth();return store.snapshot(actor,lastId);});
     if(!socket.connected)return;
     latest=call;if(call)lastId=call.id;
     const visible=publicCall(call,actor,device);const value=JSON.stringify(visible);
     if(value!==serialized){serialized=value;socket.emit('call.state',{call:visible});}
    }
   })().catch(fail).finally(()=>{running=false;});
  };
  const stopOutbox=onOutbox(keys=>{
   if(!keys||keys.some(key=>key==='global'||key===`call-user:${actor}`||key===`actor:${actor}`||key===`workspace:${latest?.workspace_id}`))refresh();
  });
  const receive=(e:Envelope)=>{
   if(e.device!==device||!socket.connected||e.expires<Date.now())return;
   // Recheck receiver access at delivery, including revocation racing the sender's validation.
   void work.run(socket.id,async()=>{
    await auth();const signal=parseCallSignal(e.signal);const endpoint=await store.endpoint(actor,signal.call_id,device!);
    if(endpoint.peer_id!==e.from||e.expires<Date.now()||!socket.connected)return;
    socket.emit('call.signal',signal);
   }).catch(error=>{if(error instanceof AppError&&error.status===401)fail(error);});
  };
  const recipients=listeners.get(actor)??new Set();recipients.add(receive);listeners.set(actor,recipients);
  socket.on('disconnect',()=>{stopOutbox();recipients.delete(receive);if(!recipients.size)listeners.delete(actor);});
  const handle=(name:string,action:(input:unknown)=>Promise<unknown>)=>socket.on(name,async(input:unknown,ack:unknown)=>{
   if(typeof ack!=='function')return;
   if(Date.now()-windowAt>=10000){windowAt=Date.now();commands=0;signals=0;}
   if(command||(name==='call.signal'?++signals>256:++commands>40)){ack({error:'call_rate_limit'});return;}
   command=true;
   try{const data=await work.run(socket.id,async()=>{await auth();if(!socket.connected)throw new AppError(409,'connection_closed');return action(input);});if(socket.connected)ack({data});}
   catch(error){ack({error:error instanceof AppError?error.code:'call_unavailable'});if(error instanceof AppError&&error.status===401)fail(error);}
   finally{command=false;}
  });
  handle('call.subscribe',async input=>{
   const v=record(input,['device_id','call_id']);const next=uuid(v.device_id);
   if(device&&device!==next)throw new AppError(409,'call_other_device');
   device=next;if(v.call_id)lastId=uuid(v.call_id);
   latest=await store.snapshot(actor,lastId);if(latest)lastId=latest.id;
   serialized=JSON.stringify(publicCall(latest,actor,device));refresh();
   return {call:publicCall(latest,actor,device),config:callIceConfig(actor)};
  });
  const requireDevice=()=>{if(!device)throw new AppError(409,'call_subscribe_required');return device;};
  handle('call.ice',async input=>{record(input,[]);requireDevice();return callIceConfig(actor);});
  handle('call.start',async input=>{
   const v=parseCallStart(input);if(v.device_id!==requireDevice())throw new AppError(409,'call_other_device');
   const call=await store.start(actor,v);lastId=call.id;refresh();return publicCall(call,actor,device);
  });
  handle('call.accept',async input=>{
   const v=record(input,['call_id']);const call=await store.accept(actor,uuid(v.call_id),requireDevice());lastId=call.id;refresh();return publicCall(call,actor,device);
  });
  handle('call.end',async input=>{
   const v=record(input,['call_id','failed']);if(v.failed!==undefined&&typeof v.failed!=='boolean')throw new AppError(400,'invalid_call_reason');
   const call=await store.end(actor,uuid(v.call_id),requireDevice(),v.failed?'failed':'completed');refresh();return publicCall(call,actor,device);
  });
  handle('call.heartbeat',async input=>{const v=record(input,['call_id']);await store.heartbeat(actor,uuid(v.call_id),requireDevice());return {};});
  handle('call.signal',async input=>{
   const signal=parseCallSignal(input),endpoint=await store.endpoint(actor,signal.call_id,requireDevice());
   bus.publishTransient(`call.${endpoint.peer_id}`,{actor:endpoint.peer_id,device:endpoint.peer_device,from:actor,expires:Date.now()+10000,signal} satisfies Envelope);
   return {};
  });
 });
}
