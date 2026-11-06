import {sql} from 'drizzle-orm';
import type {Pool} from 'pg';
import {AppError,parseLocalToolApproval,parseToolApprovalDecision,uuid,type LocalToolApproval} from '@space/contracts';
import {database,type DbSession} from './database.js';
import {hasThreadAccess} from './access.js';
import {sessionTransaction} from './session-concurrency.js';

type Execution = {session_id:string;origin_thread_id:string;owner_id:string;requester_id:string};
const live = sql`t.status='running' AND t.active_execution_id=a.execution_id AND s.state='active'
 AND i.enabled AND ac.revoked_at IS NULL AND ac.connection_id=a.connection_id AND ac.auth_status='ready'
 AND o.state='delivering' AND o.lease_until>now()`;
const joins = sql`FROM agent_tool_approvals a JOIN tasks t ON t.id=a.task_id
 JOIN agent_sessions s ON s.id=a.session_id JOIN agent_installations i ON i.id=a.installation_id
 JOIN agent_connections ac ON ac.installation_id=i.id JOIN outbox o ON o.task_id=t.id`;

export async function sessionToolApprovals(c:DbSession,session:string):Promise<LocalToolApproval[]> {
 const result=await c.execute<LocalToolApproval & Record<string,unknown>>(sql`SELECT a.id,a.session_id,a.task_id,a.execution_id,a.kind,a.title,a.details,
 CASE WHEN a.consumed_at IS NULL AND NOT (${live}) THEN 'cancelled' ELSE a.status END AS status,
 a.created_at::text,a.resolved_at::text,a.consumed_at::text ${joins} WHERE a.session_id=${session} ORDER BY a.created_at DESC,a.id DESC LIMIT 50`);
 return result.rows;
}
export class ToolApprovalStore {
 readonly db;
 constructor(readonly pool:Pool){this.db=database(pool);}
 private async execution(c:DbSession,installation:string,connection:string,task:string,execution:string):Promise<Execution>{
  const result=await c.execute<Execution & Record<string,unknown>>(sql`SELECT s.id AS session_id,s.origin_thread_id,i.owner_id,t.requester_id
   FROM tasks t JOIN agent_sessions s ON s.id=t.session_id JOIN agent_installations i ON i.id=t.installation_id
   JOIN agent_connections ac ON ac.installation_id=i.id JOIN outbox o ON o.task_id=t.id
   WHERE t.id=${uuid(task)} AND t.active_execution_id=${uuid(execution)} AND i.id=${uuid(installation)}
    AND ac.connection_id=${uuid(connection)} AND ac.revoked_at IS NULL AND ac.auth_status='ready' AND i.enabled
    AND t.status='running' AND s.state='active' AND s.managed AND o.state='delivering' AND o.lease_until>now()`);
  const row=result.rows[0];
  if(!row || !await hasThreadAccess(c,row.owner_id,row.origin_thread_id) || !await hasThreadAccess(c,row.requester_id,row.origin_thread_id))throw new AppError(409,'stale_execution');
  return row;
 }
 async request(installation:string,connection:string,task:string,execution:string,raw:unknown){
  const input=parseLocalToolApproval(raw);
  return sessionTransaction(this.db,async c=>{
   const run=await this.execution(c,installation,connection,task,execution);
   const prior=await c.execute(sql`SELECT * FROM agent_tool_approvals WHERE id=${input.id}`);
   if(prior.rows[0]){
    const p=prior.rows[0];
    if(p.task_id!==task||p.execution_id!==execution||p.connection_id!==connection||p.kind!==input.kind||p.title!==input.title||p.details!==input.details)throw new AppError(409,'idempotency_conflict');
    return {id:input.id,status:p.status as LocalToolApproval['status']};
   }
   const count=await c.execute(sql`SELECT count(*)::integer AS count,count(*) FILTER (WHERE status='pending')::integer AS pending FROM agent_tool_approvals WHERE execution_id=${execution}`);
   if(Number(count.rows[0]?.count)>=200||Number(count.rows[0]?.pending)>=8)throw new AppError(429,'too_many_tool_approvals');
   await c.execute(sql`INSERT INTO agent_tool_approvals(id,session_id,task_id,execution_id,installation_id,connection_id,kind,title,details)
    VALUES(${input.id},${run.session_id},${task},${execution},${installation},${connection},${input.kind},${input.title},${input.details})`);
   return {id:input.id,status:'pending' as const};
  });
 }
 async decide(actor:string,session:string,id:string,raw:unknown){
  const decision=parseToolApprovalDecision(raw);
  return sessionTransaction(this.db,async c=>{
   const result=await c.execute(sql`SELECT a.*,s.origin_thread_id,i.owner_id ${joins} WHERE a.id=${uuid(id)} AND a.session_id=${uuid(session)}`);
   const row=result.rows[0];
   if(!row || !await hasThreadAccess(c,actor,String(row.origin_thread_id)))throw new AppError(404,'not_found');
   if(row.owner_id!==actor)throw new AppError(403,'tool_approval_owner_required');
   await this.execution(c,String(row.installation_id),String(row.connection_id),String(row.task_id),String(row.execution_id));
   if(row.status!=='pending' && row.status!==decision)throw new AppError(409,'tool_approval_resolved');
   await c.execute(sql`UPDATE agent_tool_approvals SET status=${decision},decided_by=${actor},resolved_at=now() WHERE id=${id} AND status='pending'`);
   return {id,status:decision};
  });
 }
 async decision(id:string){
  const result=await this.db.execute(sql`SELECT a.id,a.task_id,a.execution_id,a.installation_id,a.connection_id,a.status ${joins}
   WHERE a.id=${uuid(id)} AND a.status IN ('allow','deny') AND a.consumed_at IS NULL AND (${live})`);
  return result.rows[0];
 }
 async consume(installation:string,connection:string,id:string){
  return sessionTransaction(this.db,async c=>{
   const result=await c.execute(sql`SELECT a.* ${joins} WHERE a.id=${uuid(id)} AND a.installation_id=${uuid(installation)} AND a.connection_id=${uuid(connection)}`);
   const row=result.rows[0];if(!row)throw new AppError(404,'not_found');
   await this.execution(c,installation,connection,String(row.task_id),String(row.execution_id));
   if(row.status!=='allow'&&row.status!=='deny')throw new AppError(409,'tool_approval_pending');
   await c.execute(sql`UPDATE agent_tool_approvals SET consumed_at=coalesce(consumed_at,now()) WHERE id=${id}`);
   return row.status as 'allow'|'deny';
  });
 }
}
