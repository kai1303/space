import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { ChatStore } from '@space/postgres/chat';
import { AgentSessionStore } from '@space/postgres/agent-sessions';
import { NavigatorStore } from '@space/postgres/navigator';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';
import type { NavigationContext, NavigationDecision, NavigatorProvider } from '@space/contracts';

if (!process.env.TEST_DATABASE_URL) throw Error('TEST_DATABASE_URL required');
const schema=`test_nav_orchestration_${randomUUID().replaceAll('-','')}`;
const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
const chat=new ChatStore(pool),sessions=new AgentSessionStore(pool);
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
function provider(decide:(c:NavigationContext)=>NavigationDecision|Promise<NavigationDecision>):NavigatorProvider {
 return {name:'fixture',model:'fixture',maxOutputTokens:100,async decide(c){return {decision:await decide(c),inputTokens:10,outputTokens:10};}};
}
const decision=(c:NavigationContext,action:string,extra={})=>({action,capabilities:[],evidenceMessageIds:[c.pendingMessageIds!.at(-1)!],reason:'Fixture routing',...extra} as NavigationDecision);
async function fixture(){
 const s=await bootstrap(pool);
 await pool.query('UPDATE agent_definitions SET capabilities=$2 WHERE id=$1',[s.definition_id,{skills:['demo.echo'],controls:{},persistent_sessions:true}]);
 const session=await sessions.create(s.owner_id,s.thread_id,{client_session_id:randomUUID(),installation_id:s.installation_id,title:'API fix',skill:'demo.echo'});
 const nav=new NavigatorStore(pool);
 await nav.configure(s.owner_id,s.channel_id,{mode:'semantic',daily_token_limit:1000000,cooldown_seconds:0});
 return {...s,session};
}
async function send(s:Awaited<ReturnType<typeof fixture>>,text:string,actor=s.owner_id){return chat.send(actor,s.channel_id,{thread_id:s.thread_id,text,client_message_id:randomUUID()});}
async function run(nav:NavigatorStore,thread:string){await pool.query('UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1',[thread]);return nav.processOne(thread);}

test('continuation reuses a known session once and records immutable authorization',async()=>{
 const s=await fixture();
 const nav=new NavigatorStore(pool,{level1:provider(c=>decision(c,'continue',{targetSessionId:s.session.id}))});
 const m=await send(s,'Apply the same fix to the worker');
 await Promise.all([run(nav,s.thread_id),run(nav,s.thread_id)]);
 await nav.processOne(s.thread_id);
 const turns=await pool.query('SELECT * FROM tasks WHERE session_id=$1',[s.session.id]);
 assert.equal(turns.rowCount,1);assert.equal(turns.rows[0].goal,m.text);assert.equal(turns.rows[0].requester_id,s.owner_id);
 const auth=(await pool.query('SELECT * FROM navigator_authorizations WHERE thread_id=$1',[s.thread_id])).rows;
 assert.equal(auth.length,1);assert.equal(auth[0].actor_id,s.owner_id);assert.equal(auth[0].source_message_id,m.id);assert.equal(auth[0].session_id,s.session.id);assert.equal(auth[0].scope,m.text);
 await assert.rejects(pool.query("UPDATE navigator_authorizations SET scope='changed' WHERE id=$1",[auth[0].id]),/immutable/);
});

test('busy follow-ups wait for completion events and retain collaborator approval',async()=>{
 const s=await fixture();const first=await sessions.send(s.owner_id,s.session.id,{text:'Fix API'},randomUUID());
 const nav=new NavigatorStore(pool,{level1:provider(c=>decision(c,'continue',{targetSessionId:s.session.id}))});
 await send(s,'Add regression coverage',s.collaborator_id);await run(nav,s.thread_id);
 assert.equal((await pool.query('SELECT 1 FROM tasks WHERE session_id=$1',[s.session.id])).rowCount,1);
 assert.equal((await pool.query("SELECT 1 FROM navigator_followups WHERE session_id=$1 AND status='pending'",[s.session.id])).rowCount,1);
 const before=(await pool.query("SELECT count(*)::int n FROM event_outbox WHERE kind='navigator.ready' AND aggregate_id=$1",[s.thread_id])).rows[0].n;
 await pool.query("UPDATE tasks SET status='completed' WHERE id=$1",[first.id]);
 const after=(await pool.query("SELECT count(*)::int n FROM event_outbox WHERE kind='navigator.ready' AND aggregate_id=$1",[s.thread_id])).rows[0].n;
 assert.ok(after>before,'completion durably wakes pending continuation');
 await Promise.all([nav.processOne(s.thread_id),nav.processOne(s.thread_id)]);
 const turns=(await pool.query('SELECT * FROM tasks WHERE session_id=$1 ORDER BY created_at',[s.session.id])).rows;
 assert.equal(turns.length,2);assert.equal(turns[1].requester_id,s.collaborator_id);assert.equal(turns[1].status,'awaiting_approval');
});

test('observe records decisions without new suggestions, continuations, or stops',async()=>{
 const s=await fixture();await new NavigatorStore(pool).configure(s.owner_id,s.channel_id,{execution_mode:'observe'});
 const first=await sessions.send(s.owner_id,s.session.id,{text:'Working'},randomUUID());
 for(const action of ['suggest','continue','stop']){
  const nav=new NavigatorStore(pool,{level1:provider(c=>decision(c,action,action==='suggest'?{capabilities:['demo.echo']}:{targetSessionId:s.session.id}))});
  await send(s,`Request ${action}`);await run(nav,s.thread_id);
 }
 assert.equal((await pool.query('SELECT 1 FROM tasks WHERE session_id=$1',[s.session.id])).rowCount,1);
 assert.equal((await pool.query('SELECT status FROM tasks WHERE id=$1',[first.id])).rows[0].status,'queued');
 assert.equal((await pool.query('SELECT 1 FROM navigator_followups WHERE thread_id=$1',[s.thread_id])).rowCount,0);
 assert.equal((await pool.query('SELECT 1 FROM navigator_suggestions WHERE thread_id=$1',[s.thread_id])).rowCount,0);
 const nav=new NavigatorStore(pool);assert.equal((await nav.observations(s.owner_id,s.channel_id)).length,3);
 await assert.rejects(nav.observations(s.collaborator_id,s.channel_id),{status:403});
});

test('deeper routing can retrieve only bounded messages once without replaying paid inference',async()=>{
 const s=await fixture();let calls=0;
 const m=await send(s,'x'.repeat(2500));
 const nav=new NavigatorStore(pool,{level1:provider(c=>decision(c,'escalate')),level2:provider(c=>{
  calls++;
  if(!c.retrievedMessages)return decision(c,'read_context',{readMessageIds:[m.id]});
  assert.equal(c.retrievedMessages.length,1);assert.equal(c.retrievedMessages[0]!.text.length,2000);assert.equal(c.retrievedMessages[0]!.truncated,true);
  return decision(c,'suggest',{capabilities:['demo.echo']});
 })});
 await run(nav,s.thread_id);await nav.processOne(s.thread_id);
 assert.equal(calls,2);assert.equal((await nav.suggestions(s.owner_id,s.channel_id,s.thread_id)).length,1);
 assert.equal((await pool.query('SELECT 1 FROM navigator_inferences WHERE thread_id=$1',[s.thread_id])).rowCount,3);
});

test('stop cancels queued follow-ups and only the session controller can stop',async()=>{
 const s=await fixture();const first=await sessions.send(s.owner_id,s.session.id,{text:'Working'},randomUUID());
 let action='continue';const nav=new NavigatorStore(pool,{level1:provider(c=>decision(c,action,{targetSessionId:s.session.id}))});
 await send(s,'Add coverage');await run(nav,s.thread_id);
 action='stop';await send(s,'Stop this work',s.collaborator_id);await run(nav,s.thread_id);
 assert.equal((await pool.query('SELECT status FROM tasks WHERE id=$1',[first.id])).rows[0].status,'queued');
 await send(s,'Stop this work');await run(nav,s.thread_id);await nav.processOne(s.thread_id);
 assert.equal((await pool.query('SELECT status FROM tasks WHERE id=$1',[first.id])).rows[0].status,'failed');
 assert.equal((await pool.query("SELECT 1 FROM navigator_followups WHERE session_id=$1 AND status='pending'",[s.session.id])).rowCount,0);
 assert.equal((await pool.query('SELECT 1 FROM tasks WHERE session_id=$1',[s.session.id])).rowCount,1);
});

test('queued follow-ups revalidate policy and access before dispatch',async()=>{
 for(const revoke of ['policy','membership','source']){
  const s=await fixture();const first=await sessions.send(s.owner_id,s.session.id,{text:'Working'},randomUUID());
  const nav=new NavigatorStore(pool,{level1:provider(c=>decision(c,'continue',{targetSessionId:s.session.id}))});
  const message=await send(s,'Continue',s.collaborator_id);await run(nav,s.thread_id);
  if(revoke==='policy')await nav.configure(s.owner_id,s.channel_id,{execution_mode:'observe'});
  else if(revoke==='source')await pool.query("UPDATE messages SET text='Do not continue' WHERE channel_id=$1 AND id=$2",[s.channel_id,message.id]);
  else await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[s.channel_id,s.collaborator_id]);
  await pool.query("UPDATE tasks SET status='completed' WHERE id=$1",[first.id]);await nav.processOne(s.thread_id);
  assert.equal((await pool.query('SELECT 1 FROM tasks WHERE session_id=$1',[s.session.id])).rowCount,1);
  assert.equal((await pool.query("SELECT 1 FROM navigator_followups WHERE session_id=$1 AND status='pending'",[s.session.id])).rowCount,0);
 }
});

test('two pending follow-ups are retained in order and are not mistaken for stale input',async()=>{
 const s=await fixture();
 const nav=new NavigatorStore(pool,{level1:provider(c=>decision(c,'continue',{targetSessionId:s.session.id}))});
 await send(s,'First follow-up');await send(s,'Second follow-up');
 await run(nav,s.thread_id);await run(nav,s.thread_id);
 const pending=(await pool.query("SELECT a.scope FROM navigator_followups f JOIN navigator_authorizations a ON a.id=f.id WHERE f.thread_id=$1 ORDER BY f.created_at",[s.thread_id])).rows;
 assert.deepEqual(pending.map(row=>row.scope),['First follow-up','Second follow-up']);
 const first=(await pool.query('SELECT * FROM tasks WHERE session_id=$1',[s.session.id])).rows[0];
 assert.equal(first.goal,'First follow-up');
 await pool.query("UPDATE tasks SET status='completed' WHERE id=$1",[first.id]);await nav.processOne(s.thread_id);
 assert.deepEqual((await pool.query('SELECT goal FROM tasks WHERE session_id=$1 ORDER BY created_at',[s.session.id])).rows.map(row=>row.goal),['First follow-up','Second follow-up']);
});

test('a source edit during inference cannot authorize the old request',async()=>{
 const s=await fixture();const m=await send(s,'Continue the original work');
 const nav=new NavigatorStore(pool,{level1:provider(async c=>{
  await pool.query("UPDATE messages SET text='Do not continue' WHERE channel_id=$1 AND id=$2",[s.channel_id,m.id]);
  return decision(c,'continue',{targetSessionId:s.session.id});
 })});
 await run(nav,s.thread_id);
 assert.equal((await pool.query('SELECT 1 FROM navigator_authorizations WHERE thread_id=$1',[s.thread_id])).rowCount,0);
});

test('manual stop cancels a pending continuation even after its active turn completes',async()=>{
 const s=await fixture();const task=await sessions.send(s.owner_id,s.session.id,{text:'Working'},randomUUID());
 const nav=new NavigatorStore(pool,{level1:provider(c=>decision(c,'continue',{targetSessionId:s.session.id}))});
 await send(s,'Continue');await run(nav,s.thread_id);
 await pool.query("UPDATE tasks SET status='completed' WHERE id=$1",[task.id]);
 await sessions.control(s.owner_id,s.session.id,'stop');await nav.processOne(s.thread_id);
 assert.equal((await pool.query('SELECT 1 FROM tasks WHERE session_id=$1',[s.session.id])).rowCount,1);
 assert.equal((await pool.query("SELECT 1 FROM navigator_followups WHERE session_id=$1 AND status='pending'",[s.session.id])).rowCount,0);
});

test('changing policy away and back during inference invalidates the original decision',async()=>{
 const s=await fixture();const settings=new NavigatorStore(pool);
 const nav=new NavigatorStore(pool,{level1:provider(async c=>{
  await settings.configure(s.owner_id,s.channel_id,{execution_mode:'observe'});
  await settings.configure(s.owner_id,s.channel_id,{execution_mode:'suggest'});
  return decision(c,'continue',{targetSessionId:s.session.id});
 })});
 await send(s,'Continue');await run(nav,s.thread_id);
 assert.equal((await pool.query('SELECT 1 FROM navigator_authorizations WHERE thread_id=$1',[s.thread_id])).rowCount,0);
});

test('a cached classification cannot authorize edits beyond the model excerpt after recovery',async()=>{
 const s=await fixture();let calls=0;
 const nav=new NavigatorStore(pool,{level1:provider(c=>{calls++;return decision(c,'escalate');}),level2:provider(c=>{calls++;return c.retrievedMessages?decision(c,'continue',{targetSessionId:s.session.id}):decision(c,'read_context',{readMessageIds:[c.pendingMessageIds!.at(-1)!]});})});
 const m=await send(s,'x'.repeat(1100)+' Continue now');
 const follow=nav.routing.follow.bind(nav.routing);
 nav.routing.follow=async()=>{throw Error('simulated interruption after inference');};
 await assert.rejects(run(nav,s.thread_id),/simulated interruption/);
 nav.routing.follow=follow;
 await pool.query('UPDATE messages SET text=$3 WHERE channel_id=$1 AND id=$2',[s.channel_id,m.id,'x'.repeat(1100)+' Do not continue']);
 await run(nav,s.thread_id);
 assert.equal(calls,3);assert.equal((await pool.query('SELECT 1 FROM tasks WHERE session_id=$1',[s.session.id])).rowCount,0);
});

test('host rejects a Level 1 context read even from an injected provider',async()=>{
 const s=await fixture();let deeperCalls=0;
 const nav=new NavigatorStore(pool,{level1:provider(c=>decision(c,'read_context',{readMessageIds:[c.pendingMessageIds!.at(-1)!]})),level2:provider(c=>{deeperCalls++;return decision(c,'suggest',{capabilities:['demo.echo']});})});
 await send(s,'Read more context');await run(nav,s.thread_id);
 assert.equal(deeperCalls,0);assert.equal((await nav.suggestions(s.owner_id,s.channel_id,s.thread_id)).length,0);
});

test('pending follow-ups are bounded and overflow is available for manager review',async()=>{
 const s=await fixture();await sessions.send(s.owner_id,s.session.id,{text:'Working'},randomUUID());
 const nav=new NavigatorStore(pool,{level1:provider(c=>decision(c,'continue',{targetSessionId:s.session.id}))});
 for(let i=0;i<33;i++){await send(s,`Follow-up ${i}`);await run(nav,s.thread_id);}
 assert.equal((await pool.query("SELECT 1 FROM navigator_followups WHERE thread_id=$1 AND status='pending'",[s.thread_id])).rowCount,32);
 const observations=await nav.observations(s.owner_id,s.channel_id);
 assert.equal((observations[0]!.decision as any).delivery_error,'followup_queue_full');
});

test('observation API is manager-scoped and settings round-trip without exposing policy internals',async()=>{
 const s=await fixture();const nav=new NavigatorStore(pool);
 await nav.configure(s.owner_id,s.channel_id,{execution_mode:'observe'});
 const api=createApi(new PostgresStore(pool),{allowDevelopmentTokens:true});
 try{
  const owner={authorization:`Bearer ${s.owner_token}`};
  const settings=await api.inject({method:'GET',url:`/v1/channels/${s.channel_id}/navigator`,headers:owner});
  assert.equal(settings.statusCode,200);assert.equal(settings.json().settings.execution_mode,'observe');assert.equal(settings.json().settings.policy_version,undefined);
  assert.equal((await api.inject({method:'PATCH',url:`/v1/channels/${s.channel_id}/navigator`,headers:owner,payload:settings.json().settings})).statusCode,200);
  assert.equal((await api.inject({method:'GET',url:`/v1/channels/${s.channel_id}/navigator/observations`,headers:owner})).statusCode,200);
  assert.equal((await api.inject({method:'GET',url:`/v1/channels/${s.channel_id}/navigator/observations`,headers:{authorization:`Bearer ${s.collaborator_token}`}})).statusCode,403);
 }finally{await api.close();}
});
