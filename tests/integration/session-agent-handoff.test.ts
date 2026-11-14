import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { PostgresStore } from '@space/postgres/store';
import { AgentSessionStore } from '@space/postgres/agent-sessions';

const url=process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL required');
const schema='agent_handoff_'+randomUUID().replaceAll('-','');
const admin=new Pool({connectionString:url}), pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});
const sessions=new AgentSessionStore(pool), store=new PostgresStore(pool);
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});

test('asking a second agent creates one linked session and sends only the selected context with its own approval',async()=>{
  const seed=await bootstrap(pool), unrelated=await bootstrap(pool);
  await pool.query("UPDATE agent_definitions SET capabilities=capabilities || '{\"persistent_sessions\":true}'::jsonb WHERE id=$1",[seed.definition_id]);
  const parent=await sessions.create(seed.owner_id,seed.thread_id,{client_session_id:randomUUID(),installation_id:seed.installation_id,title:'Research'});
  const helper = randomUUID(), key = randomUUID();
  await pool.query(`INSERT INTO agent_installations(id,workspace_id,owner_id,definition_id,connector_id)
    VALUES ($1,$2,$3,$4,'test-helper')`,[helper,seed.workspace_id,seed.owner_id,seed.definition_id]);
  await pool.query("INSERT INTO agent_connections(installation_id,name) VALUES($1,'Review agent')",[helper]);
  const input = {installation_id:helper,skill:'demo.echo',prompt:'Review this change',context:'Selected excerpt'};
  await assert.rejects(sessions.inviteAgent(unrelated.owner_id,parent.id,key,input),/not_found/);
  await assert.rejects(sessions.inviteAgent(seed.owner_id,parent.id,key,{...input,installation_id:seed.installation_id}),/session_handoff_unavailable/);
  const pair=await Promise.all([sessions.inviteAgent(seed.collaborator_id,parent.id,key,input),sessions.inviteAgent(seed.collaborator_id,parent.id,key,input)]);
  assert.deepEqual(pair,[{id:key},{id:key}]);
  await assert.rejects(sessions.inviteAgent(seed.collaborator_id,parent.id,key,{...input,context:'Changed excerpt'}),/idempotency_conflict/);
  const detail=await sessions.read(seed.owner_id,key);
  assert.equal(detail.session.installation_id,helper);
  assert.equal(detail.session.owner_id,seed.owner_id);
  assert.equal(detail.inputs!.length,1);
  assert.deepEqual(detail.related_agents!.map((r:{id:string;relation:string})=>[r.id,r.relation]),[[parent.id,'parent']]);
  assert.deepEqual((await sessions.read(seed.owner_id,parent.id)).related_agents!.map((r:{id:string;relation:string})=>[r.id,r.relation]),[[key,'helper']]);
  const task=await sessions.drainQueue(key);
  assert.equal(task?.status,'awaiting_approval');
  await assert.rejects(store.approveTask(seed.collaborator_id,task!.id));
  await store.approveTask(seed.owner_id,task!.id);
  store.memoryReader=async()=>{throw new Error('The handoff must not hydrate source memory.');};
  const delivery=await store.claimDelivery(helper);
  const work=await store.prepareDelivery(delivery!);
  assert.equal(work?.request.goal,'Review this change\n\nContext selected by the requester:\nSelected excerpt');
  assert.deepEqual(work?.request.context,{thread_id:seed.thread_id,messages:[]});
  assert.deepEqual(work?.request.persistent_session,{resume:false});
});
