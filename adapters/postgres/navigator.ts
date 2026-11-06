import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { sql, eq, and } from 'drizzle-orm';
import { AppError, record, text, uuid, type NavigatorCandidate, type NavigatorRule, type NavigationContext, type NavigationDecision, type NavigationWorkState, type NavigatorProvider, type RichDocument, type Task } from '@space/contracts';
import { matchAgentMentions, rulesDecision, parseNavigationDecision, navigationWorkStateHash } from '@space/core/navigator';
import { database, type DbSession } from './database.js';
import { hasChannelAccess } from './access.js';
import { readThreadContext } from './thread-context.js';
import { PostgresStore } from './store.js';
import * as s from './schema.js';
import { sessionTransaction } from './session-concurrency.js';
import { NavigatorRouting, readNavigatorSettings, navigatorPolicyVersion, type NavigatorSettings } from './navigator-routing.js';

type Settings = NavigatorSettings;
type Message = { id:string; text:string; sequence:string; user_id:string; document?:RichDocument|null; routing_text?:string };
type Job = { thread_id:string; last_sequence:string; head_sequence:string; channel_id:string; workspace_id:string; messages:Message[]; settings:Settings; candidates:NavigatorCandidate[]; workStateHash?:string };
async function rows<T>(c:DbSession, query:Parameters<DbSession['execute']>[0]):Promise<T[]> { return (await c.execute(query)).rows as T[]; }
const empty=(reason:string):NavigationDecision=>({action:'ignore',capabilities:[],evidenceMessageIds:[],reason});

// Quill puts block formatting on newline operations; a code/quote line is never an invocation.
function routingText(message:Pick<Message,'text'|'document'>):string {
 if(!message.document)return message.text;
 let line='',visible='';
 for(const op of message.document.ops){const parts=op.insert.split('\n');for(let i=0;i<parts.length;i++){
  line+=op.attributes?.code||op.attributes?.link||op.attributes?.blockquote||op.attributes?.['code-block']?' '.repeat(parts[i]!.length):op.attributes?.mention?(op.attributes.mention.kind==='agent'?` @agent-${op.attributes.mention.id} `:' '.repeat(parts[i]!.length)):parts[i];
  if(i<parts.length-1){if(!op.attributes?.blockquote&&!op.attributes?.['code-block'])visible+=line+'\n';line='';}
 }}
 return visible+line;
}

export class NavigatorStore {
 readonly db; readonly tasks; readonly routing;
 constructor(readonly pool:Pool, readonly providers:{level1?:NavigatorProvider;level2?:NavigatorProvider}={}) {this.db=database(pool);this.tasks=new PostgresStore(pool);this.routing=new NavigatorRouting(pool,this.tasks);}
 private async channel(c:DbSession,actor:string,id:string) {
  const [channel]=await c.select().from(s.channels).where(eq(s.channels.id,uuid(id)));
  if(!channel||!await hasChannelAccess(c,actor,channel.workspace_id,id))throw new AppError(404,'not_found');
  return channel;
 }
 private async manager(c:DbSession,actor:string,channel:typeof s.channels.$inferSelect) {
  const [member]=await c.select().from(s.workspaceMembers).where(and(eq(s.workspaceMembers.workspace_id,channel.workspace_id),eq(s.workspaceMembers.user_id,actor),eq(s.workspaceMembers.active,true)));
  return member?.guest_type==='none'&&(channel.created_by===actor||member.role==='owner'||member.role==='admin');
 }
 private async settings(c:DbSession,channel:string):Promise<Settings> {return readNavigatorSettings(c,channel);}
 private async catalog(c:DbSession,channel:string):Promise<NavigatorCandidate[]> {
  const candidates=await rows<NavigatorCandidate & {owner_id:string;workspace_id:string}>(c,sql`SELECT i.id AS installation_id,coalesce(ac.name,d.name) AS name,skill.value AS skill,
    coalesce(ac.name,d.name)||' supports '||skill.value AS description,i.owner_id,i.workspace_id,coalesce((d.capabilities->>'persistent_sessions')::boolean,false) AS persistent_sessions
    FROM agent_installations i JOIN agent_definitions d ON d.id=i.definition_id
    CROSS JOIN LATERAL jsonb_array_elements_text(d.capabilities->'skills') AS skill(value)
    LEFT JOIN agent_connections ac ON ac.installation_id=i.id
    JOIN channels ch ON ch.id=${channel} AND ch.workspace_id=i.workspace_id
    JOIN channel_members cm ON cm.channel_id=ch.id AND cm.workspace_id=i.workspace_id AND cm.user_id=i.owner_id
    JOIN workspace_members wm ON wm.workspace_id=i.workspace_id AND wm.user_id=i.owner_id AND wm.active
    WHERE i.enabled AND ac.revoked_at IS NULL AND ch.archived_at IS NULL
    AND (ac.installation_id IS NOT NULL OR EXISTS(SELECT 1 FROM agent_grants g WHERE g.installation_id=i.id AND g.workspace_id=i.workspace_id AND g.channel_id=ch.id AND g.skill=skill.value)) ORDER BY i.id,skill.value LIMIT 100`);
  return candidates.map(({installation_id,name,skill,description,persistent_sessions})=>({installation_id,name,skill,description,persistent_sessions}));
 }
 async read(actor:string,channel:string) {return sessionTransaction(this.db,async c=>{const ch=await this.channel(c,actor,channel);const {policy_version,...settings}=await this.settings(c,channel);return {settings,candidates:await this.catalog(c,channel),can_manage:await this.manager(c,actor,ch)};});}
 async configure(actor:string,channel:string,input:unknown) {
  const v=record(input,['mode','execution_mode','rules','daily_token_limit','cooldown_seconds']);
  const patch:Partial<Settings>={};
  if(v.execution_mode!==undefined){if(v.execution_mode!=='suggest'&&v.execution_mode!=='observe')throw new AppError(400,'invalid_navigation_execution_mode');patch.execution_mode=v.execution_mode;}
  if(v.mode!==undefined){if(!['off','rules','semantic'].includes(String(v.mode)))throw new AppError(400,'invalid_navigation_mode');patch.mode=v.mode as Settings['mode'];}
  if(v.rules!==undefined){if(!Array.isArray(v.rules)||v.rules.length>50)throw new AppError(400,'invalid_navigation_rules');patch.rules=v.rules.map(raw=>{const rule=record(raw,['skill','keywords']);if(!Array.isArray(rule.keywords)||!rule.keywords.length||rule.keywords.length>20)throw new AppError(400,'invalid_navigation_rules');return {skill:text(rule.skill,80),keywords:rule.keywords.map(k=>text(k,80).trim()).filter(Boolean)};});}
  for(const [key,max] of [['daily_token_limit',1000000],['cooldown_seconds',86400]] as const)if(v[key]!==undefined){if(!Number.isSafeInteger(v[key])||Number(v[key])<0||Number(v[key])>max)throw new AppError(400,'invalid_navigation_limit');patch[key]=v[key] as number;}
  return sessionTransaction(this.db,async c=>{const ch=await this.channel(c,actor,channel);if(!await this.manager(c,actor,ch))throw new AppError(403,'navigation_management_forbidden');const settings={...await this.settings(c,channel),...patch};await c.execute(sql`INSERT INTO navigator_settings(channel_id,mode,execution_mode,rules,daily_token_limit,cooldown_seconds) VALUES(${channel},${settings.mode},${settings.execution_mode},${JSON.stringify(settings.rules)}::jsonb,${settings.daily_token_limit},${settings.cooldown_seconds}) ON CONFLICT(channel_id) DO UPDATE SET policy_version=CASE WHEN (navigator_settings.mode,navigator_settings.execution_mode,navigator_settings.rules) IS DISTINCT FROM (excluded.mode,excluded.execution_mode,excluded.rules) THEN gen_random_uuid() ELSE navigator_settings.policy_version END,mode=excluded.mode,execution_mode=excluded.execution_mode,rules=excluded.rules,daily_token_limit=excluded.daily_token_limit,cooldown_seconds=excluded.cooldown_seconds`);
   const current=await this.settings(c,channel);
   await c.execute(sql`WITH cancelled AS (UPDATE navigator_followups f SET status='cancelled',reason='navigation_policy_changed' FROM navigator_authorizations a WHERE a.id=f.id AND a.channel_id=${channel} AND f.status='pending' AND a.policy_version<>${navigatorPolicyVersion(current)} RETURNING a.decision_id)
    UPDATE navigator_decisions SET route='unavailable',decision=decision||'{"delivery_error":"navigation_policy_changed"}'::jsonb WHERE id IN (SELECT decision_id FROM cancelled)`);
   const {policy_version,...publicSettings}=current;return publicSettings;});
 }
 async observations(actor:string,channel:string) {return sessionTransaction(this.db,async c=>{const ch=await this.channel(c,actor,channel);if(!await this.manager(c,actor,ch))throw new AppError(403,'navigation_management_forbidden');return rows<{id:string;thread_id:string;decision:NavigationDecision;created_at:string}>(c,sql`SELECT id,thread_id,decision,created_at::text FROM navigator_decisions WHERE channel_id=${channel} AND route IN ('observe','unavailable') ORDER BY created_at DESC,id DESC LIMIT 20`);});}
 async suggestions(actor:string,channel:string,thread?:string) {
  return sessionTransaction(this.db,async c=>{await this.channel(c,actor,channel);const candidates=await this.catalog(c,channel);const result=await rows<{id:string;thread_id:string;goal:string;decision:NavigationDecision;candidates:NavigatorCandidate[]}>(c,sql`SELECT id,thread_id,goal,decision,candidates FROM navigator_suggestions WHERE channel_id=${channel} AND status='pending' ${thread?sql`AND thread_id=${uuid(thread)}`:sql``} ORDER BY created_at DESC LIMIT 20`);return result.map(r=>({...r,candidates:r.candidates.filter(x=>candidates.some(a=>a.installation_id===x.installation_id&&a.skill===x.skill))})).filter(r=>r.candidates.length||r.decision.action==='clarify');});
 }
 async dismiss(actor:string,id:string) {return sessionTransaction(this.db,async c=>{const [ref]=await rows<{channel_id:string}>(c,sql`SELECT channel_id FROM navigator_suggestions WHERE id=${uuid(id)}`);if(!ref)throw new AppError(404,'not_found');await this.channel(c,actor,ref.channel_id);await c.execute(sql`UPDATE navigator_suggestions SET status='dismissed' WHERE id=${id} AND status='pending'`);});}
 async subscription(actor:string,thread:string) {return sessionTransaction(this.db,async c=>{const [ref]=await c.select().from(s.threads).where(eq(s.threads.id,uuid(thread)));if(!ref)throw new AppError(404,'not_found');const ch=await this.channel(c,actor,ref.channel_id);const [sub]=await rows<{installation_id:string;name:string;owner_id:string;status:string}>(c,sql`SELECT a.installation_id,coalesce(ac.name,d.name) AS name,i.owner_id,a.status FROM agent_thread_subscriptions a JOIN agent_installations i ON i.id=a.installation_id JOIN agent_definitions d ON d.id=i.definition_id LEFT JOIN agent_connections ac ON ac.installation_id=i.id WHERE a.thread_id=${thread} AND a.status='active'`);return sub?{installation_id:sub.installation_id,name:sub.name,can_close:sub.owner_id===actor||await this.manager(c,actor,ch)}:null;});}
 async closeSubscription(actor:string,thread:string) {return sessionTransaction(this.db,async c=>{const [ref]=await c.select().from(s.threads).where(eq(s.threads.id,uuid(thread)));if(!ref)throw new AppError(404,'not_found');const ch=await this.channel(c,actor,ref.channel_id);const [sub]=await rows<{owner_id:string}>(c,sql`SELECT i.owner_id FROM agent_thread_subscriptions a JOIN agent_installations i ON i.id=a.installation_id WHERE a.thread_id=${thread}`);if(sub?.owner_id!==actor&&!await this.manager(c,actor,ch))throw new AppError(403,'subscription_management_forbidden');await c.execute(sql`UPDATE agent_thread_subscriptions SET status='closed' WHERE thread_id=${thread}`);});}
 async accept(actor:string,id:string,installation:string,skill:string):Promise<Task> {
  uuid(id);uuid(installation);text(skill,80);
  return sessionTransaction(this.db,async c=>{const [ref]=await rows<{channel_id:string}>(c,sql`SELECT channel_id FROM navigator_suggestions WHERE id=${id}`);if(!ref)throw new AppError(404,'not_found');const channel=await this.channel(c,actor,ref.channel_id);const [suggestion]=await rows<{status:string;task_id:string|null;thread_id:string;goal:string;candidates:NavigatorCandidate[];policy_version:string|null}>(c,sql`SELECT * FROM navigator_suggestions WHERE id=${id}`);if(!suggestion)throw new AppError(404,'not_found');
   if(suggestion.status==='accepted'){const [task]=await c.select().from(s.tasks).where(eq(s.tasks.id,suggestion.task_id!));if(task?.installation_id!==installation||task.skill!==skill)throw new AppError(409,'suggestion_already_accepted');return task!;}
   if(suggestion.status!=='pending')throw new AppError(409,'suggestion_closed');
   const settings=await this.settings(c,channel.id);
   if(settings.execution_mode==='observe')throw new AppError(409,'navigation_observe_only');
   const candidate=(await this.catalog(c,channel.id)).find(x=>x.installation_id===installation&&x.skill===skill&&suggestion.candidates.some(a=>a.installation_id===installation&&a.skill===skill));if(!candidate)throw new AppError(409,'agent_unavailable');
   const [origin]=await rows<{id:string|null}>(c,sql`SELECT coalesce(m.id::text,n.decision->'evidenceMessageIds'->>0) AS id FROM navigator_decisions n LEFT JOIN messages m ON m.channel_id=n.channel_id AND m.thread_id=n.thread_id AND m.sequence=n.through_sequence WHERE n.id=${id} AND n.channel_id=${channel.id}`);
   if(!origin?.id)throw new AppError(409,'suggestion_source_unavailable');
   const task=await this.start(c,actor,channel.workspace_id,suggestion.thread_id,candidate,suggestion.goal,`navigator:${id}`);
   await this.routing.recordStart(c,task,id,origin.id,channel.id,settings);
   await c.execute(sql`UPDATE navigator_suggestions SET status='accepted',task_id=${task.id} WHERE id=${id}`);
   await c.execute(sql`UPDATE navigator_decisions SET route='accepted',decision=decision||${JSON.stringify({task_id:task.id})}::jsonb WHERE id=${id}`);
   return task;
  });
 }
 private async start(c:DbSession,actor:string,workspace:string,thread:string,candidate:NavigatorCandidate,goal:string,key:string,document?:RichDocument|null):Promise<Task> {
  const input={workspace_id:workspace,thread_id:thread,installation_id:candidate.installation_id,goal,skill:candidate.skill,...(document?{request_document:document}:{})};
  const installation=await this.tasks.eligible(c,{...input,requester_id:actor},true);
  const [existing]=await c.select().from(s.tasks).where(and(eq(s.tasks.workspace_id,workspace),eq(s.tasks.requester_id,actor),eq(s.tasks.idempotency_key,key)));
  if(existing)return this.tasks.createTaskIn(c,actor,input,key);
  const sessionId=installation.capabilities.persistent_sessions?randomUUID():undefined;
  if(sessionId)await c.insert(s.agentSessions).values({id:sessionId,workspace_id:workspace,installation_id:installation.id,origin_thread_id:thread,title:goal.slice(0,160),managed:true,created_by:actor,skill:candidate.skill});
  let task=await this.tasks.createTaskIn(c,actor,input,key,undefined,sessionId);
  await c.execute(sql`UPDATE navigator_suggestions SET status='dismissed' WHERE thread_id=${thread} AND status='pending'`);
  if(installation.owner_id===actor)task=await this.tasks.approveTaskIn(c,actor,task.id,sessionId);
  if(sessionId){
   const [origin]=await c.select({channel_id:s.threads.channel_id}).from(s.threads).where(eq(s.threads.id,thread));
   await c.insert(s.messages).values({id:randomUUID(),workspace_id:workspace,channel_id:origin!.channel_id,thread_id:thread,task_id:task.id,installation_id:installation.id,agent_session_id:sessionId,text:goal.slice(0,160)});
  }
  return task;
 }
 private async claim(threadId?:string):Promise<Job|null> {
  return sessionTransaction(this.db,async c=>{
   const [queued]=await rows<{thread_id:string;last_sequence:string}>(c,sql`SELECT thread_id,last_sequence::text FROM navigator_threads WHERE ${threadId?sql`thread_id=${uuid(threadId)} AND`:sql``} available_at<=now() AND EXISTS(SELECT 1 FROM messages m JOIN threads t ON t.id=navigator_threads.thread_id WHERE m.channel_id=t.channel_id AND m.thread_id=t.id AND m.author_type='human' AND m.sequence>navigator_threads.last_sequence) ORDER BY available_at,thread_id LIMIT 1`);if(!queued)return null;
   const [thread]=await c.select().from(s.threads).where(eq(s.threads.id,queued.thread_id));
   const messages=await rows<Message>(c,sql`SELECT id,text,document,sequence::text,user_id FROM messages WHERE channel_id=${thread!.channel_id} AND thread_id=${queued.thread_id} AND author_type='human' AND sequence>${queued.last_sequence}::bigint ORDER BY messages.sequence LIMIT 20`);
   const [head]=await rows<{sequence:string}>(c,sql`SELECT coalesce(max(sequence),0)::text AS sequence FROM messages WHERE channel_id=${thread!.channel_id} AND thread_id=${queued.thread_id} AND author_type='human'`);
   for(const message of messages)message.routing_text=routingText(message);
   return {thread_id:queued.thread_id,last_sequence:queued.last_sequence,head_sequence:head!.sequence,channel_id:thread!.channel_id,workspace_id:thread!.workspace_id,messages,settings:await this.settings(c,thread!.channel_id),candidates:await this.catalog(c,thread!.channel_id)};
  });
 }
 private async workState(c:DbSession,job:Job):Promise<NavigationWorkState> {
    // Only public origin tasks: private managed-session follow-up goals never enter channel routing.
    const pendingProposals=await rows<NavigationWorkState['pendingProposals'][number]>(c,sql`SELECT id,left(goal,512) AS goal,decision->'capabilities' AS capabilities FROM navigator_suggestions WHERE channel_id=${job.channel_id} AND thread_id=${job.thread_id} AND status='pending' ORDER BY created_at DESC,id LIMIT 8`);
    const tasks=await rows<NavigationWorkState['tasks'][number]>(c,sql`SELECT t.id,left(t.goal,512) AS goal,t.skill,t.status FROM tasks t WHERE t.workspace_id=${job.workspace_id} AND t.thread_id=${job.thread_id} AND (NOT EXISTS(SELECT 1 FROM agent_sessions a WHERE a.id=t.session_id AND a.managed) OR EXISTS(SELECT 1 FROM messages m WHERE m.channel_id=${job.channel_id} AND m.thread_id=${job.thread_id} AND m.task_id=t.id AND m.agent_session_id=t.session_id)) ORDER BY t.created_at DESC,t.id LIMIT 8`);
    const sessions=await rows<NavigationWorkState['sessions'][number]>(c,sql`SELECT id,left(title,160) AS title,skill,state,installation_id,revision,created_by FROM agent_sessions WHERE workspace_id=${job.workspace_id} AND origin_thread_id=${job.thread_id} AND managed ORDER BY created_at DESC,id LIMIT 8`);
    return {pendingProposals,tasks,sessions};
 }
 private async infer(job:Job,context:NavigationContext,level:1|2,stage:1|2|3=level):Promise<NavigationDecision|null> {
  const provider=level===1?this.providers.level1:this.providers.level2;if(!provider)return null;
  // Reserve conservatively; failed/unknown usage is charged too. Retries never repeat a paid call.
  const allowed=await sessionTransaction(this.db,async c=>{
   const [ch]=await c.select().from(s.channels).where(eq(s.channels.id,job.channel_id));
   const live=await rows(c,sql`SELECT 1 FROM navigator_threads WHERE thread_id=${job.thread_id} AND last_sequence=${job.last_sequence}::bigint`);
   if(!live.length||!ch||ch.archived_at||(await this.settings(c,job.channel_id)).mode!=='semantic')return {call:false,result:null};
   for(const m of job.messages)if(!await hasChannelAccess(c,m.user_id,job.workspace_id,job.channel_id))return {call:false,result:null};
   context.candidates=await this.catalog(c,job.channel_id);if(!context.candidates.length)return {call:false,result:null};
   const state=await this.workState(c,job);
   const stateHash=navigationWorkStateHash(state);
   if(job.workStateHash&&job.workStateHash!==stateHash)return {call:false,result:null};
   job.workStateHash=stateHash;context.workState=state;
   if(navigatorPolicyVersion(await this.settings(c,job.channel_id))!==navigatorPolicyVersion(job.settings))return {call:false,result:null};
   if(provider.name==='jev'){
    const ids=[...new Set([...context.messages.map(m=>m.id),...(context.workingMemory?.root?[context.workingMemory.root.id]:[])])];
    const source=await rows<{id:string;text:string;document:RichDocument|null}>(c,sql`SELECT id,text,document FROM messages WHERE channel_id=${job.channel_id} AND thread_id=${job.thread_id} AND id IN (${sql.join(ids.map(id=>sql`${id}`),sql`,`)}) LIMIT 33`);
    const visible=new Map(source.map(m=>[m.id,routingText(m)]));
    context.messages=context.messages.map(m=>{const value=visible.get(m.id)??m.text;return {...m,text:value.slice(0,1000).replace(/[\uD800-\uDBFF]$/,''),truncated:value.length>1000};});
    if(context.workingMemory?.root){const root=context.workingMemory.root;const value=visible.get(root.id)??root.text;context.workingMemory={...context.workingMemory,root:{...root,text:value.slice(0,1000).replace(/[\uD800-\uDBFF]$/,''),text_truncated:value.length>1000}};}
   }
   let reserve:number;
   try{reserve=provider.estimateTokens?.(context,level)??Buffer.byteLength(JSON.stringify(context),'utf8')+3000+provider.maxOutputTokens;}catch{return {call:false,result:null};}
   if(!Number.isSafeInteger(reserve)||reserve<1||reserve>1000000)return {call:false,result:null};
   const inputHash=createHash('sha256').update(JSON.stringify({context,head:job.head_sequence,source:job.messages.map(({id,text,document})=>({id,text,document}))})).digest('hex');
   const through=job.messages.at(-1)!.sequence;
   const [previous]=await rows<{result:NavigationDecision|null;pending:boolean;policy_version:string|null;work_state_hash:string|null;input_hash:string|null}>(c,sql`SELECT result,policy_version,work_state_hash,input_hash,result IS NULL AND latency_ms IS NULL AND error IS NULL AND started_at>now()-interval '15 seconds' AS pending FROM navigator_inferences WHERE thread_id=${job.thread_id} AND through_sequence=${through}::bigint AND level=${stage}`);
   if(previous){if((previous.input_hash&&previous.input_hash!==inputHash)||(previous.policy_version&&previous.policy_version!==navigatorPolicyVersion(job.settings))||(previous.work_state_hash&&previous.work_state_hash!==stateHash))return {call:false,result:null};if(previous.pending)throw new AppError(409,'navigation_inference_pending');await c.execute(sql`UPDATE navigator_inferences SET error='provider_interrupted' WHERE thread_id=${job.thread_id} AND through_sequence=${through}::bigint AND level=${stage} AND result IS NULL AND latency_ms IS NULL AND error IS NULL`);return {call:false,result:previous.result};}
   const [usage]=await rows<{tokens:number}>(c,sql`SELECT coalesce(sum(reserved_tokens),0)::int AS tokens FROM navigator_inferences WHERE channel_id=${job.channel_id} AND day=CURRENT_DATE`);
   if(usage!.tokens+reserve>(await this.settings(c,job.channel_id)).daily_token_limit)return {call:false,result:null};
   await c.execute(sql`INSERT INTO navigator_inferences(thread_id,through_sequence,level,channel_id,provider,model,reserved_tokens,policy_version,work_state_hash,input_hash) VALUES(${job.thread_id},${through}::bigint,${stage},${job.channel_id},${provider.name},${provider.model},${reserve},${navigatorPolicyVersion(job.settings)},${stateHash},${inputHash})`);return {call:true,result:null};
  });
  if(!allowed.call){try{
   // Historical usefulness-based decisions remain readable, but must not route under the new policy.
   if(provider.name==='jev'&&allowed.result?.assessment?.version!=='execution-intent-v1')return null;
   return allowed.result?parseNavigationDecision(allowed.result,context):null;
  }catch{return null;}}
  const started=Date.now();let decision:NavigationDecision|null=null,input:number|null=null,output:number|null=null,error:string|null=null;
  try {const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
   try {const result=await Promise.race([provider.decide(context,level,controller.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('timeout'));},12000);})]);decision=parseNavigationDecision(result.decision,context);if(decision.action==='read_context'&&(level===1||stage===3))throw new Error('invalid_context_read');input=Number.isSafeInteger(result.inputTokens)&&result.inputTokens>=0?result.inputTokens:null;output=Number.isSafeInteger(result.outputTokens)&&result.outputTokens>=0?result.outputTokens:null;}finally{clearTimeout(timer);}
  }catch{decision=null;error='provider_unavailable';}
  await this.db.execute(sql`UPDATE navigator_inferences SET result=${decision?JSON.stringify(decision):null}::jsonb,input_tokens=${input},output_tokens=${output},latency_ms=${Date.now()-started},error=${error} WHERE thread_id=${job.thread_id} AND through_sequence=${job.messages.at(-1)!.sequence}::bigint AND level=${stage}`);
  return decision;
 }
 async processOne(threadId?:string):Promise<boolean> {
  const job=await this.claim(threadId);if(!job)return this.routing.drain(threadId);
   const workState=await this.workState(this.db,job);
   // Resolve existing-session requests individually so batching cannot discard a follow-up.
   if(job.settings.mode==='semantic'&&workState.sessions.some(session=>session.state==='active'))job.messages=job.messages.slice(0,1);
   // Route a leading explicit mention alone; otherwise batch only until the next mention.
   const leading=job.messages[0];if(leading&&!leading.text.trim()){job.messages=job.messages.slice(0,1);await this.finish(job,'attachment',empty('Attachment without a request'));return true;}let mention=leading?matchAgentMentions(leading.routing_text??leading.text,job.candidates):{mentioned:false,candidates:[]};
   if(mention.mentioned)job.messages=job.messages.slice(0,1);else{const index=job.messages.findIndex((m,i)=>i>0&&matchAgentMentions(m.routing_text??m.text,job.candidates).mentioned);if(index>0)job.messages=job.messages.slice(0,index);}
   const working = await readThreadContext(this.db, job.channel_id, job.thread_id, job.messages.at(-1)?.sequence);
   const context:NavigationContext={workState,pendingMessageIds:job.messages.map(m=>m.id),messages:working.messages.map(m=>({id:m.id,text:m.text,truncated:m.text_truncated,author:m.author})),workingMemory:{root:working.root,checkpoint:working.checkpoint},candidates:job.candidates,rules:job.settings.rules};
   let route='ignore',decision=empty('No useful action');let candidate:NavigatorCandidate|undefined;
   if(mention.mentioned){route='mention';if(mention.candidates.length===1)candidate=mention.candidates[0];else if(mention.candidates.length)decision={action:'suggest',capabilities:[...new Set(mention.candidates.map(x=>x.skill))].slice(0,8),evidenceMessageIds:[leading!.id],reason:'Choose which agent capability to use.'};else decision=empty('Mentioned agent unavailable or ambiguous');}
   else if(job.messages.length&&job.settings.mode!=='off') {
    const recent=await this.db.execute(sql`SELECT 1 FROM navigator_suggestions WHERE thread_id=${job.thread_id} AND created_at>now()-(${job.settings.cooldown_seconds}*interval '1 second') LIMIT 1`);
    if(!recent.rows.length||(job.settings.mode==='semantic'&&workState.sessions.some(session=>session.state==='active'))){
     const intentOnly=job.settings.mode==='semantic'&&(this.providers.level1?.name==='jev'||workState.sessions.some(session=>session.state==='active'));
     route=intentOnly?'level1':'rules';
     decision=intentOnly?empty('No clear new execution request'):rulesDecision({...context,messages:job.messages.map(m=>({id:m.id,text:m.routing_text??m.text}))});
     if(decision.action==='ignore'&&job.settings.mode==='semantic'){route='level1';decision=await this.infer(job,context,1)??(this.providers.level1?.name==='jev'&&context.messages.find(m=>m.id===context.pendingMessageIds?.at(-1))?.truncated?{...empty('Read the full request with the deeper router'),action:'escalate'}:decision);if(decision.action==='escalate'){route='level2';decision=await this.infer(job,context,2)??empty('Escalation provider unavailable');}}
    }
   }
   if(decision.action==='read_context'){
    const ids=decision.readMessageIds!;
    const retrieved=await rows<Message>(this.db,sql`SELECT id,text,document FROM messages WHERE channel_id=${job.channel_id} AND thread_id=${job.thread_id} AND id IN (${sql.join(ids.map(id=>sql`${id}`),sql`,`)}) LIMIT 8`);
    context.retrievedMessages=retrieved.map(m=>{const value=routingText(m);let excerpt=value.slice(0,2000).replace(/[\uD800-\uDBFF]$/,'');while(Buffer.byteLength(excerpt,'utf8')>Math.floor(8000/Math.max(1,retrieved.length)))excerpt=excerpt.slice(0,-1).replace(/[\uD800-\uDBFF]$/,'');return {id:m.id,text:excerpt,truncated:excerpt.length<value.length};});
    decision=await this.infer(job,context,2,3)??empty('Additional context could not be evaluated');
   }
   await this.finish(job,route,decision,candidate);
   await this.routing.drain(job.thread_id);
   return true;
 }
 private async finish(job:Job,route:string,decision:NavigationDecision,candidate?:NavigatorCandidate) {
  await sessionTransaction(this.db,async c=>{
   const [channel]=await c.select().from(s.channels).where(eq(s.channels.id,job.channel_id));
   const [queue]=await rows<{thread_id:string}>(c,sql`SELECT thread_id FROM navigator_threads WHERE thread_id=${job.thread_id} AND last_sequence=${job.last_sequence}::bigint`);if(!queue)return;
   const liveSettings=await this.settings(c,job.channel_id);
   const original=await rows<Message>(c,sql`SELECT id,text,document FROM messages WHERE channel_id=${job.channel_id} AND thread_id=${job.thread_id} AND id IN (${sql.join(job.messages.map(m=>sql`${m.id}`),sql`,`)})`);
   const unchanged=job.messages.every(m=>original.some(row=>row.id===m.id&&row.text===m.text&&JSON.stringify(row.document??null)===JSON.stringify(m.document??null)));
   if(job.workStateHash&&['suggest','clarify','continue','stop'].includes(decision.action)){
    const currentState=await this.workState(c,job);
    const newer=await rows(c,sql`SELECT 1 FROM messages WHERE channel_id=${job.channel_id} AND thread_id=${job.thread_id} AND author_type='human' AND sequence>${job.head_sequence}::bigint LIMIT 1`);
    if(newer.length||navigationWorkStateHash(currentState)!==job.workStateHash)decision=empty('Conversation or work state changed during classification.');
   }
   let authorized=unchanged&&!!channel&&!channel.archived_at&&(route==='mention'||liveSettings.mode!=='off')&&(!route.startsWith('level')||liveSettings.mode==='semantic');
   for(const m of job.messages)if(!await hasChannelAccess(c,m.user_id,job.workspace_id,job.channel_id))authorized=false;
   if(route.startsWith('level')&&navigatorPolicyVersion(liveSettings)!==navigatorPolicyVersion(job.settings))authorized=false;
   const observed=route!=='mention'&&liveSettings.execution_mode==='observe';
   const current=await this.catalog(c,job.channel_id);
   if(candidate&&!current.some(a=>a.installation_id===candidate.installation_id&&a.skill===candidate.skill))authorized=false;
   const id=randomUUID(),through=job.messages.at(-1)?.sequence;
   if(through){
    let detail:unknown=decision;
    const advanced=await rows(c,sql`UPDATE navigator_threads SET last_sequence=${through}::bigint WHERE thread_id=${job.thread_id} AND last_sequence=${job.last_sequence}::bigint RETURNING thread_id`);
    if(!advanced.length)return;
    await c.execute(sql`INSERT INTO navigator_decisions(id,channel_id,thread_id,through_sequence,route,decision) VALUES(${id},${job.channel_id},${job.thread_id},${through}::bigint,${authorized?(observed?'observe':route):'unavailable'},${JSON.stringify(detail)}::jsonb) ON CONFLICT(thread_id,through_sequence) DO NOTHING`);
    if(authorized&&candidate){
     const goal=job.messages.map(m=>m.text).join('\n\n').slice(0,16000);
     const task=await this.start(c,job.messages.at(-1)!.user_id,job.workspace_id,job.thread_id,candidate,goal,`navigation:${job.thread_id}:${through}`,job.messages.length===1?job.messages[0]!.document:undefined);
     const authorization=await this.routing.recordStart(c,task,id,job.messages.at(-1)!.id,job.channel_id,liveSettings);
     detail={...decision,task_id:task.id,authorization_id:authorization};
    }else if(authorized&&!observed&&(decision.action==='continue'||decision.action==='stop')){
     const message=job.messages.at(-1)!;
     try{
      const authorization=await this.routing.follow(c,{decisionId:id,actor:message.user_id,messageId:message.id,channel:job.channel_id,thread:job.thread_id,session:decision.targetSessionId!,action:decision.action,goal:message.text,document:message.document,policyVersion:navigatorPolicyVersion(liveSettings)});
      detail={...decision,authorization_id:authorization};
     }catch(error){if(!(error instanceof AppError)||error.code==='session_conflict')throw error;authorized=false;detail={...decision,delivery_error:error.code};}
    }
    await c.execute(sql`UPDATE navigator_decisions SET route=${authorized?(observed?'observe':route):'unavailable'},decision=${JSON.stringify(detail)}::jsonb WHERE id=${id}`);
    const latestSettings=await this.settings(c,job.channel_id);
    if(authorized&&!observed&&!candidate&&(route==='mention'||latestSettings.mode!=='off')&&(!route.startsWith('level')||latestSettings.mode==='semantic')&&['suggest','clarify'].includes(decision.action)){
     const mentioned=route==='mention'?matchAgentMentions(job.messages[0]!.routing_text??job.messages[0]!.text,current).candidates:current;
     const selected=mentioned.filter(a=>decision.capabilities.includes(a.skill)).slice(0,20);
     if(selected.length||decision.action==='clarify')await c.execute(sql`INSERT INTO navigator_suggestions(id,channel_id,thread_id,actor_id,goal,candidates,decision,policy_version) VALUES(${id},${job.channel_id},${job.thread_id},${job.messages.at(-1)!.user_id},${job.messages.map(m=>m.text).join('\n\n').slice(0,16000)},${JSON.stringify(selected)}::jsonb,${JSON.stringify(decision)}::jsonb,${navigatorPolicyVersion(liveSettings)}) ON CONFLICT DO NOTHING`);
    }
   }
   await c.execute(sql`UPDATE navigator_threads SET available_at=CASE WHEN EXISTS(SELECT 1 FROM messages WHERE channel_id=${job.channel_id} AND thread_id=${job.thread_id} AND author_type='human' AND sequence>navigator_threads.last_sequence) THEN now() ELSE 'infinity'::timestamptz END WHERE thread_id=${job.thread_id}`);
  });
 }
}
