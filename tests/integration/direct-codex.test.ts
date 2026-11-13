import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {io,type Socket} from 'socket.io-client';
import {migrate} from '@space/postgres/migrate';
import {bootstrap} from '@space/postgres/bootstrap';
import {PostgresStore} from '@space/postgres/store';
import {createApi} from '@space/server/api';
const schema=`direct_${randomBytes(8).toString('hex')}`,url=process.env.TEST_DATABASE_URL;
if(!url)throw Error('TEST_DATABASE_URL required');
const admin=new Pool({connectionString:url}),pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});
const app=createApi(new PostgresStore(pool),{allowDevelopmentTokens:true});let origin='';let socket:Socket;let viewer:Socket;
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);origin=await app.listen({host:'127.0.0.1',port:0});});
after(async()=>{socket?.disconnect();viewer?.disconnect();await app.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
async function api(token:string|undefined,path:string,body?:object,key=randomUUID(),expected=200){const r=await app.inject({method:body?'POST':'GET',url:`/v1${path}`,headers:{...(token?{authorization:`Bearer ${token}`} : {}),'idempotency-key':key},payload:body});assert.equal(r.statusCode,expected,r.body);return r.json();}
const command=(name:string,body:object)=>socket.timeout(3000).emitWithAck(name,body);
test('direct sessions reject offline/busy/capacity, start independently without broker delivery and preserve retries and saved state',async()=>{
 const s=await bootstrap(pool),pair=await api(s.owner_token,`/workspaces/${s.workspace_id}/agent-pairings`,{},undefined,201);
 const credential=randomBytes(32).toString('base64url');
 const {installation_id}=await api(undefined,'/agent-pairings/claim',{code:pair.code,credential},undefined,201);
 const session=async()=>api(s.owner_token,`/threads/${s.thread_id}/agent-sessions`,{client_session_id:randomUUID(),installation_id,title:'Direct test'},undefined,201);
 const a=await session(),b=await session(),c=await session();
 const send=(id:string,key=randomUUID(),expected=201)=>api(s.owner_token,`/agent-sessions/${id}/messages`,{text:'Say hello'},key,expected);
 await send(a.id,undefined,409);assert.equal((await pool.query('SELECT count(*)::int AS n FROM tasks WHERE installation_id=$1',[installation_id])).rows[0].n,0);
 let updates=0;
 viewer=io(origin,{transports:['websocket'],auth:{token:s.owner_token},autoConnect:false,reconnection:false});
 viewer.on('updates.changed',(_input,ack)=>{updates++;ack?.(true);});
 const viewerReady=new Promise<void>((resolve,reject)=>{viewer.once('connect',resolve);viewer.once('connect_error',reject);});viewer.connect();await viewerReady;
 assert.ok((await viewer.timeout(3000).emitWithAck('updates.subscribe',{scope:'thread',id:s.thread_id})).data);
 const startEvents = new Map<string, ReturnType<typeof command>>();
 const running=new Map<string,any>();let launches=0,rejectStart=false,loseStartAck=false;
 socket=io(`${origin}/agents`,{transports:['websocket'],auth:{token:credential},autoConnect:false,reconnection:false});
 socket.on('agent.turn.capacity',(input,ack)=>ack(running.has(input.session_id)?{error:'agent_busy'}:running.size>=2?{error:'agent_capacity'}:{data:true}));
 socket.on('agent.turn.start',async(request,ack)=>{
   if(rejectStart){ack({error:'agent_unavailable'});return;}
   if([...running.values()].some(r=>r.execution_id===request.execution_id)){ack({data:true});return;}
   launches++;running.set(request.session_id,request);if(!loseStartAck)ack({data:true});
   const started=command('agent.turn.event',{task_id:request.task_id,event:{id:randomUUID(),schema_version:'1.0',execution_id:request.execution_id,sequence:1,type:'execution.started',occurred_at:new Date().toISOString(),payload:{text:'Working'}}});
   startEvents.set(request.task_id, started);
   if(loseStartAck){await started;ack({error:'agent_unavailable'});}else void started.catch(()=>{});
 });
 const ready=new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});socket.connect();await ready;
 assert.ok((await command('agent.heartbeat',{auth_status:'ready'})).data);
 const key=randomUUID();const [ta,tb]=await Promise.all([send(a.id,key),send(b.id)]);
 // The connector waits for each event's ACK before it emits the next sequence.
 for (const task of [ta, tb]) assert.deepEqual(await startEvents.get(task.id), {data:true});
 assert.equal(ta.status,'running');assert.equal(tb.status,'running');assert.equal(running.size,2);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM outbox WHERE state='pending' AND task_id IN ($1,$2)",[ta.id,tb.id])).rows[0].n,0);
 await send(a.id,undefined,409);await send(c.id,undefined,409);
 const retry=await send(a.id,key);assert.equal(retry.id,ta.id);assert.equal(launches,2);
 const saved=await api(s.owner_token,`/agent-sessions/${a.id}`);assert.equal(saved.turns[0].task.id,ta.id);
 const instructions:unknown[]=[];
 socket.on('agent.turn.steer',(input,ack)=>{instructions.push(input);ack({data:true});});
 const steerPath=`/agent-sessions/${a.id}/steer`,steerKey=randomUUID();
 const instruction={execution_id:ta.active_execution_id,text:'Check the smaller file first'};
 await api(s.collaborator_token,steerPath,instruction,undefined,403);
 await api(s.owner_token,steerPath,{...instruction,execution_id:tb.active_execution_id},undefined,409);
 const queuedSource=await api(s.owner_token,`/agent-sessions/${a.id}/queue`,{text:instruction.text});
 Object.assign(instruction,{source_input_id:queuedSource.id});
 const receipt=await api(s.owner_token,steerPath,instruction,steerKey);
 assert.deepEqual(receipt,{id:steerKey,state:'sent'});
 assert.deepEqual(await api(s.owner_token,steerPath,instruction,steerKey),receipt);
 assert.deepEqual(instructions,[{text:instruction.text,execution_id:instruction.execution_id,id:steerKey,session_id:a.id}]);
 assert.deepEqual((await api(s.owner_token,`/agent-sessions/${a.id}`)).inputs,[]);
 assert.equal((await api(s.owner_token,`/agent-sessions/${a.id}`)).turns[0].steering[0].text,instruction.text);
 // A stale or foreign execution cannot use another session's event channel.
 assert.equal((await command('agent.turn.event',{task_id:ta.id,event:{id:randomUUID(),schema_version:'1.0',execution_id:tb.active_execution_id,sequence:2,type:'execution.completed',occurred_at:new Date().toISOString(),payload:{text:'Wrong'}}})).error,'stale_execution');
 const beforeUpdates=updates;
 const request=running.get(b.id);
 assert.equal((await command('agent.turn.event',{task_id:request.task_id,event:{id:randomUUID(),schema_version:'1.0',execution_id:request.execution_id,sequence:2,type:'execution.completed',occurred_at:new Date().toISOString(),payload:{text:'Done'}}})).data,true);
 assert.equal((await command('agent.turn.finish',{task_id:request.task_id})).data,true);running.delete(b.id);
 assert.equal((await api(s.owner_token,`/agent-sessions/${b.id}`)).turns[0].task.status,'completed');
 // The native app can assign a name after the execution has finished.
 const renameFromCodex=(name:string)=>command('agent.session.title',{task_id:tb.id,execution_id:tb.active_execution_id,title:name});
 const sessionPath=`/agent-sessions/${b.id}`;
 assert.deepEqual(await renameFromCodex('Upload investigation'),{data:true});
 assert.equal((await api(s.owner_token,sessionPath)).session.title,'Upload investigation');
 const rename=await app.inject({method:'PATCH',url:'/v1'+sessionPath,headers:{authorization:`Bearer ${s.owner_token}`},payload:{title:'My upload notes',previous_title:'Upload investigation'}});
 assert.equal(rename.statusCode,200);
 await renameFromCodex('Upload investigation');
 assert.equal((await api(s.owner_token,sessionPath)).session.title,'My upload notes');
 assert.deepEqual(await renameFromCodex('Completed upload review'),{data:true});
 assert.equal((await api(s.owner_token,sessionPath)).session.title,'Completed upload review');
 const retried=await api(s.owner_token,`/threads/${s.thread_id}/agent-sessions`,{client_session_id:b.id,installation_id,title:'Direct test'},undefined,201);
 assert.equal(retried.title,'Completed upload review');
 assert.equal((await command('agent.session.title',{task_id:tb.id,execution_id:ta.active_execution_id,title:'Wrong thread'})).error,'not_found');
 assert.equal((await renameFromCodex('   ')).error,'invalid_text');
 assert.equal((await api(s.owner_token,`/agent-sessions/${a.id}`)).session.title,'Direct test');
 const updateDeadline=Date.now()+3000;while(updates<=beforeUpdates && Date.now()<updateDeadline)await new Promise(r=>setTimeout(r,10));assert.ok(updates>beforeUpdates,'direct progress must notify an authorized viewer without CDC');
 rejectStart=true;const rejectedKey=randomUUID();await send(c.id,rejectedKey,409);
 const rejected=await api(s.owner_token,`/agent-sessions/${c.id}`);assert.equal(rejected.turns[0].task.status,'failed');
 await send(c.id,rejectedKey,409);rejectStart=false;
 assert.equal((await send(c.id)).status,'running');

 await api(s.owner_token,`/agent-sessions/${a.id}/stop`,{});
 assert.equal((await api(s.owner_token,`/agent-sessions/${a.id}`)).turns[0].task.status,'failed');running.delete(a.id);
 // A terminal event wakes the durable queue via WAL and JetStream. No manual drain or second send.
 const followupPath=`/agent-sessions/${c.id}/queue`;
 await api(s.owner_token,followupPath,{text:'Run after this turn'});
 const offered=new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('queued turn was not offered')),8000);
   socket.once('agent.tasks.available',()=>{clearTimeout(timer);resolve();});
 });
 const active=running.get(c.id);
 assert.deepEqual(await startEvents.get(active.task_id),{data:true});
 assert.equal((await command('agent.turn.event',{task_id:active.task_id,event:{id:randomUUID(),schema_version:'1.0',execution_id:active.execution_id,sequence:2,type:'execution.completed',occurred_at:new Date().toISOString(),payload:{text:'Done'}}})).data,true);
 assert.equal((await command('agent.turn.finish',{task_id:active.task_id})).data,true);
 running.delete(c.id);
 await offered;
 const queuedRequest=(await command('agent.task.claim',{})).data;
 assert.equal(queuedRequest.session_id,c.id);
 assert.equal(queuedRequest.goal,'Run after this turn');
 for(const [index,type] of ['execution.started','execution.completed'].entries()){
   assert.equal((await command('agent.task.event',{event:{id:randomUUID(),schema_version:'1.0',execution_id:queuedRequest.execution_id,sequence:index+1,type,occurred_at:new Date().toISOString(),payload:{text:'Done'}}})).data,true);
 }
 assert.equal((await command('agent.task.finish',{})).data,true);
 loseStartAck=true;const d=await session();const accepted=await send(d.id);
 assert.equal(accepted.status,'running');assert.equal((await api(s.owner_token,`/agent-sessions/${d.id}`)).turns[0].task.status,'running','a durable first event resolves an uncertain handoff without rerunning or failing it');

});
