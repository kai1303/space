import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { ChatStore } from '@space/postgres/chat';
import { PostgresStore } from '@space/postgres/store';
import { AgentSessionStore } from '@space/postgres/agent-sessions';
import { NavigatorStore } from '@space/postgres/navigator';
import { MockConnector } from '@space/mock/connector';
import { deliverOne } from '@space/core/worker';
import { createApi } from '@space/server/api';
import { JevNavigatorProvider } from '@space/core/jev-navigator';
import { createServer } from 'node:http';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL required');
const schema = `test_nav_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
const chat = new ChatStore(pool), tasks = new PostgresStore(pool), nav = new NavigatorStore(pool);
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
async function fixture() { return bootstrap(pool); }
async function send(s: Awaited<ReturnType<typeof fixture>>, text: string, actor=s.owner_id, thread=s.thread_id) {
  return chat.send(actor, s.channel_id, { text, thread_id: thread, client_message_id: randomUUID() });
}
async function tick(thread?: string) {
  if (thread) await pool.query("UPDATE navigator_threads SET available_at=CASE WHEN thread_id=$1 THEN now() ELSE 'infinity'::timestamptz END WHERE lease_until IS NULL", [thread]);
  else await pool.query("UPDATE navigator_threads SET available_at=now() WHERE lease_until IS NULL");
  return nav.processOne();
}
async function drainTasks() { while (await deliverOne(tasks, [new MockConnector()])) {} }

test('mention sends atomically wake routing; duplicates make one task and owner dispatch is immediate', async () => {
  const s = await fixture();
  const input = { text: `@agent-${s.installation_id} summarize this`, thread_id: s.thread_id, client_message_id: randomUUID() };
  await Promise.all([chat.send(s.owner_id,s.channel_id,input),chat.send(s.owner_id,s.channel_id,input)]);
  assert.equal(await tick(), true);
  const rows = await pool.query('SELECT * FROM tasks WHERE thread_id=$1',[s.thread_id]);
  assert.equal(rows.rowCount,1); assert.equal(rows.rows[0].status,'queued');
  await drainTasks();
  const history = await chat.threadHistory(s.owner_id,s.thread_id);
  assert.ok(history.messages.some(m=>m.author.kind==='agent' && m.text.includes('Preparing')));
  assert.ok(history.messages.some(m=>m.author.kind==='agent' && m.text.includes('Mock result')));
  const receipt=(await pool.query("SELECT event FROM agent_event_receipts WHERE installation_id=$1 AND event->>'type'='execution.progress'",[s.installation_id])).rows[0];
  await tasks.acceptEvent(s.installation_id,receipt.event);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM messages WHERE task_id=$1',[rows.rows[0].id])).rows[0].n,2);
  await assert.rejects(pool.query('UPDATE messages SET agent_milestone=false WHERE task_id=$1 AND agent_milestone',[rows.rows[0].id]),/immutable/);
  await tick();
  assert.equal((await pool.query('SELECT * FROM tasks WHERE thread_id=$1',[s.thread_id])).rowCount,1);
});

test('ordinary discussion does not create agent turns after a completed mention', async () => {
  const s = await fixture();
  await nav.configure(s.owner_id,s.channel_id,{mode:'off'});
  await send(s,`@agent-${s.installation_id} draft a guide`); await tick(s.thread_id);
  await send(s,'Please make it shorter',s.collaborator_id); await tick(s.thread_id);
  await drainTasks();await tick(s.thread_id);
  assert.equal((await pool.query('SELECT 1 FROM tasks WHERE thread_id=$1',[s.thread_id])).rowCount,1);
  assert.equal(await nav.subscription(s.owner_id,s.thread_id),null);
  assert.equal((await pool.query('SELECT 1 FROM navigator_inferences WHERE channel_id=$1',[s.channel_id])).rowCount,0);
});

test('each explicit collaborator request preserves owner approval instead of inheriting a prior approval', async () => {
  const s = await fixture();
  await send(s,`@agent-${s.installation_id} draft`,s.collaborator_id); await tick(s.thread_id);
  const task=(await pool.query('SELECT * FROM tasks WHERE thread_id=$1',[s.thread_id])).rows[0];
  assert.equal(task.status,'awaiting_approval');
  await tasks.approveTask(s.owner_id,task.id); await drainTasks();
  await send(s,`@agent-${s.installation_id} Add examples`,s.collaborator_id); await tick(s.thread_id);
  const follow=(await pool.query('SELECT * FROM tasks WHERE thread_id=$1 ORDER BY created_at DESC',[s.thread_id])).rows[0];
  assert.notEqual(follow.id,task.id);assert.equal(follow.status,'awaiting_approval');
});

test('rules batch conversation into a suggestion, never execute, and acceptance is idempotent and scoped', async () => {
  const s = await fixture(), other=await fixture();
  await nav.configure(s.owner_id,s.channel_id,{mode:'rules',rules:[{skill:'demo.echo',keywords:['summarize','summary']}]});
  await send(s,'Could someone summarize our decisions?'); await send(s,'A short summary would help.'); await tick();
  const suggestions=await nav.suggestions(s.owner_id,s.channel_id,s.thread_id);
  assert.equal(suggestions.length,1);
  assert.equal((await pool.query('SELECT * FROM tasks WHERE thread_id=$1',[s.thread_id])).rowCount,0);
  await assert.rejects(nav.accept(other.owner_id,suggestions[0]!.id,s.installation_id,'demo.echo'),{status:404});
  const [a,b]=await Promise.all([nav.accept(s.owner_id,suggestions[0]!.id,s.installation_id,'demo.echo'),nav.accept(s.owner_id,suggestions[0]!.id,s.installation_id,'demo.echo')]);
  assert.equal(a.id,b.id); assert.equal(a.status,'queued');
  await drainTasks();
  await send(s,'Another summary'); await tick();
  assert.equal((await nav.suggestions(s.owner_id,s.channel_id,s.thread_id)).length,0);
});

test('revoked grants and membership prevent queued routing and suggestion acceptance', async () => {
  const s=await fixture();
  await nav.configure(s.owner_id,s.channel_id,{mode:'rules',rules:[{skill:'demo.echo',keywords:['summary']}]});
  await send(s,'Need a summary'); await tick();
  const [suggestion]=await nav.suggestions(s.owner_id,s.channel_id,s.thread_id);
  await pool.query('DELETE FROM agent_grants WHERE installation_id=$1',[s.installation_id]);
  await assert.rejects(nav.accept(s.owner_id,suggestion!.id,s.installation_id,'demo.echo'),{code:'agent_unavailable'});
  await send(s,`@agent-${s.installation_id} do it`); await tick();
  assert.equal((await pool.query('SELECT * FROM tasks WHERE thread_id=$1',[s.thread_id])).rowCount,0);
  await assert.rejects(nav.configure(s.collaborator_id,s.channel_id,{mode:'semantic'}),{status:403});
});

test('optional providers escalate once, cache decisions, and enforce persistent daily token budgets', async () => {
  const s=await fixture(); let fast=0, complex=0;
  const providers:ConstructorParameters<typeof NavigatorStore>[1]={level1:{name:'fixture-fast',model:'local',maxOutputTokens:100,async decide(ctx:any){fast++;return {decision:{action:'escalate',capabilities:[],evidenceMessageIds:ctx.messages.map((m:any)=>m.id),reason:'Dependencies unclear'},inputTokens:10,outputTokens:10};}},level2:{name:'fixture-reason',model:'local',maxOutputTokens:100,async decide(ctx:any){complex++;return {decision:{action:'suggest',capabilities:['demo.echo'],evidenceMessageIds:[ctx.messages[0].id],reason:'Can help'},inputTokens:10,outputTokens:10};}}};
  const semantic=new NavigatorStore(pool,providers);
  await nav.configure(s.owner_id,s.channel_id,{mode:'semantic',daily_token_limit:10000,cooldown_seconds:0});
  await send(s,'Analyze our dependencies'); await pool.query('UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1',[s.thread_id]); await semantic.processOne();
  assert.equal(fast,1); assert.equal(complex,1); assert.equal((await nav.suggestions(s.owner_id,s.channel_id,s.thread_id)).length,1);
  await nav.configure(s.owner_id,s.channel_id,{daily_token_limit:1});
  await send(s,'Investigate something else'); await pool.query('UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1',[s.thread_id]); await semantic.processOne();
  assert.equal(fast,1); assert.equal(complex,1);
});

test('API exposes scoped catalog, settings and suggestions, and denies unprivileged configuration', async()=>{
 const s=await fixture(); const api=createApi(tasks,{allowDevelopmentTokens:true});
 const owner={authorization:`Bearer ${s.owner_token}`},collaborator={authorization:`Bearer ${s.collaborator_token}`};
 try {
  const response=await api.inject({method:'GET',url:`/v1/channels/${s.channel_id}/navigator`,headers:owner});
  assert.equal(response.statusCode,200); assert.equal(response.json().candidates[0].installation_id,s.installation_id);
  assert.equal((await api.inject({method:'PATCH',url:`/v1/channels/${s.channel_id}/navigator`,headers:collaborator,payload:{mode:'semantic'}})).statusCode,403);
 } finally {await api.close();}
});

test('repeated direct requests start independent runs and quoted rich-text tags do not invoke',async()=>{
 const s=await fixture();
 await send(s,`@agent-${s.installation_id} first`);await tick();
 await send(s,`@agent-${s.installation_id} follow-up`);await tick();
 assert.equal((await pool.query('SELECT * FROM tasks WHERE thread_id=$1',[s.thread_id])).rowCount,2);
 await drainTasks();await tick();await drainTasks();
 assert.equal((await pool.query('SELECT count(DISTINCT session_id)::int AS n FROM tasks WHERE thread_id=$1',[s.thread_id])).rows[0].n,2);
 const other=await fixture(),tag=`@agent-${other.installation_id}`;
 await chat.send(other.owner_id,other.channel_id,{client_message_id:randomUUID(),thread_id:other.thread_id,text:tag,document:{ops:[{insert:tag},{insert:'\n',attributes:{'code-block':true}}]}});await tick();
 assert.equal((await pool.query('SELECT * FROM tasks WHERE thread_id=$1',[other.thread_id])).rowCount,0);
});

test('multi-skill explicit mentions offer only that installation even when navigation is off',async()=>{
 const s=await fixture();await pool.query(`UPDATE agent_definitions SET capabilities='{"skills":["demo.echo","writing.draft"],"controls":{}}' WHERE id=$1`,[s.definition_id]);
 await pool.query('INSERT INTO agent_grants(workspace_id,installation_id,channel_id,skill) VALUES($1,$2,$3,$4)',[s.workspace_id,s.installation_id,s.channel_id,'writing.draft']);
 await nav.configure(s.owner_id,s.channel_id,{mode:'off'});await send(s,`@agent-${s.installation_id} help`);await tick();
 const [suggestion]=await nav.suggestions(s.owner_id,s.channel_id,s.thread_id);
 assert.ok(suggestion);assert.equal(suggestion.candidates.length,2);assert.ok(suggestion.candidates.every(c=>c.installation_id===s.installation_id));
});

test('provider failures are charged once and never affect explicit routing',async()=>{
 const s=await fixture();let calls=0;
 const failing=new NavigatorStore(pool,{level1:{name:'broken',model:'fixture',maxOutputTokens:10,async decide(){calls++;throw new Error('provider secret');}}});
 await nav.configure(s.owner_id,s.channel_id,{mode:'semantic'});await send(s,'Can someone help with this?');await pool.query('UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1',[s.thread_id]);await failing.processOne();
 const inference=(await pool.query('SELECT * FROM navigator_inferences WHERE channel_id=$1',[s.channel_id])).rows[0];
 assert.equal(calls,1);assert.equal(inference.error,'provider_unavailable');assert.ok(inference.reserved_tokens>0);
 await send(s,`@agent-${s.installation_id} help`);await pool.query('UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1',[s.thread_id]);await failing.processOne();
 assert.equal(calls,1);assert.equal((await pool.query('SELECT * FROM tasks WHERE thread_id=$1',[s.thread_id])).rowCount,1);await drainTasks();
});

test('dismissed old requests and rich code examples do not retrigger keyword suggestions',async()=>{
 const s=await fixture();await nav.configure(s.owner_id,s.channel_id,{rules:[{skill:'demo.echo',keywords:['summary']}],cooldown_seconds:0});
 await send(s,'Need a summary');await tick();const [suggestion]=await nav.suggestions(s.owner_id,s.channel_id,s.thread_id);await nav.dismiss(s.owner_id,suggestion!.id);
 await send(s,'Thanks');await tick();assert.equal((await nav.suggestions(s.owner_id,s.channel_id,s.thread_id)).length,0);
 await chat.send(s.owner_id,s.channel_id,{client_message_id:randomUUID(),thread_id:s.thread_id,text:'summary',document:{ops:[{insert:'summary'},{insert:'\n',attributes:{'code-block':true}}]}});await tick();
 assert.equal((await nav.suggestions(s.owner_id,s.channel_id,s.thread_id)).length,0);
});

test('stale cached inference after grant revocation advances the thread without another model call',async()=>{
 const s=await fixture();let calls=0;const semantic=new NavigatorStore(pool,{level1:{name:'fixture',model:'fixture',maxOutputTokens:10,async decide(){calls++;throw new Error('Must not call');}}});
 await nav.configure(s.owner_id,s.channel_id,{mode:'semantic',cooldown_seconds:0});const m=await send(s,'Need help');
 await pool.query(`UPDATE agent_definitions SET capabilities='{"skills":["demo.echo","writing.draft"],"controls":{}}' WHERE id=$1`,[s.definition_id]);
 await pool.query('INSERT INTO agent_grants(workspace_id,installation_id,channel_id,skill) VALUES($1,$2,$3,$4)',[s.workspace_id,s.installation_id,s.channel_id,'writing.draft']);
 await pool.query('INSERT INTO navigator_inferences(thread_id,through_sequence,level,channel_id,provider,model,reserved_tokens,result) VALUES($1,$2,1,$3,$4,$4,5000,$5)',[s.thread_id,m.sequence,s.channel_id,'fixture',JSON.stringify({action:'suggest',capabilities:['demo.echo'],evidenceMessageIds:[m.id],reason:'Can help'})]);
 await pool.query('DELETE FROM agent_grants WHERE installation_id=$1 AND skill=$2',[s.installation_id,'demo.echo']);
 await pool.query('UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1',[s.thread_id]);assert.equal(await semantic.processOne(),true);assert.equal(calls,0);
 assert.equal((await pool.query('SELECT last_sequence::text AS n FROM navigator_threads WHERE thread_id=$1',[s.thread_id])).rows[0].n,m.sequence);
 await send(s,`@agent-${s.installation_id} draft this`);await tick();assert.equal((await pool.query('SELECT * FROM tasks WHERE thread_id=$1',[s.thread_id])).rowCount,1);
});

test('legacy subscriptions do not turn unmentioned messages into agent work',async()=>{
 const s=await fixture();await nav.configure(s.owner_id,s.channel_id,{mode:'off'});
 await send(s,`@agent-${s.installation_id} first`);await tick(s.thread_id);await drainTasks();
 const task=(await pool.query('SELECT * FROM tasks WHERE thread_id=$1',[s.thread_id])).rows[0];
 await pool.query("INSERT INTO agent_thread_subscriptions(thread_id,installation_id,skill,task_id,session_id,approved_by,status) VALUES($1,$2,'demo.echo',$3,$4,$5,'active')",[s.thread_id,s.installation_id,task.id,task.session_id,s.owner_id]);
 await send(s,'@unknown-agent hello');await tick(s.thread_id);await send(s,'Continue please');await tick(s.thread_id);
 assert.equal((await pool.query('SELECT 1 FROM tasks WHERE thread_id=$1',[s.thread_id])).rowCount,1);
 await nav.closeSubscription(s.owner_id,s.thread_id);assert.equal(await nav.subscription(s.owner_id,s.thread_id),null);
});

test('first queue wake on an existing thread does not replay historical agent mentions',async()=>{
 const s=await fixture();await send(s,`@agent-${s.installation_id} old request from before Navigator`);
 await pool.query('DELETE FROM navigator_threads WHERE thread_id=$1',[s.thread_id]);
 const latest=await send(s,'Hello today');await tick();
 assert.equal((await pool.query('SELECT * FROM tasks WHERE thread_id=$1',[s.thread_id])).rowCount,0);
 assert.equal((await pool.query('SELECT last_sequence::text AS n FROM navigator_threads WHERE thread_id=$1',[s.thread_id])).rows[0].n,latest.sequence);
});

test('semantic context is bounded by the selected batch before a later explicit tag',async()=>{
 const s=await fixture();let observed:any;
 const semantic=new NavigatorStore(pool,{level1:{name:'fixture',model:'fixture',maxOutputTokens:10,async decide(context){observed=context;return {decision:{action:'ignore',capabilities:[],evidenceMessageIds:[],reason:'No action'},inputTokens:1,outputTokens:1};}}});
 await nav.configure(s.owner_id,s.channel_id,{mode:'semantic',daily_token_limit:100000});
 const first=await send(s,'Please consider this first request');
 const task=await tasks.createTask(s.owner_id,{workspace_id:s.workspace_id,thread_id:s.thread_id,installation_id:s.installation_id,goal:'Legacy task',skill:'demo.echo'},randomUUID());
 await pool.query('INSERT INTO messages(id,workspace_id,channel_id,thread_id,task_id,installation_id,text) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),s.workspace_id,s.channel_id,s.thread_id,task.id,s.installation_id,'A later unrelated agent reply']);
 await send(s,`@agent-${s.installation_id} second request`);
 for(let i=0;i<18;i++)await send(s,`Later context ${i}`);
 await pool.query('UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1',[s.thread_id]);await semantic.processOne();
 assert.equal(observed.workingMemory.root.id,first.id);assert.equal(observed.workingMemory.memory,null);assert.deepEqual(observed.pendingMessageIds,[first.id]);assert.ok(observed.messages.some((m:any)=>m.id===first.id));assert.ok(!observed.messages.some((m:any)=>m.text.includes('later unrelated')));
 await pool.query("UPDATE navigator_threads SET available_at='infinity' WHERE thread_id=$1",[s.thread_id]);
});


test('native Jev classifies the last human message, persists separate intent and charges its full request before inference',async()=>{
 const s=await fixture();let received:any,calls=0;
 const server=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{received=JSON.parse(body);calls++;res.end(JSON.stringify({model:'jev-1.14.0',answers:{requests_agent_work:{type:'noul',noul:calls===1?.97:.01},task_clear:{type:'noul',noul:.98},continues_existing_work:{type:'noul',noul:.01},capability_0:{type:'noul',noul:.95}},usage:{input_tokens:120,output_tokens:25}}));});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const provider=new JevNavigatorProvider({endpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1/systemone`,apiKey:'fixture-key'});
 const semantic=new NavigatorStore(pool,{level1:provider});
 try{
  await nav.configure(s.owner_id,s.channel_id,{mode:'semantic',daily_token_limit:100000,cooldown_seconds:0,rules:[{skill:'demo.echo',keywords:['summarize']}]});
  const prior=await send(s,'Should we ask an agent to summarize this?');const last=await send(s,'Yes, please do that.');
  await pool.query('UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1',[s.thread_id]);await semantic.processOne();
  assert.equal(calls,1);assert.equal(received.state.last_message.id,last.id);assert.equal(received.state.last_message.author.kind,'human');assert.ok(received.state.history.some((m:any)=>m.id===prior.id));
  const [suggestion]=await nav.suggestions(s.owner_id,s.channel_id,s.thread_id);
  assert.equal(suggestion!.decision.assessment?.targetMessageId,last.id);assert.equal(suggestion!.decision.assessment?.requestsAgentWork,.97);
  assert.equal((await pool.query('SELECT * FROM tasks WHERE thread_id=$1',[s.thread_id])).rowCount,0,'inference never authorizes execution');
  const inference=(await pool.query('SELECT * FROM navigator_inferences WHERE thread_id=$1',[s.thread_id])).rows[0];
  assert.equal(inference.provider,'jev');assert.ok(inference.reserved_tokens>=Buffer.byteLength(JSON.stringify(received)));assert.equal(inference.input_tokens,120);
  await send(s,'Do not summarize anything else.');
  await pool.query('UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1',[s.thread_id]);await semantic.processOne(s.thread_id);
  assert.equal(received.state.work_state.pendingProposals[0].id,suggestion!.id);
  assert.equal(received.state.work_state.tasks.length,0);
  assert.equal(calls,2,'Jev classifies even when a configured keyword matches');
  await nav.accept(s.owner_id,suggestion!.id,s.installation_id,'demo.echo');await drainTasks();
  await send(s,'Thanks for the result.');await pool.query('UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1',[s.thread_id]);await semantic.processOne(s.thread_id);
  assert.equal(received.state.work_state.pendingProposals.length,0);
  assert.equal(received.state.work_state.tasks[0].status,'completed');
  await nav.configure(s.owner_id,s.channel_id,{daily_token_limit:1});await send(s,'Can we do something else?');await pool.query('UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1',[s.thread_id]);await semantic.processOne();assert.equal(calls,3);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('semantic agent mentions survive renames and semantic people mentions cannot invoke a namesake agent',async()=>{
 const s=await fixture();
 await pool.query('UPDATE users SET display_name=$1 WHERE id=$2',['Mock echo agent',s.collaborator_id]);
 const person={kind:'user',id:s.collaborator_id,label:'Mock echo agent'};
 await chat.send(s.owner_id,s.channel_id,{client_message_id:randomUUID(),thread_id:s.thread_id,text:'@Mock echo agent hello',document:{ops:[{insert:'@Mock echo agent',attributes:{mention:person}},{insert:' hello\n'}]}});
 await tick(s.thread_id);assert.equal((await pool.query('SELECT * FROM tasks WHERE thread_id=$1',[s.thread_id])).rowCount,0);
 await pool.query('UPDATE agent_definitions SET name=$1 WHERE id=$2',['Renamed agent',s.definition_id]);
 const agent={kind:'agent',id:s.installation_id,label:'Old label'};
 await chat.send(s.owner_id,s.channel_id,{client_message_id:randomUUID(),thread_id:s.thread_id,text:'@Old label summarize',document:{ops:[{insert:'@Old label',attributes:{mention:agent}},{insert:' summarize\n'}]}});
 await tick(s.thread_id);
 const tasks=await pool.query('SELECT * FROM tasks WHERE thread_id=$1',[s.thread_id]);assert.equal(tasks.rowCount,1);assert.equal(tasks.rows[0].installation_id,s.installation_id);assert.equal(tasks.rows[0].status,'queued');
});

test('a Codex mention creates one persistent session and a durable thread entry; discussion never becomes a follow-up',async()=>{
 const s=await fixture();
 await pool.query('UPDATE agent_definitions SET capabilities=$2 WHERE id=$1',[s.definition_id,{skills:['codex.run'],controls:{},persistent_sessions:true}]);
 await pool.query("UPDATE agent_installations SET connector_id='codex.legacy-test' WHERE id=$1",[s.installation_id]);
 await pool.query("INSERT INTO agent_connections(installation_id,name) VALUES($1,'Local test agent')",[s.installation_id]);
 await pool.query("UPDATE agent_grants SET skill='codex.run' WHERE installation_id=$1",[s.installation_id]);
 await nav.configure(s.owner_id,s.channel_id,{mode:'off'});
 const input={text:`@agent-${s.installation_id} Remember the project name is Aurora`,thread_id:s.thread_id,client_message_id:randomUUID()};
 await Promise.all([chat.send(s.owner_id,s.channel_id,input),chat.send(s.owner_id,s.channel_id,input)]);await tick(s.thread_id);
 const first=(await pool.query('SELECT t.*,a.managed FROM tasks t JOIN agent_sessions a ON a.id=t.session_id WHERE t.thread_id=$1',[s.thread_id])).rows;
 assert.equal(first.length,1);assert.equal(first[0].managed,true);assert.equal(first[0].status,'queued');
 const history=await chat.threadHistory(s.owner_id,s.thread_id);
 const references=history.messages.filter(m=>m.agent_session_id);
 assert.equal(references.length,1);assert.equal(references[0]!.agent_session_id,first[0].session_id);
 const parent=history.messages.find(m=>m.author.kind==='human')!;
 assert.equal(parent.agent_sessions?.[0]?.id,first[0].session_id);
 assert.equal(parent.reply_count,0);
 assert.equal((await chat.messageHistory(s.owner_id,s.channel_id)).messages.find(m=>m.id===parent.id)?.agent_sessions?.[0]?.id,first[0].session_id);
 await send(s,'An ordinary discussion reply',s.collaborator_id);await tick(s.thread_id);
 assert.equal((await pool.query('SELECT 1 FROM tasks WHERE thread_id=$1',[s.thread_id])).rowCount,1);
 await send(s,`@agent-${s.installation_id} Start another independent idea`);await tick(s.thread_id);
 assert.equal((await pool.query('SELECT 1 FROM agent_sessions WHERE origin_thread_id=$1 AND managed',[s.thread_id])).rowCount,2);
 const delivery=(await tasks.claimDelivery(s.installation_id))!;
 assert.deepEqual((await tasks.prepareDelivery(delivery))!.request.persistent_session,{resume:false});
 const event=(sequence:number,type:string,payload:Record<string,unknown>)=>({id:randomUUID(),schema_version:'1.0' as const,execution_id:delivery.execution_id,sequence,type,occurred_at:new Date().toISOString(),payload});
 await tasks.acceptEvent(s.installation_id,event(1,'execution.started',{text:'Working'}),delivery);
 await tasks.acceptEvent(s.installation_id,event(2,'execution.progress',{text:'Ready',session_ready:true}),delivery);
 await tasks.acceptEvent(s.installation_id,event(3,'execution.completed',{text:'A private session answer'}),delivery);await tasks.ackDelivery(delivery);
 const saved=await chat.threadHistory(s.owner_id,s.thread_id);
 assert.equal(saved.messages.filter(m=>m.agent_session_id===first[0].session_id).length,1);
 assert.ok(!saved.messages.some(m=>m.text==='A private session answer'));
 const sessions=new AgentSessionStore(pool);
 const continued=await sessions.send(s.owner_id,first[0].session_id,{text:'Continue inside this session'},randomUUID());
 assert.equal(continued.session_id,first[0].session_id);
 let received:any;
 const jev=new JevNavigatorProvider({apiKey:'fixture',fetch:async(_url,init)=>{received=JSON.parse(String(init?.body));return new Response('{}');}});
 const semantic=new NavigatorStore(pool,{level1:jev});
 await nav.configure(s.owner_id,s.channel_id,{mode:'semantic',daily_token_limit:100000,cooldown_seconds:0});
 await send(s,'Public discussion of existing work');await pool.query('UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1',[s.thread_id]);await semantic.processOne(s.thread_id);
 assert.equal(received.state.work_state.sessions.length,2);
 assert.ok(received.state.work_state.tasks.some((t:any)=>t.id===first[0].id));
 assert.ok(!JSON.stringify(received).includes('Continue inside this session'));
 assert.ok(!JSON.stringify(received).includes('A private session answer'));

});

test('Jev ignores a legacy cached proactive suggestion without paying for a replay',async()=>{
 const s=await fixture();let calls=0;
 const provider=new JevNavigatorProvider({apiKey:'fixture',fetch:async()=>{calls++;throw Error('must not call');}});
 const semantic=new NavigatorStore(pool,{level1:provider});
 await nav.configure(s.owner_id,s.channel_id,{mode:'semantic',daily_token_limit:100000,cooldown_seconds:0});
 const m=await send(s,'This is frustrating.');
 const legacy={action:'suggest',capabilities:['demo.echo'],evidenceMessageIds:[m.id],reason:'Useful assistance',assessment:{model:'jev-old',targetMessageId:m.id,requestsAgentWork:.02,assistanceUseful:.98,needsDeeperReasoning:.01,capabilityRelevance:{'demo.echo':.99}}};
 await pool.query("INSERT INTO navigator_inferences(thread_id,through_sequence,level,channel_id,provider,model,reserved_tokens,result) VALUES($1,$2,1,$3,'jev','jev-old',100,$4)",[s.thread_id,m.sequence,s.channel_id,legacy]);
 await pool.query('UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1',[s.thread_id]);await semantic.processOne(s.thread_id);
 assert.equal(calls,0);assert.equal((await nav.suggestions(s.owner_id,s.channel_id,s.thread_id)).length,0);
});

test('semantic Jev stays quiet on keyword discussion and unavailable inference',async()=>{
 const s=await fixture();let calls=0;
 const provider=new JevNavigatorProvider({apiKey:'fixture',fetch:async()=>{calls++;return new Response(JSON.stringify({model:'fixture',answers:{requests_agent_work:{type:'noul',noul:.01},task_clear:{type:'noul',noul:.99},continues_existing_work:{type:'noul',noul:.01},capability_0:{type:'noul',noul:.99}},usage:{input_tokens:100,output_tokens:10}}));}});
 const semantic=new NavigatorStore(pool,{level1:provider});
 await nav.configure(s.owner_id,s.channel_id,{mode:'semantic',daily_token_limit:100000,cooldown_seconds:0,rules:[{skill:'demo.echo',keywords:['summarize']}]});
 await send(s,'Do not summarize this yet.');await pool.query('UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1',[s.thread_id]);await semantic.processOne(s.thread_id);
 assert.equal(calls,1);assert.equal((await nav.suggestions(s.owner_id,s.channel_id,s.thread_id)).length,0);
 await nav.configure(s.owner_id,s.channel_id,{daily_token_limit:0});await send(s,'Please summarize this.');await pool.query('UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1',[s.thread_id]);await semantic.processOne(s.thread_id);
 assert.equal(calls,1);assert.equal((await nav.suggestions(s.owner_id,s.channel_id,s.thread_id)).length,0);
});

test('accepting a proposal during Jev inference invalidates fresh and cached suggestions',async()=>{
 const s=await fixture();
 await nav.configure(s.owner_id,s.channel_id,{mode:'rules',cooldown_seconds:0,rules:[{skill:'demo.echo',keywords:['summarize']}]});
 await send(s,'Please summarize the launch.');await tick(s.thread_id);
 const [original]=await nav.suggestions(s.owner_id,s.channel_id,s.thread_id);
 const previous=(await pool.query('SELECT last_sequence FROM navigator_threads WHERE thread_id=$1',[s.thread_id])).rows[0].last_sequence;
 let release!:()=>void,entered!:()=>void,calls=0;
 const ready=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
 const provider=new JevNavigatorProvider({apiKey:'fixture',fetch:async()=>{calls++;entered();await wait;return new Response(JSON.stringify({model:'fixture',answers:{requests_agent_work:{type:'noul',noul:.99},task_clear:{type:'noul',noul:.99},continues_existing_work:{type:'noul',noul:.01},capability_0:{type:'noul',noul:.99}},usage:{input_tokens:100,output_tokens:10}}));}});
 const semantic=new NavigatorStore(pool,{level1:provider});
 await nav.configure(s.owner_id,s.channel_id,{mode:'semantic',daily_token_limit:100000});
 await send(s,'Yes, do that.');await pool.query('UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1',[s.thread_id]);
 const processing=semantic.processOne(s.thread_id);await ready;
 try{await nav.accept(s.owner_id,original!.id,s.installation_id,'demo.echo');}finally{release();}
 await processing;
 assert.equal((await nav.suggestions(s.owner_id,s.channel_id,s.thread_id)).length,0);
 await pool.query('UPDATE navigator_threads SET last_sequence=$2,available_at=now() WHERE thread_id=$1',[s.thread_id,previous]);
 await semantic.processOne(s.thread_id);
 assert.equal((await nav.suggestions(s.owner_id,s.channel_id,s.thread_id)).length,0);
 assert.equal(calls,1);assert.equal((await pool.query('SELECT 1 FROM tasks WHERE thread_id=$1',[s.thread_id])).rowCount,1);
});

test('Jev context excludes rich quotation and code instructions, including earlier proposals',async()=>{
 const s=await fixture();let received:any;
 const provider=new JevNavigatorProvider({apiKey:'fixture',fetch:async(_url,init)=>{received=JSON.parse(String(init?.body));return new Response('{}');}});
 const semantic=new NavigatorStore(pool,{level1:provider});
 await nav.configure(s.owner_id,s.channel_id,{mode:'semantic',daily_token_limit:100000,cooldown_seconds:0});
 await chat.send(s.owner_id,s.channel_id,{client_message_id:randomUUID(),thread_id:s.thread_id,text:'Please summarize the quoted request.\nJust an example',document:{ops:[{insert:'Please summarize the quoted request.'},{insert:'\n',attributes:{blockquote:true}},{insert:'Just an example\n'}]}});
 await chat.send(s.owner_id,s.channel_id,{client_message_id:randomUUID(),thread_id:s.thread_id,text:'Please investigate the code example.\nStill an example',document:{ops:[{insert:'Please investigate the code example.'},{insert:'\n',attributes:{'code-block':true}},{insert:'Still an example\n'}]}});
 await pool.query('UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1',[s.thread_id]);await semantic.processOne(s.thread_id);
 assert.ok(received);assert.ok(!JSON.stringify(received.state).includes('Please summarize'));
 assert.ok(!JSON.stringify(received.state).includes('Please investigate'));
 assert.match(received.state.last_message.text,/Still an example/);
});

test('routed session requests retain rich mentions and recover matching legacy requests',async()=>{
 const s=await fixture();
 await pool.query('UPDATE agent_definitions SET capabilities=$2 WHERE id=$1',[s.definition_id,{skills:['demo.echo'],controls:{},persistent_sessions:true}]);
 const mention={kind:'agent',id:s.installation_id,label:'Old label'};
 const message=await chat.send(s.owner_id,s.channel_id,{client_message_id:randomUUID(),thread_id:s.thread_id,text:'@Old label summarize',document:{ops:[{insert:'@Old label',attributes:{mention}},{insert:' summarize\n'}]}});
 await tick(s.thread_id);
 const task=(await pool.query('SELECT * FROM tasks WHERE thread_id=$1',[s.thread_id])).rows[0];
 assert.deepEqual(task.request_document,message.document);
 const sessions=new AgentSessionStore(pool);
 assert.deepEqual((await sessions.read(s.owner_id,task.session_id)).turns[0]!.task.request_document,message.document);
 // Simulate pre-fix rows without changing the production immutability rule.
 await pool.query('ALTER TABLE tasks DISABLE TRIGGER tasks_immutable_document');
 try{await pool.query('UPDATE tasks SET request_document=NULL WHERE id=$1',[task.id]);}
 finally{await pool.query('ALTER TABLE tasks ENABLE TRIGGER tasks_immutable_document');}
 assert.deepEqual((await sessions.read(s.owner_id,task.session_id)).turns[0]!.task.request_document,message.document);
 await pool.query("UPDATE messages SET text='Edited after dispatch' WHERE id=$1",[message.id]);
 assert.equal((await sessions.read(s.owner_id,task.session_id)).turns[0]!.task.request_document,null);
});
