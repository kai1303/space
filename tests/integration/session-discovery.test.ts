import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { io } from 'socket.io-client';
import { ChatStore } from '@space/postgres/chat';
import { PostgresStore } from '@space/postgres/store';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { AgentSessionStore } from '@space/postgres/agent-sessions';

const url=process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL required');
const schema='discover_'+randomUUID().replaceAll('-','');
const admin=new Pool({connectionString:url});
const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});
const sessions=new AgentSessionStore(pool);
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});

test('discovery scopes conversation search and review invitations, including after access changes', async()=>{
  const seed=await bootstrap(pool), stranger=await bootstrap(pool), id=randomUUID(), task=randomUUID();
  const {workspace_id:workspace,collaborator_id:reviewer,owner_id:owner}=seed;
  const find=(actor:string,filters:Record<string,string>={})=>sessions.discover(actor,workspace,filters);
  await pool.query('INSERT INTO agent_sessions(id,workspace_id,installation_id,origin_thread_id,title,managed,created_by) VALUES($1,$2,$3,$4,$5,true,$6)',
    [id,workspace,seed.installation_id,seed.thread_id,'Billing fix',owner]);
  await pool.query(`INSERT INTO tasks(id,workspace_id,thread_id,installation_id,goal,skill,requester_id,status,session_id,idempotency_key,request_hash)
    VALUES($1,$2,$3,$4,'Repair tax rounding','demo.echo',$5,'awaiting_approval',$6,'key','hash')`,[task,workspace,seed.thread_id,seed.installation_id,owner,id]);
  assert.equal((await find(owner,{q:'tax',status:'needs_attention',channel:'general',creator:'owner'})).items[0]?.id,id);
  await pool.query("UPDATE tasks SET status='completed',result='Fixed' WHERE id=$1",[task]);
  await pool.query(`INSERT INTO task_events(id,type,workspace_id,actor_id,resource_id,correlation_id,sequence,payload)
    VALUES($1,'task.completed',$2,$3,$4,$4,1,$5)`,[randomUUID(),workspace,owner,task,{response:{messages:[{text:'Added regression coverage'}],tools:[{result:'unsearchablesecret'}]}}]);
  assert.equal((await find(reviewer,{q:'regression',status:'done'})).items[0]?.id,id);
  assert.deepEqual((await find(reviewer,{q:'unsearchablesecret'})).items,[]);
  await pool.query('INSERT INTO session_discussion_messages(session_id,actor_id,client_id,body) VALUES($1,$2,$3,$4)',[id,owner,randomUUID(),'The invoice is ready']);
  assert.equal((await find(owner,{q:'invoice'})).items[0]?.id,id);
  await pool.query("UPDATE agent_sessions SET state='ended' WHERE id=$1",[id]);
  await sessions.updateSidebar(owner,id,{archived:true});
  assert.equal((await find(owner,{status:'archived',archived:'true'})).items[0]?.id,id);
  assert.deepEqual((await find(reviewer,{archived:'true'})).items,[]);
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[seed.channel_id,reviewer]);
  assert.deepEqual((await find(reviewer,{q:'Billing'})).items,[]);
  await pool.query('INSERT INTO session_reviewers(workspace_id,session_id,user_id) VALUES($1,$2,$3)',[workspace,id,reviewer]);
  assert.deepEqual((await find(reviewer,{q:'Billing'})).items,[{id,title:'Billing fix',access:'reviewer'}]);
  assert.deepEqual((await find(reviewer,{scope:'workspace'})).items,[]);
  for (const query of [{q:'regression'},{q:'tax'},{q:'invoice'},{status:'archived'},{creator:'owner'},{channel:'general'}]) {
    assert.deepEqual((await sessions.discover(reviewer,workspace,query)).items,[]);
  }
  await pool.query('DELETE FROM session_reviewers WHERE session_id=$1 AND user_id=$2',[id,reviewer]);
  assert.deepEqual((await find(reviewer)).items,[]);
  await assert.rejects(find(reviewer,{before:id}),/not_found/);
  await pool.query('INSERT INTO session_team_visibility(workspace_id,session_id) VALUES($1,$2)',[workspace,id]);
  assert.deepEqual((await find(reviewer,{scope:'workspace'})).items,[{id,title:'Billing fix',access:'reviewer'}]);
  assert.deepEqual((await find(reviewer,{q:'regression'})).items,[]);
  await pool.query('DELETE FROM session_team_visibility WHERE session_id=$1',[id]);
  assert.deepEqual((await find(reviewer)).items,[]);
  await assert.rejects(find(stranger.owner_id),/not_found/);
});

test('session pages use a stable creation cursor and reject invalid filters',async()=>{
  const seed=await bootstrap(pool);
  for(let index=0;index<27;index++) await pool.query(`INSERT INTO agent_sessions(id,workspace_id,installation_id,origin_thread_id,title,created_at,managed)
    VALUES($1,$2,$3,$4,'Build', '2026-01-01',true)`,[randomUUID(),seed.workspace_id,seed.installation_id,seed.thread_id]);
  const first=await sessions.discover(seed.owner_id,seed.workspace_id,{});
  const second=await sessions.discover(seed.owner_id,seed.workspace_id,{before:first.next_cursor});
  assert.equal(first.items.length,25);assert.equal(second.next_cursor,null);
  assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,27);
  await assert.rejects(sessions.discover(seed.owner_id,seed.workspace_id,{status:'unknown'}),/invalid_session_status/);
});

test('a committed status transition refreshes the discovery view without a running CDC bridge',async()=>{
  const {createApi}=await import('@space/server/api');
  const api=createApi(new PostgresStore(pool),{allowDevelopmentTokens:true});
  const seed=await bootstrap(pool), id=randomUUID();
  const url=await api.listen({host:'127.0.0.1',port:0});
  const socket=io(url,{transports:['websocket'],auth:{token:seed.owner_token},autoConnect:false,reconnection:false});
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try {
    const connected=new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});
    socket.connect();await connected;
    const path=`/v1/workspaces/${seed.workspace_id}/agent-sessions/discover?status=needs_attention`;
    const list=async()=>{const r=await api.inject({url:path,headers:{authorization:'Bearer '+seed.owner_token}});assert.equal(r.statusCode,200,r.body);return r.json().items;};
    await pool.query('INSERT INTO agent_sessions(id,workspace_id,installation_id,origin_thread_id,title,managed) VALUES($1,$2,$3,$4,$5,true)',
      [id,seed.workspace_id,seed.installation_id,seed.thread_id,'Review',]);
    assert.deepEqual(await list(),[]);
    assert.ok((await socket.timeout(3000).emitWithAck('updates.subscribe',{scope:'workspace',id:seed.workspace_id})).data);
    const changed=new Promise<void>((resolve,reject)=>{
      timeout=setTimeout(()=>reject(Error('workspace did not receive committed status')),4000);
      socket.on('updates.changed',(event,ack)=>{ack?.(true);if(event.scope==='workspace' && event.id===seed.workspace_id)resolve();});
    });
    await pool.query(`INSERT INTO tasks(id,workspace_id,thread_id,installation_id,goal,skill,requester_id,status,session_id,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,'Approve','demo.echo',$5,'awaiting_approval',$6,'key','hash')`,[randomUUID(),seed.workspace_id,seed.thread_id,seed.installation_id,seed.owner_id,id]);
    await changed;assert.equal((await list())[0].id,id);
  } finally {clearTimeout(timeout);socket.disconnect();await api.close();}
});

test('seven-day inactivity hides only unpinned code channels and preserves search, restore and later activity', async()=>{
  const seed=await bootstrap(pool), owner=seed.owner_id, workspace=seed.workspace_id;
  const selfDm=await new ChatStore(pool).directMessages.open(owner,workspace,{user_id:owner});
  const privateThread=randomUUID();
  await pool.query('INSERT INTO threads(id,workspace_id,channel_id) VALUES($1,$2,$3)',[privateThread,workspace,selfDm.id]);
  async function make(title:string,sidekick=false) {
    const id=randomUUID();
    await pool.query(`INSERT INTO agent_sessions(id,workspace_id,installation_id,origin_thread_id,title,created_at,managed,handoff_context,handoff_hash,created_by)
      VALUES($1,$2,$3,$4,$5,now()-interval '8 days',true,$6,$7,$8)`,[id,workspace,seed.installation_id,sidekick?privateThread:seed.thread_id,title,sidekick?{}:null,sidekick?'hash':null,owner]);
    return id;
  }
  const idle=await make('Inactive channel'), recent=await make('Discussion'), restored=await make('Restored'),
    starred=await make('Starred'), archived=await make('Personally archived'), sidekick=await make('Sidekick',true), running=await make('Running');
  const list=async()=> (await sessions.listWorkspace(owner,workspace)).items;
  await pool.query('INSERT INTO hub_starred_agent_sessions(workspace_id,user_id,session_id) VALUES($1,$2,$3)',[workspace,owner,starred]);
  await sessions.updateSidebar(owner,archived,{archived:true});
  await sessions.updateSidebar(owner,restored,{archived:false});
  await pool.query(`INSERT INTO tasks(id,workspace_id,thread_id,installation_id,goal,skill,requester_id,status,session_id,idempotency_key,request_hash,created_at,updated_at)
    VALUES($1,$2,$3,$4,'Run','demo.echo',$5,'running',$6,'run','run',now()-interval '8 days',now()-interval '8 days')`,
    [randomUUID(),workspace,seed.thread_id,seed.installation_id,owner,running]);
  const discuss=(id:string)=>pool.query('INSERT INTO session_discussion_messages(session_id,actor_id,client_id,body) VALUES($1,$2,$3,$4)',[id,owner,randomUUID(),'Review it']);
  await discuss(recent); await discuss(archived);
  const visible=await list();
  assert.deepEqual(new Set(visible.map(item=>item.id)),new Set([recent,restored,starred,sidekick,running]));
  assert.ok(visible.find(item=>item.id===recent)?.sidebar_expires_at);
  assert.ok(visible.every(item=>item.id===recent || !item.sidebar_expires_at));
  const search=await sessions.discover(owner,workspace,{q:'Inactive channel'});
  assert.equal(search.items[0]?.access==='source' && search.items[0].sidebar_inactive,true);
  assert.deepEqual((await sessions.discover(owner,workspace,{q:'Inactive channel',archived:'false'})).items,[]);
  assert.deepEqual((await sessions.listWorkspace(owner,workspace,{archived:'true'})).items.map(item=>item.id),[archived]);
  assert.equal((await sessions.read(owner,idle)).session.id,idle);
  await discuss(idle);
  assert.ok((await list()).some(item=>item.id===idle));
});
