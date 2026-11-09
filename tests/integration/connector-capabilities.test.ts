import { observeOutbox } from '../fixtures/observe-outbox.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { AgentConnectionStore } from '@space/postgres/agent-connections';
import { AgentSessionStore } from '@space/postgres/agent-sessions';
import { PostgresStore } from '@space/postgres/store';
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const schema = `capabilities_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: url }), pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
const descriptor = { id: 'research.local', definition_id: randomUUID(), name: 'Research', capabilities: { skills: ['research.run', 'research.review'], controls: { progress_stream: true }, persistent_sessions: true } };
const store = new AgentConnectionStore(pool, { connectors: [descriptor] });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); await observeOutbox(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
test('trusted custom connector controls enrollment, inherited access, skill selection and local delivery', async () => {
 const owner = await bootstrap(pool);
 await assert.rejects(store.createPairing(owner.owner_id, owner.workspace_id, { connector_id: 'unknown.local' }), /unknown_connector/);
 const pairing = await store.createPairing(owner.owner_id, owner.workspace_id, { connector_id: descriptor.id });
 const credential = randomBytes(32).toString('base64url');
 await assert.rejects(store.claim({ code: pairing.code, credential, capabilities: descriptor.capabilities }), /unknown_field/);
 const claims = await Promise.all([1, 2, 3].map(() => store.claim({ code: pairing.code, credential })));
 assert.equal(new Set(claims.map(c => c.installation_id)).size, 1);
 const id = claims[0]!.installation_id;
 const rows = await store.channelAgents(owner.owner_id, owner.channel_id);
 const agent = rows.find(row => row.id === id)!;
 assert.deepEqual(agent.skills, descriptor.capabilities.skills);
 assert.deepEqual(agent.granted_skills, descriptor.capabilities.skills); assert.equal(agent.inherits_owner_access, true); assert.equal(agent.persistent_sessions, true);
 await assert.rejects(store.setChannelEnabled(owner.collaborator_id, id, owner.channel_id, true), /installation_not_owned/);
 await assert.rejects(store.setChannelEnabled(owner.owner_id, id, owner.channel_id, true, 'not.supported'), /skill_not_supported/);
 await Promise.all([1, 2].map(() => store.setChannelEnabled(owner.owner_id, id, owner.channel_id, true, 'research.review')));
 assert.deepEqual((await store.channelAgents(owner.owner_id, owner.channel_id)).find(row => row.id === id)!.granted_skills, descriptor.capabilities.skills);
 assert.equal((await pool.query('SELECT 1 FROM agent_grants WHERE installation_id=$1',[id])).rowCount,0);
 const sessions = new AgentSessionStore(pool);
 const session = await sessions.create(owner.owner_id, owner.thread_id, { client_session_id: randomUUID(), installation_id: id, title: 'Research session', skill: 'research.review' });
 assert.equal(session.skill, 'research.review');
 assert.equal((await store.setChannelEnabled(owner.owner_id, id, owner.channel_id, true)).inherits_owner_access,true);
 await store.setChannelEnabled(owner.owner_id, id, owner.channel_id, true, 'research.run');
 await assert.rejects(sessions.create(owner.owner_id, owner.thread_id, { client_session_id: randomUUID(), installation_id: id, title: 'Choose skill' }), /session_skill_required/);
 const task = await sessions.send(owner.owner_id, session.id, { text: 'Review this' }, randomUUID());
 const event = (await pool.query("SELECT kind FROM observed_outbox WHERE payload->>'task_id'=$1 AND kind LIKE 'task.%.ready'", [task.id])).rows;
 assert.ok(event.some(row => row.kind === 'task.local.ready')); assert.ok(!event.some(row => row.kind === 'task.remote.ready'));
 const tasks = new PostgresStore(pool);
 assert.equal(await tasks.claimDelivery(), null);
 const delivery = await tasks.claimDelivery(id); assert.ok(delivery);
 await tasks.acceptEvent(id, { id:randomUUID(),schema_version:'1.0',execution_id:task.active_execution_id,sequence:1,type:'execution.started',occurred_at:new Date().toISOString(),payload:{text:'Started'} }, delivery);
 await tasks.acceptEvent(id, { id:randomUUID(),schema_version:'1.0',execution_id:task.active_execution_id,sequence:2,type:'execution.progress',occurred_at:new Date().toISOString(),payload:{text:'Saved',session_ready:true} }, delivery);

});

test('generic channel grants work for remote installations and sessions require an advertised capability', async () => {
 const owner = await bootstrap(pool);
 const agents = await store.channelAgents(owner.owner_id, owner.channel_id);
 assert.ok(agents.some(agent => agent.id === owner.installation_id && agent.granted_skills.includes('demo.echo')));
 await store.setChannelEnabled(owner.owner_id, owner.installation_id, owner.channel_id, false, 'demo.echo');
 assert.equal((await store.channelAgents(owner.owner_id, owner.channel_id)).find(agent => agent.id === owner.installation_id)!.enabled_in_channel, false);
 await store.setChannelEnabled(owner.owner_id, owner.installation_id, owner.channel_id, true);
 await pool.query("UPDATE agent_installations SET connector_id='codex.local' WHERE id=$1", [owner.installation_id]);
 await assert.rejects(new AgentSessionStore(pool).create(owner.owner_id, owner.thread_id, {client_session_id:randomUUID(),installation_id:owner.installation_id,title:'No session capability',skill:'demo.echo'}), /session_connector_unsupported/);
 const tasks = new PostgresStore(pool);
 const task = await tasks.createTask(owner.owner_id,{workspace_id:owner.workspace_id,thread_id:owner.thread_id,installation_id:owner.installation_id,skill:'demo.echo',goal:'Remote'},randomUUID());
 await tasks.approveTask(owner.owner_id,task.id);
 assert.equal(await tasks.claimDelivery(owner.installation_id),null);
 assert.ok(await tasks.claimDelivery());
});

test('API exposes trusted descriptors and routes custom enrollment with inherited owner access', async () => {
 const {createApi} = await import('@space/server/api');
 const app = createApi(new PostgresStore(pool), {allowDevelopmentTokens:true,pairedConnectors:[descriptor]});
 try {
  const owner = await bootstrap(pool);
  const call = async (method:'GET'|'POST',path:string,payload?:object,authenticated=true) => app.inject({method,url:`/v1${path}`,headers:authenticated?{authorization:`Bearer ${owner.owner_token}`}:{},...(payload?{payload}:{})});
  assert.equal((await call('GET','/agents/connectors',undefined,false)).statusCode,401);
  const registry = await call('GET','/agents/connectors'); assert.equal(registry.statusCode,200); assert.deepEqual(registry.json(),[descriptor]);
  const response = await call('POST',`/workspaces/${owner.workspace_id}/agent-pairings`,{connector_id:descriptor.id}); assert.equal(response.statusCode,201,response.body);
  const pairing=response.json(),credential=randomBytes(32).toString('base64url');
  const claim=await call('POST','/agent-pairings/claim',{code:pairing.code,credential},false); assert.equal(claim.statusCode,201,claim.body);
  const id=claim.json().installation_id;
  const grant=await call('POST',`/agents/connections/${id}/channels/${owner.channel_id}`,{enabled:true,skill:'research.run'}); assert.equal(grant.statusCode,200,grant.body); assert.deepEqual(grant.json().granted_skills,[...descriptor.capabilities.skills].sort()); assert.equal(grant.json().inherits_owner_access,true);
  const generic=await call('GET',`/channels/${owner.channel_id}/agents`); assert.ok(generic.json().some((agent:any)=>agent.id===id&&agent.persistent_sessions));
  const legacy=await call('GET',`/channels/${owner.channel_id}/local-codex`); assert.deepEqual(legacy.json(),[]);
 } finally {await app.close();}
});

test('pending pairings cannot replace a shared definition after its trusted capabilities change', async () => {
 const owner=await bootstrap(pool),definition_id=randomUUID();
 const oldDescriptor={...descriptor,id:'immutable.local',definition_id};
 const updatedDescriptor={...oldDescriptor,capabilities:{...oldDescriptor.capabilities,skills:['research.review']}};
 const oldStore=new AgentConnectionStore(pool,{connectors:[oldDescriptor]});
 const updatedStore=new AgentConnectionStore(pool,{connectors:[updatedDescriptor]});
 const pending=await oldStore.createPairing(owner.owner_id,owner.workspace_id,{connector_id:oldDescriptor.id});
 const other=await bootstrap(pool);
 const current=await updatedStore.createPairing(other.owner_id,other.workspace_id,{connector_id:updatedDescriptor.id});
 const credential=randomBytes(32).toString('base64url');
 const installed=await updatedStore.claim({code:current.code,credential});
 const attempts=await Promise.allSettled([1,2].map(()=>oldStore.claim({code:pending.code,credential:randomBytes(32).toString('base64url')})));
 assert.ok(attempts.every(result=>result.status==='rejected'&&result.reason.code==='connector_definition_conflict'));
 const stored=(await pool.query('SELECT capabilities FROM agent_definitions WHERE id=$1',[definition_id])).rows[0];
 assert.deepEqual(stored.capabilities,updatedDescriptor.capabilities);
 assert.equal((await pool.query('SELECT definition_id FROM agent_installations WHERE id=$1',[installed.installation_id])).rows[0].definition_id,definition_id);
 assert.equal((await oldStore.pairingStatus(owner.owner_id,pending.id)).status,'pending');
});
