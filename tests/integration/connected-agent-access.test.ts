import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { AgentConnectionStore } from '@space/postgres/agent-connections';
import { NavigatorStore } from '@space/postgres/navigator';
import { AgentSessionStore } from '@space/postgres/agent-sessions';
import { PostgresStore } from '@space/postgres/store';
import { MemoryStore } from '@space/postgres/memory';
import { createApi } from '@space/server/api';
import { FoundationStore } from '@space/postgres/foundation';
import { ChatStore } from '@space/postgres/chat';

const schema=`connected_access_${randomBytes(8).toString('hex')}`;
const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
const connections=new AgentConnectionStore(pool),nav=new NavigatorStore(pool),sessions=new AgentSessionStore(pool),tasks=new PostgresStore(pool),chat=new ChatStore(pool);
before(async()=>{if(!process.env.TEST_DATABASE_URL)throw Error('TEST_DATABASE_URL required');await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
// Exercise queued delivery here; direct Codex admission has its own integration suite.
async function fixture(){const seed=await bootstrap(pool);const pairing=await connections.createPairing(seed.owner_id,seed.workspace_id,{});const agent=await connections.claim({code:pairing.code,credential:randomBytes(32).toString('base64url')});await pool.query("UPDATE agent_installations SET connector_id='codex.legacy-test' WHERE id=$1",[agent.installation_id]);return {...seed,connected_id:agent.installation_id};}
const input=(s:Awaited<ReturnType<typeof fixture>>)=>({workspace_id:s.workspace_id,thread_id:s.thread_id,installation_id:s.connected_id,skill:'codex.run',goal:'Investigate the issue'});

test('connected agents inherit owner channel access for discovery, sessions and routing with no grants',async()=>{
 const s=await fixture();
 assert.equal((await pool.query('SELECT 1 FROM agent_grants WHERE installation_id=$1',[s.connected_id])).rowCount,0);
 const catalog=await nav.read(s.owner_id,s.channel_id);
 assert.ok(catalog.candidates.some(c=>c.installation_id===s.connected_id&&c.skill==='codex.run'));
 assert.ok((await new FoundationStore(pool).list(s.collaborator_id,s.workspace_id)).some(a=>a.id===s.connected_id));
 const owned=await connections.channelAgents(s.owner_id,s.channel_id);
 assert.ok(owned.some(a=>a.id===s.connected_id&&a.enabled_in_channel&&a.inherits_owner_access));
 assert.ok((await chat.mentions.search(s.owner_id,s.channel_id,{})).items.some(a=>a.kind==='agent'&&a.id===s.connected_id));
 const session=await sessions.create(s.owner_id,s.thread_id,{client_session_id:randomUUID(),installation_id:s.connected_id,title:'Owner session'});
 assert.equal(session.skill,'codex.run');
 const turn=await sessions.send(s.owner_id,session.id,{text:'Do the work'},randomUUID());assert.equal(turn.status,'queued');
 await chat.send(s.collaborator_id,s.channel_id,{client_message_id:randomUUID(),thread_id:s.thread_id,text:`@agent-${s.connected_id} independent task`});
 await pool.query('UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1',[s.thread_id]);await nav.processOne(s.thread_id);
 const routed=(await pool.query('SELECT * FROM tasks WHERE thread_id=$1 AND requester_id=$2',[s.thread_id,s.collaborator_id])).rows[0];
 assert.equal(routed.status,'awaiting_approval');
 await assert.rejects(tasks.approveTask(s.collaborator_id,routed.id),/approval_not_authorized/);
 await tasks.approveTask(s.owner_id,routed.id);
});

test('connected agents follow owner membership dynamically across channels, including private conversations',async()=>{
 const s=await fixture(),foreign=await fixture();
 const ch=await chat.createChannel(s.collaborator_id,s.workspace_id,{name:'new-private',private:true});
 const m=await chat.send(s.collaborator_id,ch.id,{client_message_id:randomUUID(),text:'A task'});
 const work={...input(s),thread_id:m.thread_id};
 assert.ok(!(await nav.read(s.collaborator_id,ch.id)).candidates.some(c=>c.installation_id===s.connected_id));
 await assert.rejects(tasks.createTask(s.collaborator_id,work,randomUUID()),/installation_not_authorized/);
 await pool.query('INSERT INTO channel_members(workspace_id,channel_id,user_id) VALUES($1,$2,$3)',[s.workspace_id,ch.id,s.owner_id]);
 assert.ok((await nav.read(s.collaborator_id,ch.id)).candidates.some(c=>c.installation_id===s.connected_id));
 const task=await tasks.createTask(s.collaborator_id,work,randomUUID());assert.equal(task.status,'awaiting_approval');
 await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[ch.id,s.owner_id]);
 await assert.rejects(tasks.approveTask(s.owner_id,task.id));
 await assert.rejects(tasks.createTask(foreign.owner_id,work,randomUUID()));
 await assert.rejects(tasks.createTask(foreign.owner_id,{...input(foreign),installation_id:s.connected_id},randomUUID()));
});

test('owner access loss fences an in-flight connected execution even without channel grants',async()=>{
 const s=await fixture();const task=await tasks.createTask(s.owner_id,input(s),randomUUID());await tasks.approveTask(s.owner_id,task.id);
 const delivery=(await tasks.claimDelivery(s.connected_id))!;assert.ok(delivery);
 assert.ok(await tasks.prepareDelivery(delivery));
 await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[s.channel_id,s.owner_id]);
 const event={id:randomUUID(),schema_version:'1.0' as const,execution_id:delivery.execution_id,sequence:1,type:'execution.started',occurred_at:new Date().toISOString(),payload:{text:'Working'}};
 await assert.rejects(tasks.acceptEvent(s.connected_id,event,delivery),/installation_not_authorized/);
 assert.equal((await pool.query('SELECT 1 FROM messages WHERE task_id=$1',[task.id])).rowCount,0);
});

test('revoked connections cannot fall back to legacy grants and obsolete channel disabling is explicit',async()=>{
 const s=await fixture();
 await connections.setChannelEnabled(s.owner_id,s.connected_id,s.channel_id,true);
 assert.equal((await pool.query('SELECT 1 FROM agent_grants WHERE installation_id=$1',[s.connected_id])).rowCount,0);
 await assert.rejects(connections.setChannelEnabled(s.owner_id,s.connected_id,s.channel_id,false),/agent_inherits_owner_access/);
 const foundation=new FoundationStore(pool);
 for(const method of ['grant','revoke'] as const)await assert.rejects(foundation[method](s.owner_id,s.connected_id,{channel_id:s.channel_id,skill:'codex.run'}),/agent_inherits_owner_access/);
 await pool.query('INSERT INTO agent_grants(workspace_id,installation_id,channel_id,skill) VALUES($1,$2,$3,$4)',[s.workspace_id,s.connected_id,s.channel_id,'codex.run']);
 await pool.query('UPDATE agent_connections SET revoked_at=now() WHERE installation_id=$1',[s.connected_id]);
 assert.ok(!(await nav.read(s.owner_id,s.channel_id)).candidates.some(c=>c.installation_id===s.connected_id));
 await assert.rejects(tasks.createTask(s.owner_id,input(s),randomUUID()),/installation_not_authorized/);
});

test('a connected agent can work in its owner’s DM but cannot see another user’s private DM',async()=>{
 const s=await fixture();
 const direct=await chat.directMessages.open(s.owner_id,s.workspace_id,{user_id:s.collaborator_id});
 const owned=await connections.channelAgents(s.owner_id,direct.id);
 assert.ok(owned.some(a=>a.id===s.connected_id));assert.ok(!owned.some(a=>a.id===s.installation_id));
 const message=await chat.send(s.owner_id,direct.id,{client_message_id:randomUUID(),text:'A private task'});
 assert.ok((await nav.read(s.owner_id,direct.id)).candidates.some(c=>c.installation_id===s.connected_id));
 const task=await tasks.createTask(s.owner_id,{...input(s),thread_id:message.thread_id},randomUUID());assert.equal(task.status,'awaiting_approval');
 const deliveryStore=new PostgresStore(pool),app=createApi(deliveryStore,{allowDevelopmentTokens:true});
 try{
  await deliveryStore.approveTask(s.owner_id,task.id);const delivery=(await deliveryStore.claimDelivery(s.connected_id))!;
  const prepared=await deliveryStore.prepareDelivery(delivery);assert.ok(prepared);assert.equal(prepared.request.context?.channel_memory,undefined);
 }finally{await app.close();}
 const self=await chat.directMessages.open(s.collaborator_id,s.workspace_id,{user_id:s.collaborator_id});
 assert.ok(!(await nav.read(s.collaborator_id,self.id)).candidates.some(c=>c.installation_id===s.connected_id));
});

test('Navigator applies owner visibility before its bounded candidate limit',async()=>{
 const s=await fixture();
 const ch=await chat.createChannel(s.owner_id,s.workspace_id,{name:'private-catalog',private:true});
 const definition=(await pool.query('SELECT definition_id FROM agent_installations WHERE id=$1',[s.connected_id])).rows[0].definition_id;
 await pool.query("INSERT INTO agent_installations(id,workspace_id,owner_id,definition_id,connector_id) SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1,$2,$3,'codex.local' FROM generate_series(1,101) n",[s.workspace_id,s.collaborator_id,definition]);
 await pool.query("INSERT INTO agent_connections(installation_id,name) SELECT id,'Other owner agent' FROM agent_installations WHERE workspace_id=$1 AND owner_id=$2",[s.workspace_id,s.collaborator_id]);
 assert.ok((await nav.read(s.owner_id,ch.id)).candidates.some(c=>c.installation_id===s.connected_id));
});

test('connected task access removes the skill-grant prerequisite without enabling channel memory',async()=>{
 const s=await fixture(),memory=new MemoryStore(pool);let reads=0;
 const task={installation_id:s.connected_id,requester_id:s.owner_id,thread_id:s.thread_id};
 const read=async()=>{reads++;return 'Channel memory';};
 assert.equal(await memory.agentContext(task,read),undefined);assert.equal(reads,0);
 await pool.query('UPDATE channels SET memory_enabled=true WHERE id=$1',[s.channel_id]);
 assert.equal(await memory.agentContext(task,read),undefined);assert.equal(reads,0);
 await memory.setAgentAccess(s.owner_id,s.channel_id,s.connected_id,{access:'read'});
 assert.equal(await memory.agentContext(task,read),'Channel memory');assert.equal(reads,1);
 assert.equal((await pool.query('SELECT 1 FROM agent_grants WHERE installation_id=$1',[s.connected_id])).rowCount,0);
 await connections.revoke(s.owner_id,s.connected_id);
 assert.equal(await memory.agentContext(task,read),undefined);assert.equal(reads,1);
});
