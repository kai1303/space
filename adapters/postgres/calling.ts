import type {Pool} from 'pg';
import {sql} from 'drizzle-orm';
import {AppError,parseCallStart,uuid,type DmCall,type CallReason} from '@space/contracts';
import {database,type DbSession} from './database.js';
import {hasChannelAccess} from './access.js';
import {sessionTransaction} from './session-concurrency.js';

const fields=sql`c.*,a.display_name AS caller_name,b.display_name AS callee_name,
 c.created_at::text,c.accepted_at::text,c.ended_at::text`;
export class CallStore {
 readonly db;
 constructor(readonly pool:Pool){this.db=database(pool);}
 private async channel(c:DbSession,actor:string,id:string,both=false){
  const ch=(await c.execute<{workspace_id:string;direct_user_low:string;direct_user_high:string}>(sql`SELECT workspace_id,direct_user_low,direct_user_high FROM channels WHERE id=${uuid(id)} AND kind='direct' AND direct_user_low<>direct_user_high`)).rows[0];
  if(!ch||![ch.direct_user_low,ch.direct_user_high].includes(actor)||!await hasChannelAccess(c,actor,ch.workspace_id,id))throw new AppError(404,'not_found');
  if(both&&(!await hasChannelAccess(c,ch.direct_user_low,ch.workspace_id,id)||!await hasChannelAccess(c,ch.direct_user_high,ch.workspace_id,id)))throw new AppError(409,'call_unavailable');
  return ch;
 }
 private async row(c:DbSession,actor:string,id:string):Promise<DmCall>{
  const row=(await c.execute<DmCall & Record<string,unknown>>(sql`SELECT ${fields} FROM dm_calls c JOIN users a ON a.id=c.caller_id JOIN users b ON b.id=c.callee_id WHERE c.id=${uuid(id)} AND ${uuid(actor)} IN (c.caller_id,c.callee_id)`)).rows[0];
  if(!row)throw new AppError(404,'not_found');
  await this.channel(c,actor,row.channel_id);
  return row;
 }
 read(actor:string,id:string){return this.row(this.db,actor,id);}
 async start(actor:string,input:unknown){
  const v=parseCallStart(input);
  return sessionTransaction(this.db,async c=>{
   const ch=await this.channel(c,actor,v.channel_id,true);
   const existing=(await c.execute(sql`SELECT id FROM dm_calls WHERE id=${v.id}`)).rows[0];
   if(existing){const call=await this.row(c,actor,v.id);if(call.caller_id!==actor||call.channel_id!==v.channel_id||call.mode!==v.mode||call.caller_device!==v.device_id)throw new AppError(409,'call_conflict');return call;}
   const peer=ch.direct_user_low===actor?ch.direct_user_high:ch.direct_user_low;
   // Conditional writes order admission against concurrent membership revocation, including READ COMMITTED administrators.
   const members=await c.execute(sql`UPDATE workspace_members SET active=active WHERE workspace_id=${ch.workspace_id} AND user_id IN (${actor},${peer}) AND active RETURNING user_id`);
   if(members.rows.length!==2)throw new AppError(409,'call_unavailable');
   if((await c.execute(sql`SELECT 1 FROM dm_call_participants WHERE user_id IN (${actor},${peer})`)).rows.length)throw new AppError(409,'call_busy');
   // Prevent a single caller creating unbounded ringing/deadline traffic.
   if((await c.execute(sql`SELECT 1 FROM dm_calls WHERE caller_id=${actor} AND created_at>now()-interval '1 minute' LIMIT 1 OFFSET 9`)).rows.length)throw new AppError(429,'call_rate_limit');
   await c.execute(sql`INSERT INTO dm_calls(id,channel_id,workspace_id,caller_id,callee_id,caller_device,mode) VALUES(${v.id},${v.channel_id},${ch.workspace_id},${actor},${peer},${v.device_id},${v.mode})`);
   for(const user of [actor,peer].sort())await c.execute(sql`INSERT INTO dm_call_participants(user_id,call_id,device_id,expires_at) VALUES(${user},${v.id},${user===actor?v.device_id:null},now()+interval '45 seconds')`);
   return this.row(c,actor,v.id);
  });
 }
 async accept(actor:string,id:string,device:string){
  uuid(device);
  return sessionTransaction(this.db,async c=>{
   const call=await this.row(c,actor,id);await this.channel(c,actor,call.channel_id,true);
   if(call.callee_id!==actor)throw new AppError(403,'call_not_recipient');
   if(call.state==='ended')throw new AppError(409,'call_ended');
   if(call.state==='accepted'){if(call.callee_device!==device)throw new AppError(409,'call_other_device');return call;}
   const changed=await c.execute(sql`UPDATE dm_calls SET state='accepted',callee_device=${device},accepted_at=now(),revision=revision+1 WHERE id=${id} AND state='ringing' AND created_at>now()-interval '30 seconds' RETURNING id`);
   if(!changed.rows.length)throw new AppError(409,'call_ended');
   await c.execute(sql`UPDATE dm_call_participants SET device_id=CASE WHEN user_id=${actor} THEN ${device}::uuid ELSE device_id END,expires_at=now()+interval '45 seconds' WHERE call_id=${id}`);
   return this.row(c,actor,id);
  });
 }
 private selected(call:DmCall,actor:string,device:string){
  if((actor===call.caller_id?call.caller_device:call.callee_device)!==device)throw new AppError(409,'call_other_device');
 }
 async endpoint(actor:string,id:string,device:string){
  const call=await this.read(actor,id);
  if(call.state!=='accepted')throw new AppError(409,'call_ended');
  this.selected(call,actor,device);await this.channel(this.db,actor,call.channel_id,true);
  return {call,peer_id:actor===call.caller_id?call.callee_id:call.caller_id,peer_device:actor===call.caller_id?call.callee_device!:call.caller_device};
 }
 async end(actor:string,id:string,device:string,reason:CallReason='completed'){
  return sessionTransaction(this.db,async c=>{
   const call=await this.row(c,actor,id);
   if(call.state==='ended')return call;
   if(call.state==='accepted'||actor===call.caller_id)this.selected(call,actor,device);
   const result=reason==='failed'?'failed':call.state==='ringing'?(actor===call.caller_id?'cancelled':'declined'):'completed';
   await c.execute(sql`UPDATE dm_calls SET state='ended',reason=${result},ended_at=now(),revision=revision+1 WHERE id=${id} AND state<>'ended'`);
   return this.row(c,actor,id);
  });
 }
 async heartbeat(actor:string,id:string,device:string){
  await sessionTransaction(this.db,async c=>{
   const call=await this.row(c,actor,id);this.selected(call,actor,device);await this.channel(c,actor,call.channel_id,true);
   if(call.state!=='accepted')throw new AppError(409,'call_ended');
   const changed=await c.execute(sql`UPDATE dm_call_participants SET expires_at=now()+interval '45 seconds' WHERE call_id=${id} AND user_id=${actor} AND device_id=${device} AND expires_at>now() RETURNING user_id`);
   if(!changed.rows.length)throw new AppError(409,'call_ended');
  });
 }
 async expire(id:string){
  await sessionTransaction(this.db,async c=>{
   await c.execute(sql`UPDATE dm_calls SET state='ended',reason=CASE WHEN state='ringing' THEN 'missed' ELSE 'failed' END,ended_at=now(),revision=revision+1
    WHERE id=${uuid(id)} AND ((state='ringing' AND created_at<=now()-interval '30 seconds') OR (state='accepted' AND EXISTS(SELECT 1 FROM dm_call_participants WHERE call_id=${id} AND expires_at<=now())))`);
  });
 }
 async snapshot(actor:string,lastId?:string):Promise<DmCall|null>{
  const active=(await this.db.execute<{call_id:string}>(sql`SELECT call_id FROM dm_call_participants WHERE user_id=${uuid(actor)}`)).rows[0];
  if(!active&&!lastId)return null;
  try{return await this.read(actor,active?.call_id??lastId!);}catch(error){if(error instanceof AppError&&error.status===404)return null;throw error;}
 }
 async history(actor:string,channel:string){
  await this.channel(this.db,actor,channel);
  return (await this.db.execute<DmCall & Record<string,unknown>>(sql`SELECT ${fields} FROM dm_calls c JOIN users a ON a.id=c.caller_id JOIN users b ON b.id=c.callee_id WHERE c.channel_id=${channel} ORDER BY c.created_at DESC,c.id DESC LIMIT 20`)).rows;
 }
}
