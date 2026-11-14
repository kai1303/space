import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {database} from './database.js';
import {readChannelPermissions} from './channel-permissions.js';
import {NotificationStore} from './notifications.js';
import { AppError, type Huddle } from '@space/contracts';

const access = `EXISTS(SELECT 1 FROM channel_members cm JOIN workspace_members wm
 ON wm.workspace_id=cm.workspace_id AND wm.user_id=cm.user_id
 WHERE cm.channel_id=c.id AND cm.workspace_id=c.workspace_id AND cm.user_id=$1 AND wm.active)`;
const channelName = `CASE WHEN c.kind='direct' THEN (SELECT display_name FROM users WHERE id=
 CASE WHEN c.direct_user_low=$1 THEN c.direct_user_high ELSE c.direct_user_low END) ELSE c.name END`;
const projection = `h.id,h.channel_id,h.workspace_id,h.thread_id,h.state,h.created_at,h.ended_at,c.kind AS channel_kind`;
const visibleProjection = `${projection},${channelName} AS channel_name`;
function dto(row:Huddle):Huddle {
 return {...row,created_at:new Date(row.created_at).toISOString(),ended_at:row.ended_at?new Date(row.ended_at).toISOString():null};
}
async function retryWrite<T>(work:()=>Promise<T>):Promise<T> {
 for(let attempt=0;;attempt++)try{return await work();}catch(error){
  if(attempt>=4||!['40001','40P01'].includes((error as {code:string}).code))throw error;
  await new Promise(resolve=>setTimeout(resolve,20*2**attempt+Math.random()*20));
 }
}

export class HuddleStore {
 constructor(readonly pool: Pool) {}
 async channel(actor: string, channel: string, client: Pool | PoolClient = this.pool) {
  const row=(await client.query<{id:string;workspace_id:string;name:string;kind:'channel'|'direct';peer_id:string|null}>(`SELECT c.id,c.workspace_id,${channelName} AS name,c.kind,
   CASE WHEN c.direct_user_low=$1 THEN c.direct_user_high ELSE c.direct_user_low END AS peer_id FROM channels c
   WHERE c.id=$2 AND (c.kind='channel' OR c.direct_user_low<>c.direct_user_high) AND c.archived_at IS NULL AND ${access}`,[actor,channel])).rows[0];
  if(!row) throw new AppError(404,'not_found');
  return row;
 }
 async current(actor: string, channel: string): Promise<Huddle|null> {
  await this.channel(actor,channel);
  const row=(await this.pool.query(`SELECT ${visibleProjection} FROM channel_huddles h JOIN channels c ON c.id=h.channel_id
   WHERE c.id=$2 AND h.state<>'ended' AND ${access}`,[actor,channel])).rows[0];
  return row?dto(row):null;
 }
 async list(actor:string,workspace:string,after?:string): Promise<{items:Huddle[];next_cursor:string|null}> {
  const member=await this.pool.query('SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND active',[workspace,actor]);
  if(!member.rowCount) throw new AppError(404,'not_found');
  const rows=(await this.pool.query(`SELECT ${visibleProjection} FROM channel_huddles h JOIN channels c ON c.id=h.channel_id
   WHERE h.workspace_id=$2 AND h.state<>'ended' AND c.archived_at IS NULL AND ${access}
   AND ($3::uuid IS NULL OR h.id>$3) ORDER BY h.id LIMIT 51`,[actor,workspace,after??null])).rows;
  return {items:rows.slice(0,50).map(dto),next_cursor:rows.length>50?rows[49].id:null};
 }
 async invitations(actor:string):Promise<Huddle[]> {
  const rows=await this.pool.query(`SELECT ${visibleProjection} FROM channel_members cm JOIN channels c ON c.id=cm.channel_id
   JOIN channel_huddles h ON h.channel_id=c.id AND h.state='active'
   WHERE cm.user_id=$1 AND ((c.kind='direct' AND h.started_by<>$1) OR EXISTS
    (SELECT 1 FROM huddle_invites i WHERE i.huddle_id=h.id AND i.user_id=$1)) AND ${access}
   AND NOT EXISTS(SELECT 1 FROM huddle_attendance a WHERE a.huddle_id=h.id AND a.user_id=$1)
   AND NOT EXISTS(SELECT 1 FROM huddle_dismissals d WHERE d.huddle_id=h.id AND d.user_id=$1)
   ORDER BY h.created_at DESC LIMIT 5`,[actor]);
  return rows.rows.map(dto);
 }
 async people(actor:string,id:string,query:string) {
  const rows=await this.pool.query(`SELECT u.id,u.display_name AS name,u.image FROM channel_huddles h JOIN channels c ON c.id=h.channel_id
   JOIN huddle_attendance a ON a.huddle_id=h.id AND a.user_id=$1
   JOIN channel_members cm ON cm.channel_id=c.id JOIN users u ON u.id=cm.user_id
   JOIN workspace_members wm ON wm.workspace_id=c.workspace_id AND wm.user_id=u.id AND wm.active
   WHERE h.id=$2 AND h.state='active' AND c.kind='channel' AND u.id<>$1 AND ${access}
   AND position(lower($3) IN lower(u.display_name||' '||u.full_name))>0
   ORDER BY u.display_name,u.id LIMIT 30`,[actor,id,query]);
  return {items:rows.rows,next_cursor:null};
 }
 async invite(actor:string,id:string,recipient:string) {
  const result=await this.pool.query(`WITH eligible AS (
   SELECT h.id FROM channel_huddles h JOIN channels c ON c.id=h.channel_id
   JOIN huddle_attendance a ON a.huddle_id=h.id AND a.user_id=$1
   JOIN channel_members cm ON cm.channel_id=c.id AND cm.user_id=$3
   JOIN workspace_members wm ON wm.workspace_id=c.workspace_id AND wm.user_id=$3 AND wm.active
   WHERE h.id=$2 AND h.state='active' AND c.kind='channel' AND $1<>$3 AND ${access}
  ), inserted AS (INSERT INTO huddle_invites(huddle_id,user_id) SELECT id,$3 FROM eligible ON CONFLICT DO NOTHING)
  SELECT id FROM eligible`,[actor,id,recipient]);
  if(!result.rowCount)throw new AppError(404,'not_found');
 }
 async dismiss(actor:string,id:string) {
  await this.pool.query(`INSERT INTO huddle_dismissals(huddle_id,user_id)
   SELECT h.id,$1 FROM channel_huddles h JOIN channels c ON c.id=h.channel_id
   WHERE h.id=$2 AND h.state='active' AND ((c.kind='direct' AND h.started_by<>$1) OR EXISTS
    (SELECT 1 FROM huddle_invites i WHERE i.huddle_id=h.id AND i.user_id=$1)) AND ${access}
   ON CONFLICT DO NOTHING`,[actor,id]);
 }
 async recent(actor:string,workspace:string):Promise<Huddle[]> {
  const rows=await this.pool.query(`SELECT ${visibleProjection} FROM huddle_attendance a
   JOIN channel_huddles h ON h.id=a.huddle_id JOIN channels c ON c.id=h.channel_id
   WHERE a.user_id=$1 AND a.workspace_id=$2 AND h.state='ended' AND c.archived_at IS NULL AND ${access}
   ORDER BY a.joined_at DESC,a.huddle_id LIMIT 20`,[actor,workspace]);
  return rows.rows.map(dto);
 }
 async admit(actor:string,channel:string,id:string):Promise<Huddle> {
  const current=await this.current(actor,channel);
  if(current?.id!==id || current.state!=='active')throw new AppError(409,'huddle_ended');
  await this.pool.query(`INSERT INTO huddle_attendance(huddle_id,user_id,workspace_id)
   VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[id,actor,current.workspace_id]);
  return current;
 }
 async suggestions(actor:string,workspace:string):Promise<{id:string;name:string}[]> {
  const rows=await this.pool.query(`SELECT c.id,c.name FROM channel_members cm JOIN channels c ON c.id=cm.channel_id
   JOIN workspace_members wm ON wm.workspace_id=cm.workspace_id AND wm.user_id=cm.user_id AND wm.active
   WHERE cm.user_id=$1 AND cm.workspace_id=$2 AND c.kind='channel' AND c.archived_at IS NULL
   ORDER BY c.name,c.id LIMIT 5`,[actor,workspace]);
  return rows.rows;
 }
 start(actor:string,channel:string):Promise<Huddle> {return retryWrite(()=>this.startOnce(actor,channel));}
 private async startOnce(actor:string,channel:string):Promise<Huddle> {
  const client=await this.pool.connect();
  try {
   await client.query('BEGIN');
   const c=await this.channel(actor,channel,client);
   // Atomic authorization writes conflict with concurrent revoke/archive transactions.
   // DM participants are immutable. Touch active memberships in a consistent order so
   // reciprocal starts and deactivation cannot mint admissions against stale membership.
   for(const user of (c.peer_id?[actor,c.peer_id].sort():[actor])){
    const member=await client.query('UPDATE workspace_members SET active=active WHERE workspace_id=$1 AND user_id=$2 AND active RETURNING user_id',[c.workspace_id,user]);
    if(!member.rowCount)throw new AppError(404,'not_found');
   }
   if(c.kind!=='direct'){
    const joined=await client.query('UPDATE channel_members SET user_id=user_id WHERE channel_id=$1 AND user_id=$2 RETURNING user_id',[channel,actor]);
    if(!joined.rowCount)throw new AppError(404,'not_found');
   }
   const open=await client.query('UPDATE channels SET archived_at=archived_at WHERE id=$1 AND archived_at IS NULL RETURNING id',[channel]);
   if(!open.rowCount) throw new AppError(404,'not_found');
   // The channel update above serializes starts. An insert against an already-open
   // room can otherwise wait on activation while holding its revision updates.
   const fields='id,channel_id,workspace_id,state,created_at,thread_id';
   const existing=await client.query(`SELECT ${fields} FROM channel_huddles WHERE channel_id=$1 AND state<>'ended'`,[channel]);
   const row=existing.rows[0] ?? (await client.query(
    `INSERT INTO channel_huddles(id,workspace_id,channel_id,started_by) VALUES($1,$2,$3,$4) RETURNING ${fields}`,
    [randomUUID(),c.workspace_id,channel,actor]
   )).rows[0];
   await client.query('COMMIT');return dto({...row,channel_name:c.name,channel_kind:c.kind});
  } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
 }
 async raw(id:string):Promise<Huddle|null> {
  const row=(await this.pool.query(`SELECT ${projection}, c.name AS channel_name FROM channel_huddles h JOIN channels c ON c.id=h.channel_id WHERE h.id=$1`,[id])).rows[0];
  return row?dto(row):null;
 }
 async ready(id:string) {
  await retryWrite(async()=>{
   const client=await this.pool.connect();
   try {
    await client.query('BEGIN');
    const {rows}=await client.query(`UPDATE channel_huddles SET state='active' WHERE id=$1 AND state='starting'
      RETURNING channel_id,started_by`,[id]);
    const started=rows[0];
    if(started?.started_by) {
     const channel=(await client.query('SELECT id,workspace_id,kind,direct_user_low,direct_user_high,encrypted_since FROM channels WHERE id=$1',[started.channel_id])).rows[0];
     const db=database(client);
     if(!channel.encrypted_since && (channel.kind==='direct' || (await readChannelPermissions(db,started.started_by,channel.id)).capabilities.post)) {
      const thread=randomUUID(), message=randomUUID();
      await client.query('INSERT INTO threads(id,workspace_id,channel_id) VALUES($1,$2,$3)',[thread,channel.workspace_id,channel.id]);
      await client.query(`INSERT INTO messages(id,workspace_id,channel_id,thread_id,user_id,author_type,client_message_id,request_hash,text)
       VALUES($1,$2,$3,$4,$5,'human',$1,'huddle-start','Started a huddle')`,[message,channel.workspace_id,channel.id,thread,started.started_by]);
      await new NotificationStore(this.pool).notify(db,started.started_by,channel,message,thread,[],false);
      if(channel.kind==='direct')await client.query('UPDATE direct_message_views SET hidden=false,last_activity_at=now() WHERE channel_id=$1',[channel.id]);
      await client.query('UPDATE channel_huddles SET thread_id=$2 WHERE id=$1',[id,thread]);
     }
    }
    await client.query('COMMIT');
   } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  });
 }
 async end(id:string) {await retryWrite(()=>this.pool.query("UPDATE channel_huddles SET state='ended',ended_at=now() WHERE id=$1 AND state<>'ended'",[id]));}
 async name(actor:string):Promise<string> {return (await this.pool.query('SELECT display_name FROM users WHERE id=$1',[actor])).rows[0]?.display_name??'Member';}
}
