import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { AgentConnectionStore } from '@space/postgres/agent-connections';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';
import { parseInvocation } from '@space/contracts';
import { io } from 'socket.io-client';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const schema = `sidekick_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
const store = new PostgresStore(pool), app = createApi(store, { allowDevelopmentTokens: true });
let origin='';
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); origin=await app.listen({host:'127.0.0.1',port:0}); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
async function api(token: string, method: 'GET' | 'POST', path: string, payload?: object, status = 200) {
  const response = await app.inject({ method, url: `/v1${path}`, headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() }, ...(payload ? { payload } : {}) });
  assert.equal(response.statusCode, status, `${path}: ${response.body}`); return response.json();
}
async function fixture() {
  const a = await bootstrap(pool);
  await pool.query('UPDATE agent_definitions SET capabilities=$2 WHERE id=$1', [a.definition_id, { skills: ['codex.run'], controls: {}, persistent_sessions: true }]);
  // This fixture claims queued work; direct Codex handoff is covered separately.
  await pool.query("UPDATE agent_installations SET connector_id='codex.legacy-test' WHERE id=$1", [a.installation_id]);
  await pool.query("INSERT INTO agent_connections(installation_id,name) VALUES($1,'Sidekick')", [a.installation_id]);
  const ids = [randomUUID(), randomUUID()];
  for (const [index,id] of ids.entries()) await pool.query(`INSERT INTO messages(id,workspace_id,channel_id,thread_id,author_type,user_id,text,client_message_id,request_hash) VALUES($1,$2,$3,$4,'human',$5,$6,gen_random_uuid(),'test')`, [id,a.workspace_id,a.channel_id,a.thread_id,index ? a.collaborator_id : a.owner_id,index ? 'Investigate the retry behavior' : 'We found a problem']);
  const input = { client_session_id: randomUUID(), installation_id: a.installation_id, skill: 'codex.run', source: { channel_id: a.channel_id, message_ids: [...ids].reverse() } };
  return { ...a, ids, input, path: `/workspaces/${a.workspace_id}/sidekick-sessions` };
}
test('handoff is private, chronological, durable and executes with only captured context', async () => {
  const a = await fixture();
  const one = await api(a.owner_token,'POST',a.path,a.input,201);
  const detail = await api(a.owner_token,'GET',`/agent-sessions/${one.id}`);
  assert.deepEqual(detail.context.messages.map((m:any)=>m.id),a.ids);
  assert.notEqual(one.origin_thread_id,a.thread_id);
  await api(a.collaborator_token,'GET',`/agent-sessions/${one.id}`,undefined,404);
  await api(a.collaborator_token,'POST',`/agent-sessions/${one.id}/messages`,{text:'Intrude'},404);
  await api(a.collaborator_token,'POST',`/agent-sessions/${one.id}/end`,{},404);
  const socket=io(origin,{transports:['websocket'],auth:{token:a.collaborator_token},reconnection:false,autoConnect:false});
  try {
    const connected=new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});socket.connect();await connected;
    const reply=await socket.timeout(3000).emitWithAck('updates.subscribe',{scope:'thread',id:one.origin_thread_id});
    assert.equal(reply.error,'not_found');
  } finally {socket.disconnect();}
  assert.equal((await api(a.collaborator_token,'GET',a.path)).items.length,0);
  assert.equal((await api(a.owner_token,'GET',a.path)).items[0].id,one.id);
  assert.equal((await api(a.owner_token,'GET',`/threads/${a.thread_id}/agent-sessions`)).items.length,0);
  await pool.query('UPDATE messages SET text=$2 WHERE channel_id=$1 AND id=$3',[a.channel_id,'Changed after handoff',a.ids[0]]);
  await assert.rejects(pool.query("UPDATE agent_sessions SET handoff_context=jsonb_set(handoff_context,'{channel_name}','\"Changed\"') WHERE id=$1",[one.id]),/immutable/);
  const turn = await api(a.owner_token,'POST',`/agent-sessions/${one.id}/messages`,{text:'Help me understand this'},201);
  await api(a.collaborator_token,'GET',`/tasks/${turn.id}`,undefined,404);
  const delivery = (await store.claimDelivery(a.installation_id))!;
  const prepared = (await store.prepareDelivery(delivery))!;
  assert.equal(parseInvocation(prepared.request).context?.handoff?.messages[0]?.text,'We found a problem');
  assert.equal(prepared.request.context?.messages.length,0);
  assert.equal((await pool.query('SELECT 1 FROM agent_grants WHERE channel_id=$1',[one.channel_id])).rowCount,0);
  const ordinary = await api(a.owner_token,'POST','/tasks',{workspace_id:a.workspace_id,thread_id:one.origin_thread_id,installation_id:a.installation_id,skill:'codex.run',goal:'Ordinary DM task'},201);
  assert.equal(ordinary.status,'awaiting_approval','connected agents inherit owner DM access without bypassing approval');
  await api(a.owner_token,'POST',`/agent-sessions/${one.id}/stop`,{});
});
test('whole thread includes offscreen replies; retries create one session and reject changed identity', async () => {
  const a = await fixture();
  for(let n=0;n<22;n++) await pool.query(`INSERT INTO messages(id,workspace_id,channel_id,thread_id,author_type,user_id,text,client_message_id,request_hash) VALUES($1,$2,$3,$4,'human',$5,$6,gen_random_uuid(),'test')`,[randomUUID(),a.workspace_id,a.channel_id,a.thread_id,a.owner_id,`Reply ${n}`]);
  const input={...a.input,source:{channel_id:a.channel_id,thread_id:a.thread_id}};
  const sessions=await Promise.all(Array.from({length:3},()=>api(a.owner_token,'POST',a.path,input,201)));
  assert.equal(new Set(sessions.map(s=>s.id)).size,1);
  const detail=await api(a.owner_token,'GET',`/agent-sessions/${sessions[0].id}`);
  assert.equal(detail.context.messages.length,24);
  await api(a.owner_token,'POST',a.path,a.input,409);
  await api(a.owner_token,'POST',a.path,{...input,client_session_id:randomUUID(),source:{channel_id:a.channel_id,message_ids:[]}},400);
  await api(a.owner_token,'POST',a.path,{...input,client_session_id:randomUUID(),source:{channel_id:a.channel_id,message_ids:Array.from({length:51},()=>randomUUID())}},400);
});
test('ownership, source access, missing messages and oversize threads are enforced',async()=>{
  const a=await fixture(),other=await fixture();
  await api(a.collaborator_token,'POST',a.path,a.input,404);
  await api(other.owner_token,'POST',a.path,a.input,404);
  await api(a.owner_token,'POST',a.path,{...a.input,source:{channel_id:other.channel_id,message_ids:other.ids}},404);
  await api(a.owner_token,'POST',a.path,{...a.input,source:{channel_id:a.channel_id,message_ids:[randomUUID()]}},404);
  for(let n=0;n<49;n++)await pool.query(`INSERT INTO messages(id,workspace_id,channel_id,thread_id,author_type,user_id,text,client_message_id,request_hash) VALUES($1,$2,$3,$4,'human',$5,'Reply',gen_random_uuid(),'test')`,[randomUUID(),a.workspace_id,a.channel_id,a.thread_id,a.owner_id]);
  const error=await api(a.owner_token,'POST',a.path,{...a.input,source:{channel_id:a.channel_id,thread_id:a.thread_id}},400);
  assert.equal(error.error,'sidekick_context_too_large');
});

test('browser tabs open one private Sidekick each with the owned pair and sanitized page context',async()=>{
  const a=await fixture(), connections=new AgentConnectionStore(pool);
  const pairing=await connections.createPairing(a.owner_id,a.workspace_id,{provider:'codex',name:'Kai Mac Codex'});
  const credential=randomBytes(32).toString('base64url');
  const paired=await connections.claim({code:pairing.code,provider:'codex',credential});
  const agents=await api(a.owner_token,'GET',`/workspaces/${a.workspace_id}/sidekick-agents?paired=true`);
  assert.deepEqual(agents.map((agent:any)=>agent.id),[paired.installation_id]);
  const source={browser_url:'https://github.com/org/repo?token=secret#private'};
  await api(a.owner_token,'POST',a.path,{...a.input,source},409);
  const input={...a.input,source,installation_id:paired.installation_id};
  const [one,again]=await Promise.all([api(a.owner_token,'POST',a.path,input,201),api(a.owner_token,'POST',a.path,input,201)]);
  assert.equal(one.id,again.id);
  const two=await api(a.owner_token,'POST',a.path,{...input,client_session_id:randomUUID()},201);
  assert.notEqual(one.origin_thread_id,two.origin_thread_id);
  const detail=await api(a.owner_token,'GET',`/agent-sessions/${one.id}`);
  assert.equal(detail.context.browser_url,'https://github.com/org/repo');
  assert.deepEqual(detail.context.messages,[]);
  assert.equal(detail.session.installation_id,paired.installation_id);
  assert.equal(agents[0].name,'Kai Mac Codex');
  assert.equal(one.agent_name,agents[0].name);
  assert.equal(detail.session.agent_name,agents[0].name);
  await api(a.collaborator_token,'GET',`/agent-sessions/${one.id}`,undefined,404);
  await api(a.collaborator_token,'POST',`/agent-sessions/${one.id}/messages`,{text:'Follow up'},404);
  await api(a.owner_token,'POST',a.path,{...input,source:{browser_url:'file:///private'}},400);
  const socket=io(origin+'/agents',{transports:['websocket'],auth:{token:credential},autoConnect:false,reconnection:false});
  try {
    const received=new Map<string,ReturnType<typeof parseInvocation>>();
    socket.on('agent.turn.capacity',(_input,ack)=>ack({data:true}));
    socket.on('agent.turn.start',(raw,ack)=>{const request=parseInvocation(raw);received.set(request.task_id,request);ack({data:true});});
    const ready=new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});
    socket.connect();await ready;
    const command=(name:string,body:object)=>socket.timeout(3000).emitWithAck(name,body);
    assert.equal((await command('agent.heartbeat',{auth_status:'ready'})).data.installation_id,paired.installation_id);
    for (const [index,text] of ['Summarize the repository','Explain the first change'].entries()) {
      const page=index ? 'https://github.com/org/repo/pull/1' : detail.context.browser_url;
      const task=await api(a.owner_token,'POST',`/agent-sessions/${one.id}/messages`,{text,browser_url:page+'?token=private'},201);
      const turn=received.get(task.id)!;
      assert.equal(turn.session_id,one.id);
      assert.equal(turn.goal,text);
      assert.deepEqual(turn.persistent_session,{resume:index>0});
      assert.deepEqual(turn.context,{thread_id:one.origin_thread_id,messages:[],handoff:{...detail.context,browser_url:page}});
      for (const [sequence,type] of ['execution.started','execution.progress','execution.completed'].entries()) {
        assert.deepEqual(await command('agent.turn.event',{task_id:task.id,event:{id:randomUUID(),schema_version:'1.0',execution_id:turn.execution_id,
          sequence:sequence+1,type,occurred_at:new Date().toISOString(),payload:{text:'OK',...(sequence===1?{session_ready:true}:{})}}}),{data:true});
      }
      assert.deepEqual(await command('agent.turn.finish',{task_id:task.id}),{data:true});
    }
    assert.equal((await api(a.owner_token,'GET',`/agent-sessions/${one.id}`)).turns.length,2);
  } finally {socket.disconnect();}
});
