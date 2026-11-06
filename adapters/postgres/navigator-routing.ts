import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { AppError, type NavigatorRule, type RichDocument, type Task } from '@space/contracts';
import { database, type DbSession } from './database.js';
import { AgentSessionStore } from './agent-sessions.js';
import { PostgresStore } from './store.js';
import { sessionTransaction } from './session-concurrency.js';
import * as s from './schema.js';

export type NavigatorSettings = {policy_version?:string;mode:'off'|'rules'|'semantic';execution_mode:'suggest'|'observe';rules:NavigatorRule[];daily_token_limit:number;cooldown_seconds:number};
export const defaultNavigatorSettings:NavigatorSettings={mode:'rules',execution_mode:'suggest',rules:[],daily_token_limit:10000,cooldown_seconds:300};
export async function readNavigatorSettings(c:DbSession,channel:string):Promise<NavigatorSettings>{
 const result=await c.execute(sql`SELECT policy_version,mode,execution_mode,rules,daily_token_limit,cooldown_seconds FROM navigator_settings WHERE channel_id=${channel}`);
 return result.rows[0] as NavigatorSettings|undefined ?? {...defaultNavigatorSettings};
}
export function navigatorPolicyVersion(settings:NavigatorSettings):string {
 return createHash('sha256').update(JSON.stringify([settings.policy_version??'unconfigured',settings.mode,settings.execution_mode,settings.rules])).digest('hex');
}
type Authorization={id:string;decision_id:string;actor_id:string;source_message_id:string;channel_id:string;thread_id:string;installation_id:string;session_id:string|null;skill:string;action:'start'|'continue'|'stop';scope:string;policy_version:string};
type Pending=Authorization & {document:RichDocument|null};

export class NavigatorRouting {
 readonly db;readonly sessions;
 constructor(pool:Pool,readonly tasks:PostgresStore){this.db=database(pool);this.sessions=new AgentSessionStore(pool,tasks);}
 async authorize(c:DbSession,authorization:Omit<Authorization,'id'>):Promise<string>{
  const id=randomUUID(),a=authorization;
  await c.execute(sql`INSERT INTO navigator_authorizations(id,decision_id,actor_id,source_message_id,channel_id,thread_id,installation_id,session_id,skill,action,scope,policy_version)
   VALUES(${id},${a.decision_id},${a.actor_id},${a.source_message_id},${a.channel_id},${a.thread_id},${a.installation_id},${a.session_id},${a.skill},${a.action},${a.scope},${a.policy_version})`);
  return id;
 }
 async follow(c:DbSession,input:{decisionId:string;actor:string;messageId:string;channel:string;thread:string;session:string;action:'continue'|'stop';goal:string;document?:RichDocument|null;policyVersion:string}){
  const [session]=await c.select().from(s.agentSessions).where(and(eq(s.agentSessions.id,input.session),eq(s.agentSessions.origin_thread_id,input.thread)));
  if(!session?.managed||session.state!=='active')throw new AppError(409,'session_unavailable');
  const installation=await this.tasks.eligible(c,{workspace_id:session.workspace_id,thread_id:input.thread,installation_id:session.installation_id,requester_id:input.actor,session_id:session.id,skill:session.skill},true);
  if(input.action==='stop'&&input.actor!==session.created_by&&input.actor!==installation.owner_id)throw new AppError(403,'session_control_not_authorized');
  if(input.goal.length>4000)throw new AppError(400,'followup_too_long');
  if(input.action==='continue'){
   const count=await c.execute(sql`SELECT count(*)::int AS n FROM navigator_followups WHERE thread_id=${input.thread} AND status='pending'`);
   if(Number(count.rows[0]?.n)>=32)throw new AppError(409,'followup_queue_full');
  }
  const id=await this.authorize(c,{decision_id:input.decisionId,actor_id:input.actor,source_message_id:input.messageId,channel_id:input.channel,thread_id:input.thread,installation_id:session.installation_id,session_id:session.id,skill:session.skill,action:input.action,scope:input.goal,policy_version:input.policyVersion});
  if(input.action==='stop'){
   await this.sessions.controlIn(c,input.actor,session.id,'stop');
  }else await c.execute(sql`INSERT INTO navigator_followups(id,thread_id,session_id,document) VALUES(${id},${input.thread},${session.id},${input.document?JSON.stringify(input.document):null}::jsonb)`);
  return id;
 }
 async drain(thread?:string):Promise<boolean>{
  let processed=false;
  // A targeted event drains a bounded batch; busy sessions wake on committed completion.
  for(let i=0;i<32;i++){
   let picked:Pending|undefined;
   try{
    const changed=await sessionTransaction(this.db,async c=>{
     const result=await c.execute(sql`SELECT a.*,f.document FROM navigator_followups f JOIN navigator_authorizations a ON a.id=f.id
      JOIN agent_sessions session ON session.id=f.session_id WHERE f.status='pending' ${thread?sql`AND f.thread_id=${thread}`:sql``}
      AND NOT EXISTS(SELECT 1 FROM navigator_threads n JOIN messages m ON m.thread_id=n.thread_id WHERE n.thread_id=f.thread_id AND m.author_type='human' AND m.sequence>n.last_sequence)
      AND (session.state='ended' OR NOT EXISTS(SELECT 1 FROM tasks t WHERE t.session_id=f.session_id AND t.status IN ('awaiting_approval','queued','running')))
      ORDER BY f.created_at,f.id LIMIT 1`);
     picked=result.rows[0] as Pending|undefined;if(!picked)return false;
     const a=picked,settings=await readNavigatorSettings(c,a.channel_id);
     if(settings.mode!=='semantic'||settings.execution_mode==='observe'||navigatorPolicyVersion(settings)!==a.policy_version)throw new AppError(409,'navigation_policy_changed');
     const original=await c.execute(sql`SELECT text,document FROM messages WHERE channel_id=${a.channel_id} AND thread_id=${a.thread_id} AND id=${a.source_message_id}`);
     const source=original.rows[0];
     if(!source||source.text!==a.scope||JSON.stringify(source.document??null)!==JSON.stringify(a.document??null))throw new AppError(409,'navigation_source_changed');
     const task=await this.sessions.sendIn(c,a.actor_id,a.session_id!,{text:a.scope,...(a.document?{document:a.document}:{})},`navigator-followup:${a.id}`);
     await c.execute(sql`UPDATE navigator_followups SET status='delivered',task_id=${task.id} WHERE id=${a.id} AND status='pending'`);
     await c.execute(sql`UPDATE navigator_decisions SET decision=decision||${JSON.stringify({task_id:task.id,authorization_id:a.id})}::jsonb WHERE id=${a.decision_id}`);
     return true;
    });
    if(!changed)break;processed=true;
   }catch(error){
    if(!picked||!(error instanceof AppError)||error.code==='session_conflict')throw error;
    // The failed send rolled back entirely before cancellation is recorded.
    const a:Pending=picked;
    await sessionTransaction(this.db,async c=>{
     const cancelled=await c.execute(sql`UPDATE navigator_followups SET status='cancelled',reason=${error.code} WHERE id=${a.id} AND status='pending' RETURNING id`);
     if(cancelled.rows.length)await c.execute(sql`UPDATE navigator_decisions SET route='unavailable',decision=decision||${JSON.stringify({delivery_error:error.code})}::jsonb WHERE id=${a.decision_id}`);
    });
    processed=true;
   }
  }
  return processed;
 }
 async recordStart(c:DbSession,task:Task,decisionId:string,messageId:string,channel:string,settings:NavigatorSettings){
  return this.authorize(c,{decision_id:decisionId,actor_id:task.requester_id,source_message_id:messageId,channel_id:channel,thread_id:task.thread_id,installation_id:task.installation_id,session_id:task.session_id,skill:task.skill,action:'start',scope:task.goal,policy_version:navigatorPolicyVersion(settings)});
 }
}
