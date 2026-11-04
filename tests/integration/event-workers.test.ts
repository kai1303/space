import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { PostgresStore } from '@space/postgres/store';
import { NavigatorStore } from '@space/postgres/navigator';
import { ChatStore } from '@space/postgres/chat';
import { deliverOne } from '@space/core/worker';
const url=process.env.TEST_DATABASE_URL;
if(!url)throw new Error('TEST_DATABASE_URL required');
const schema=`events_worker_${randomBytes(8).toString('hex')}`;
const admin=new Pool({connectionString:url});
const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});
const store=new PostgresStore(pool);
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
async function queued(){const s=await bootstrap(pool);const task=await store.createTask(s.owner_id,{workspace_id:s.workspace_id,thread_id:s.thread_id,installation_id:s.installation_id,goal:'Run once',skill:'demo.echo'},randomUUID());await store.approveTask(s.owner_id,task.id);return {...s,task,delivery:(await pool.query('SELECT * FROM outbox WHERE task_id=$1',[task.id])).rows[0]};}
test('an event targets its delivery and competing accepts never replace an active attempt',async()=>{
 const a=await queued(),b=await queued();
 const claims=await Promise.all([store.claimDelivery(undefined,b.delivery.id),store.claimDelivery(undefined,b.delivery.id)]);
 assert.equal(claims.filter(Boolean).length,1);assert.equal(claims.find(Boolean)?.id,b.delivery.id);
 assert.equal((await pool.query('SELECT state FROM outbox WHERE id=$1',[a.delivery.id])).rows[0].state,'pending');
 await pool.query("UPDATE outbox SET lease_until=now()-interval '1 second' WHERE id=$1",[b.delivery.id]);
 assert.equal(await store.claimDelivery(undefined,b.delivery.id),null,'deadlines never grant a replacement attempt');
});
test('target deadline expires only the matching attempt and rejects its late events',async()=>{
 const a=await queued();const delivery=(await store.claimDelivery(undefined,a.delivery.id))!;
 await pool.query("UPDATE outbox SET lease_until=now()-interval '1 second' WHERE id=$1",[delivery.id]);
 await store.expireDelivery(delivery.id,randomUUID());assert.equal((await store.readTask(a.owner_id,a.task.id)).status,'queued');
 await store.expireDelivery(delivery.id,delivery.lease_token);assert.equal((await store.readTask(a.owner_id,a.task.id)).status,'failed');
 assert.equal(await store.ackDelivery(delivery),false);
});
test('connector failure after invocation is uncertain and cannot replay side effects',async()=>{
 const a=await queued();let calls=0;
 await deliverOne(store,[{id:'mock',async discover(){return {skills:['demo.echo'],controls:{}};},async invoke(){calls++;throw new Error('connection lost after tool');}}],1000,a.delivery.id);
 assert.equal(calls,1);assert.equal((await store.readTask(a.owner_id,a.task.id)).status,'failed');
 assert.equal((await pool.query('SELECT state FROM outbox WHERE id=$1',[a.delivery.id])).rows[0].state,'dead');
});
test('parallel Navigator events commit exactly one route without ownership leases',async()=>{
 const s=await bootstrap(pool),chat=new ChatStore(pool),nav=new NavigatorStore(pool);
 await chat.send(s.owner_id,s.channel_id,{text:`@agent-${s.installation_id} run this`,thread_id:s.thread_id,client_message_id:randomUUID()});
 await pool.query('UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1',[s.thread_id]);
 await Promise.all([nav.processOne(s.thread_id),nav.processOne(s.thread_id)]);
 assert.equal((await pool.query('SELECT * FROM tasks WHERE thread_id=$1',[s.thread_id])).rowCount,1);
 assert.equal((await pool.query('SELECT * FROM navigator_decisions WHERE thread_id=$1',[s.thread_id])).rowCount,1);
 const row=(await pool.query('SELECT lease_token,lease_until FROM navigator_threads WHERE thread_id=$1',[s.thread_id])).rows[0];assert.equal(row.lease_token,null);assert.equal(row.lease_until,null);
});
test('semantic inference reserves once and has no exclusive queue lease',async()=>{
 const s=await bootstrap(pool),chat=new ChatStore(pool);let calls=0;
 const nav=new NavigatorStore(pool,{level1:{name:'test',model:'test',maxOutputTokens:1,async decide(){calls++;const row=(await pool.query('SELECT lease_until,lease_token FROM navigator_threads WHERE thread_id=$1',[s.thread_id])).rows[0];assert.equal(row.lease_until,null);assert.equal(row.lease_token,null);return {decision:{action:'ignore',capabilities:[],evidenceMessageIds:[],reason:'No action'},inputTokens:1,outputTokens:1};}}});
 await nav.configure(s.owner_id,s.channel_id,{mode:'semantic'});
 await chat.send(s.owner_id,s.channel_id,{text:'Consider this question',thread_id:s.thread_id,client_message_id:randomUUID()});await pool.query('UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1',[s.thread_id]);
 const outcomes=await Promise.allSettled([nav.processOne(s.thread_id),nav.processOne(s.thread_id)]);assert.ok(outcomes.some(r=>r.status==='fulfilled'));for(const r of outcomes)if(r.status==='rejected')assert.equal(r.reason.code,'navigation_inference_pending');assert.equal(calls,1);
 const inference=(await pool.query('SELECT error FROM navigator_inferences WHERE thread_id=$1',[s.thread_id])).rows[0];assert.equal(inference.error,null);
});
test('a concurrent paid inference cannot consume the route while its response is pending',async()=>{
 const s=await bootstrap(pool),chat=new ChatStore(pool);let calls=0;let release!:()=>void,entered!:()=>void;
 const barrier=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
 const nav=new NavigatorStore(pool,{level1:{name:'test',model:'test',maxOutputTokens:1,async decide(context){calls++;entered();await barrier;return {decision:{action:'suggest',capabilities:['demo.echo'],evidenceMessageIds:context.pendingMessageIds??[],reason:'Can help'},inputTokens:1,outputTokens:1};}}});
 await nav.configure(s.owner_id,s.channel_id,{mode:'semantic'});await chat.send(s.owner_id,s.channel_id,{text:'Please consider this request',thread_id:s.thread_id,client_message_id:randomUUID()});await pool.query('UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1',[s.thread_id]);
 const first=nav.processOne(s.thread_id);await started;
 try {await assert.rejects(nav.processOne(s.thread_id),{code:'navigation_inference_pending'});}
 finally {release();await first;}
 assert.equal(calls,1);assert.equal((await nav.suggestions(s.owner_id,s.channel_id,s.thread_id)).length,1);
});
test('a crashed paid inference settles uncertain after its deadline without another charge',async()=>{
 const s=await bootstrap(pool),chat=new ChatStore(pool);let calls=0;
 const nav=new NavigatorStore(pool,{level1:{name:'test',model:'test',maxOutputTokens:1,async decide(){calls++;throw new Error('must not repeat');}}});
 await nav.configure(s.owner_id,s.channel_id,{mode:'semantic'});
 const message=await chat.send(s.owner_id,s.channel_id,{text:'Consider this question',thread_id:s.thread_id,client_message_id:randomUUID()});
 await pool.query("INSERT INTO navigator_inferences(thread_id,through_sequence,level,channel_id,provider,model,reserved_tokens,started_at) VALUES($1,$2,1,$3,'test','test',5000,now()-interval '20 seconds')",[s.thread_id,message.sequence,s.channel_id]);
 await pool.query('UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1',[s.thread_id]);
 await nav.processOne(s.thread_id);assert.equal(calls,0);
 const row=(await pool.query('SELECT error,reserved_tokens FROM navigator_inferences WHERE thread_id=$1',[s.thread_id])).rows[0];assert.equal(row.error,'provider_interrupted');assert.equal(row.reserved_tokens,5000);
 assert.equal((await pool.query('SELECT last_sequence::text FROM navigator_threads WHERE thread_id=$1',[s.thread_id])).rows[0].last_sequence,message.sequence);
});
test('duplicate ready events preserve a healthy attempt and its original token can complete',async()=>{
 const a=await queued(),delivery=(await store.claimDelivery(undefined,a.delivery.id))!;
 const event=(sequence:number,type:'execution.started'|'execution.completed')=>({id:randomUUID(),schema_version:'1.0',execution_id:delivery.execution_id,sequence,type,occurred_at:new Date().toISOString(),payload:{text:'Healthy result'}});
 await store.acceptEvent(a.installation_id,event(1,'execution.started'),delivery);
 assert.equal(await store.claimDelivery(undefined,delivery.id),null);
 const active=(await pool.query('SELECT state,lease_token,attempts FROM outbox WHERE id=$1',[delivery.id])).rows[0];assert.deepEqual(active,{state:'delivering',lease_token:delivery.lease_token,attempts:1});
 assert.equal((await store.readTask(a.owner_id,a.task.id)).status,'running');
 await store.acceptEvent(a.installation_id,event(2,'execution.completed'),delivery);assert.equal(await store.ackDelivery(delivery),true);
 assert.equal((await store.readTask(a.owner_id,a.task.id)).status,'completed');
});
test('an elapsed execution deadline rejects preparation, writes and renewal before consumer settlement',async()=>{
 const a=await queued(),delivery=(await store.claimDelivery(undefined,a.delivery.id))!,connection=randomUUID();
 await pool.query("INSERT INTO agent_connections(installation_id,name,auth_status,connection_id,last_seen_at) VALUES($1,'Deadline test','ready',$2,now())",[a.installation_id,connection]);
 const event=(sequence:number,type:'execution.started'|'execution.completed')=>({id:randomUUID(),schema_version:'1.0',execution_id:delivery.execution_id,sequence,type,occurred_at:new Date().toISOString(),payload:{text:'Deadline result'}});
 await store.acceptEvent(a.installation_id,event(1,'execution.started'),delivery);
 await pool.query("UPDATE outbox SET lease_until=now()-interval '1 second' WHERE id=$1",[delivery.id]);
 await assert.rejects(store.prepareDelivery(delivery),{code:'stale_lease'});
 await assert.rejects(store.acceptEvent(a.installation_id,event(2,'execution.completed'),delivery),{code:'stale_lease'});
 assert.equal(await store.renewDelivery(delivery,connection),false);
 const active=(await pool.query('SELECT state,lease_token,attempts FROM outbox WHERE id=$1',[delivery.id])).rows[0];assert.deepEqual(active,{state:'delivering',lease_token:delivery.lease_token,attempts:1});
 assert.equal((await store.readTask(a.owner_id,a.task.id)).status,'running');
 assert.equal(await store.claimDelivery(undefined,delivery.id),null);
 await store.expireDelivery(delivery.id,delivery.lease_token);
 assert.equal((await store.readTask(a.owner_id,a.task.id)).status,'failed');
 assert.equal(await store.ackDelivery(delivery),false);
});
