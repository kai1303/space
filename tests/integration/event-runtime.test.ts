import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import { EventBus } from '@space/events';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { PostgresStore } from '@space/postgres/store';
import { ChatStore } from '@space/postgres/chat';
import { NavigatorStore } from '@space/postgres/navigator';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl)throw new Error('TEST_DATABASE_URL required');
const natsUrl=process.env.NATS_URL??'nats://127.0.0.1:54222';
const workerPath=fileURLToPath(new URL('../../apps/worker/dist/main.js',import.meta.url));

// Uses the stack's wildcard CDC service, not a test publisher or an in-process worker.
test('WAL events drive real worker delivery, restart recovery and Navigator routing', {timeout:90_000},async t=>{
 const schema=`runtime_events_${randomBytes(8).toString('hex')}`;
 const admin=new Pool({connectionString:databaseUrl});
 const scopedUrl=new URL(databaseUrl);scopedUrl.searchParams.set('options',`-c search_path=${schema}`);
 const pool=new Pool({connectionString:scopedUrl.toString()});
 const store=new PostgresStore(pool),chat=new ChatStore(pool),bus=new EventBus(natsUrl,schema);
 const navigator=new NavigatorStore(pool);
 const providerRequests:Record<string,any>[]=[];
 const provider=createServer(async(req,res)=>{
  try {
   const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
   const body=JSON.parse(Buffer.concat(chunks).toString());providerRequests.push(body);
   const answers=Object.fromEntries(Object.keys(body.questions).map(id=>[id,{type:'noul',noul:id==='continues_existing_work'?0.05:0.95}]));
   res.setHeader('content-type','application/json');res.end(JSON.stringify({model:'jev-fixture',answers,usage:{input_tokens:100,output_tokens:10}}));
  }catch{res.statusCode=500;res.end('{}');}
 });
 await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const providerUrl=`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1/systemone`;
 t.after(()=>{provider.closeAllConnections();provider.close();});
 let worker:ChildProcess|undefined;
 const checks=new Set<()=>Promise<void>>();
 const cancelWaits=new Set<()=>void>();
 const stopWorker=async()=>{
  const child=worker;worker=undefined;
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('worker did not drain after SIGTERM'));},10_000);
   child.once('exit',(code,signal)=>{clearTimeout(timer);if(code===0||signal==='SIGTERM')resolve();else reject(new Error(`worker shutdown failed: ${code??signal}`));});
   child.kill('SIGTERM');
  });
 };
 t.after(async()=>{
  for(const cancel of [...cancelWaits])cancel();
  try {await stopWorker();}
  finally {try{await bus.close();}finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}}
 });
 function observed<T>(label:string,read:()=>Promise<T|null>):Promise<T>{
  return new Promise<T>((resolve,reject)=>{
   const clean=()=>{clearTimeout(timer);checks.delete(check);cancelWaits.delete(cancel);};
   const cancel=()=>{clean();reject(new Error('runtime observation cancelled'));};
   const check=async()=>{try{const result=await read();if(result!==null){clean();resolve(result);}}catch(error){clean();reject(error);}};
   const timer=setTimeout(()=>{clean();reject(new Error(`missing WAL-driven runtime change: ${label}`));},20_000);
   checks.add(check);cancelWaits.add(cancel);
   // A single snapshot closes the race when an event arrived just before waiter registration.
   void check();
  });
 }
 async function startWorker(){
  const child=worker=spawn(process.execPath,[workerPath],{env:{...process.env,DATABASE_URL:scopedUrl.toString(),NATS_URL:natsUrl,NODE_ENV:'test',NAVIGATOR_L1_PROVIDER:'jev',NAVIGATOR_L1_URL:providerUrl,NAVIGATOR_L1_API_KEY:'fixture-key',NAVIGATOR_L1_MODEL:'jev-fixture',NAVIGATOR_L1_YES_THRESHOLD:'0.7',NAVIGATOR_L1_NO_THRESHOLD:'0.3',NAVIGATOR_L2_PROVIDER:'compatible',NAVIGATOR_L2_URL:'',NAVIGATOR_L2_MODEL:''},stdio:['ignore','pipe','pipe']});
  child.stderr?.on('data',()=>{});
  await new Promise<void>((resolve,reject)=>{
   let output='';
   const clean=()=>{clearTimeout(timer);child.stdout?.off('data',onData);child.off('exit',onExit);child.off('error',onError);};
   const onData=(chunk:Buffer)=>{output=(output+chunk.toString()).slice(-4096);if(output.includes('Worker ready')){clean();resolve();}};
   const onExit=()=>{clean();reject(new Error('worker exited before subscriptions became ready'));};
   const onError=(error:Error)=>{clean();reject(error);};
   const timer=setTimeout(()=>{clean();reject(new Error('worker subscriptions did not become ready'));},15_000);
   child.stdout?.on('data',onData);child.once('exit',onExit);child.once('error',onError);
  });
 }
 const completed=(id:string)=>observed(`task completion ${id}`,async()=>{const task=await pool.query('SELECT status FROM tasks WHERE id=$1',[id]);if(task.rows[0]?.status==='failed')throw new Error('worker task failed');return task.rows[0]?.status==='completed'?id:null;});
 await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);
 await bus.start();
 await bus.subscribe('chat.changed.*',{maxPending:32},async delivery=>{
  await Promise.all([...checks].map(check=>check()));await delivery.ack();
 });
 const seed=await bootstrap(pool);
 const propose=(goal:string)=>store.createTask(seed.owner_id,{workspace_id:seed.workspace_id,thread_id:seed.thread_id,installation_id:seed.installation_id,skill:'demo.echo',goal},randomUUID());
 await startWorker();
 const first=await propose('First real worker delivery'),firstDone=completed(first.id);
 await store.approveTask(seed.owner_id,first.id);await firstDone;
 t.diagnostic('Initial WAL-driven worker delivery completed');
 await stopWorker();
 // Approval while the worker is down must survive in the durable subscription.
 const second=await propose('Delivery retained across worker restart'),secondDone=completed(second.id);
 await store.approveTask(seed.owner_id,second.id);
 await startWorker();await secondDone;
 const routed=observed('explicit mention routing',async()=>{
  const result=await pool.query("SELECT t.id,t.status FROM navigator_decisions n JOIN tasks t ON t.id=(n.decision->>'task_id')::uuid WHERE n.thread_id=$1 AND n.route='mention'",[seed.thread_id]);
  return result.rows[0]??null;
 });
 await chat.send(seed.collaborator_id,seed.channel_id,{thread_id:seed.thread_id,client_message_id:randomUUID(),text:`@agent-${seed.installation_id} Route this real worker request`});
 const navigation=await routed;assert.equal(navigation.status,'awaiting_approval','a collaborator mention must preserve owner approval');
 const navigationDone=completed(navigation.id);await store.approveTask(seed.owner_id,navigation.id);await navigationDone;
 // Exercise the native provider through the real worker, with no external account or paid inference.
 await navigator.configure(seed.owner_id,seed.channel_id,{mode:'semantic',rules:[],cooldown_seconds:0,daily_token_limit:20_000});
 const suggested=observed('native Jev suggestion',async()=>{const items=await navigator.suggestions(seed.owner_id,seed.channel_id,seed.thread_id);return items[0]??null;});
 const semanticMessage=await chat.send(seed.owner_id,seed.channel_id,{thread_id:seed.thread_id,client_message_id:randomUUID(),text:'Please help with this request without a direct mention.'});
 const suggestion=await suggested;
 assert.equal(suggestion.decision.action,'suggest');
 assert.equal(providerRequests.length,1);
 assert.equal(providerRequests[0]!.state.last_message.id,semanticMessage.id);
 assert.equal(providerRequests[0]!.model,'jev-fixture');
 assert.equal((await pool.query('SELECT count(*)::int AS count FROM tasks WHERE thread_id=$1',[seed.thread_id])).rows[0].count,3,'inference must not dispatch work');
 const inference=(await pool.query('SELECT provider,model,input_tokens,output_tokens,reserved_tokens,error FROM navigator_inferences WHERE thread_id=$1',[seed.thread_id])).rows[0];
 assert.equal(inference.provider,'jev');assert.equal(inference.error,null);assert.equal(inference.input_tokens,100);assert.equal(inference.output_tokens,10);assert.ok(inference.reserved_tokens>0);
 await stopWorker();await startWorker();
 assert.equal((await navigator.suggestions(seed.owner_id,seed.channel_id,seed.thread_id))[0]?.id,suggestion.id,'suggestions survive restart');
 const accepted=await Promise.all([navigator.accept(seed.owner_id,suggestion.id,seed.installation_id,'demo.echo'),navigator.accept(seed.owner_id,suggestion.id,seed.installation_id,'demo.echo')]);
 assert.equal(accepted[0]!.id,accepted[1]!.id);
 await completed(accepted[0]!.id);
 assert.equal(providerRequests.length,1,'acceptance and agent results must not cause another inference');
 await stopWorker();
 for(const id of [first.id,second.id,navigation.id,accepted[0]!.id]){
  const events=await pool.query("SELECT type,count(*)::int AS count FROM task_events WHERE correlation_id=$1 AND type IN ('execution.started','execution.completed','task.completed') GROUP BY type ORDER BY type",[id]);
  assert.deepEqual(events.rows,[{type:'execution.completed',count:1},{type:'execution.started',count:1},{type:'task.completed',count:1}]);
  const delivery=(await pool.query('SELECT state,attempts FROM outbox WHERE task_id=$1',[id])).rows[0];assert.deepEqual(delivery,{state:'done',attempts:1});
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM messages WHERE task_id=$1 AND NOT agent_milestone',[id])).rows[0].count,1);
 }
});
