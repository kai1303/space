import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError, type Huddle } from '@space/contracts';

const access = `EXISTS(SELECT 1 FROM channel_members cm JOIN workspace_members wm
 ON wm.workspace_id=cm.workspace_id AND wm.user_id=cm.user_id
 WHERE cm.channel_id=c.id AND cm.workspace_id=c.workspace_id AND cm.user_id=$1 AND wm.active)`;
const projection = `h.id,h.channel_id,h.workspace_id,c.name AS channel_name,h.state,h.created_at`;
function dto(row: Huddle & {created_at: string | Date}): Huddle { return {...row,created_at:new Date(row.created_at).toISOString()}; }
async function retryWrite<T>(work:()=>Promise<T>):Promise<T> {
 for(let attempt=0;;attempt++)try{return await work();}catch(error){
  if(attempt>=4||!['40001','40P01'].includes((error as {code:string}).code))throw error;
  await new Promise(resolve=>setTimeout(resolve,20*2**attempt+Math.random()*20));
 }
}

export class HuddleStore {
 constructor(readonly pool: Pool) {}
 async channel(actor: string, channel: string, client: Pool | PoolClient = this.pool) {
  const row=(await client.query<{id:string;workspace_id:string;name:string}>(`SELECT c.id,c.workspace_id,c.name FROM channels c
   WHERE c.id=$2 AND c.kind<>'direct' AND c.archived_at IS NULL AND ${access}`,[actor,channel])).rows[0];
  if(!row) throw new AppError(404,'not_found');
  return row;
 }
 async current(actor: string, channel: string): Promise<Huddle|null> {
  await this.channel(actor,channel);
  const row=(await this.pool.query(`SELECT ${projection} FROM channel_huddles h JOIN channels c ON c.id=h.channel_id
   WHERE c.id=$2 AND h.state<>'ended' AND ${access}`,[actor,channel])).rows[0];
  return row?dto(row):null;
 }
 async list(actor:string,workspace:string,after?:string): Promise<{items:Huddle[];next_cursor:string|null}> {
  const member=await this.pool.query('SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND active',[workspace,actor]);
  if(!member.rowCount) throw new AppError(404,'not_found');
  const rows=(await this.pool.query(`SELECT ${projection} FROM channel_huddles h JOIN channels c ON c.id=h.channel_id
   WHERE h.workspace_id=$2 AND h.state<>'ended' AND c.archived_at IS NULL AND ${access}
   AND ($3::uuid IS NULL OR h.id>$3) ORDER BY h.id LIMIT 51`,[actor,workspace,after??null])).rows;
  return {items:rows.slice(0,50).map(dto),next_cursor:rows.length>50?rows[49].id:null};
 }
 start(actor:string,channel:string):Promise<Huddle> {return retryWrite(()=>this.startOnce(actor,channel));}
 private async startOnce(actor:string,channel:string):Promise<Huddle> {
  const client=await this.pool.connect();
  try {
   await client.query('BEGIN');
   const c=await this.channel(actor,channel,client);
   // Atomic authorization writes conflict with concurrent revoke/archive transactions.
   const member=await client.query('UPDATE workspace_members SET active=active WHERE workspace_id=$1 AND user_id=$2 AND active RETURNING user_id',[c.workspace_id,actor]);
   const joined=await client.query('UPDATE channel_members SET user_id=user_id WHERE channel_id=$1 AND user_id=$2 RETURNING user_id',[channel,actor]);
   const open=await client.query('UPDATE channels SET archived_at=archived_at WHERE id=$1 AND archived_at IS NULL RETURNING id',[channel]);
   if(!member.rowCount||!joined.rowCount||!open.rowCount) throw new AppError(404,'not_found');
   const id=randomUUID();
   await client.query(`INSERT INTO channel_huddles(id,workspace_id,channel_id) VALUES($1,$2,$3)
    ON CONFLICT(channel_id) WHERE state<>'ended' DO NOTHING`,[id,c.workspace_id,channel]);
   const row=(await client.query(`SELECT ${projection} FROM channel_huddles h JOIN channels c ON c.id=h.channel_id WHERE h.channel_id=$1 AND h.state<>'ended'`,[channel])).rows[0];
   await client.query('COMMIT');return dto(row);
  } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
 }
 async raw(id:string):Promise<Huddle|null> {
  const row=(await this.pool.query(`SELECT ${projection} FROM channel_huddles h JOIN channels c ON c.id=h.channel_id WHERE h.id=$1`,[id])).rows[0];
  return row?dto(row):null;
 }
 async ready(id:string) {await retryWrite(()=>this.pool.query("UPDATE channel_huddles SET state='active' WHERE id=$1 AND state='starting'",[id]));}
 async end(id:string) {await retryWrite(()=>this.pool.query("UPDATE channel_huddles SET state='ended',ended_at=now() WHERE id=$1 AND state<>'ended'",[id]));}
 async name(actor:string):Promise<string> {return (await this.pool.query('SELECT display_name FROM users WHERE id=$1',[actor])).rows[0]?.display_name??'Member';}
}
