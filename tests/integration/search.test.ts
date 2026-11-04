import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { PostgresStore } from '@space/postgres/store';
import { ChatStore } from '@space/postgres/chat';
import { createApi } from '@space/server/api';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL required');

test('Typesense searches durable history and enforces workspace access', {timeout:90_000}, async t => {
  const schema = `search_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({connectionString:url});
  const pool = new Pool({connectionString:url,options:`-c search_path=${schema}`});
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  const app = createApi(new PostgresStore(pool), {allowDevelopmentTokens:true});
  t.after(async()=>{await app.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  const seed = await bootstrap(pool);
  const chat = new ChatStore(pool);
  await chat.send(seed.owner_id,seed.channel_id,{client_message_id:randomUUID(),text:'historicalsearch deployment failure'});
  const {EventBus}=await import('@space/events');
  const {connect}=await import('nats');
  const bus=new EventBus(process.env.NATS_URL??'nats://127.0.0.1:54222',schema);await bus.start();
  await bus.publish({id:randomUUID(),schema,kind:'search.message',aggregate_id:seed.channel_id,data:{}});
  const nc=await connect({servers:process.env.NATS_URL??'nats://127.0.0.1:54222'});
  assert.equal((await (await nc.jetstreamManager()).streams.info(bus.stream+'_SEARCH')).state.messages,0,'unconfigured search must retain no broker work');
  await nc.close();await bus.close();
  const response = await app.inject({method:'GET',url:`/v1/workspaces/${seed.workspace_id}/search?q=historicalsearch`,headers:{authorization:`Bearer ${seed.owner_token}`}});
  assert.equal(response.statusCode,503,'search must have an explicit unavailable response when unconfigured');
});

test('real WAL → JetStream → Typesense covers full history, revisions, isolation and restart', {timeout:120_000}, async t=>{
  const {EventBridge}=await import('@space/event-service/bridge');
  const {EventBus}=await import('@space/events');
  const {SearchStore}=await import('@space/postgres/search');
  const {TypesenseSearch}=await import('@space/server/typesense');
  const {indexMessage,startSearchConsumer}=await import('@space/server/search');
  const schema=`search_e2e_${randomBytes(6).toString('hex')}`;
  const admin=new Pool({connectionString:url});
  const scoped=new URL(url!);scoped.searchParams.set('options',`-c search_path=${schema}`);
  const pool=new Pool({connectionString:scoped.toString()});
  const natsUrl=process.env.NATS_URL??'nats://127.0.0.1:54222';
  const config={url:process.env.TYPESENSE_URL??'http://127.0.0.1:58108',apiKey:process.env.TYPESENSE_API_KEY??'space_local_search',collection:schema};
  const engine=new TypesenseSearch(config),bus=new EventBus(natsUrl,schema);
  const bridge=new EventBridge({databaseUrl:scoped.toString(),natsUrl,schema});
  let heldWriter:PoolClient|undefined;
  let stop:(()=>Promise<void>)|undefined;
  let app:ReturnType<typeof createApi>|undefined;
  t.after(async()=>{
    if(heldWriter){await heldWriter.query('ROLLBACK');heldWriter.release();}
    await app?.close();await stop?.();await bridge.close();await bus.close();
    await engine.removeCollection().catch(()=>{});await pool.end();
    await admin.query('SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name=$1',[bridge.slot]);
    await admin.query(`DROP PUBLICATION IF EXISTS "${bridge.publication}"`);
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
  });
  await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);
  const seed=await bootstrap(pool),other=await bootstrap(pool),chat=new ChatStore(pool),store=new SearchStore(pool);
  const first=await chat.send(seed.owner_id,seed.channel_id,{client_message_id:randomUUID(),text:'historicalneedle deployment failed'});
  // Created before the consumer starts: this tests durable bootstrap delivery.
  for(let i=0;i<55;i++)await chat.send(seed.owner_id,seed.channel_id,{client_message_id:randomUUID(),text:`filler ${i}`});
  assert.ok(!(await chat.messageHistory(seed.owner_id,seed.channel_id)).messages.some(m=>m.id===first.id));
  await engine.initialize();await bus.start();await bridge.start();
  const writer=heldWriter=await pool.connect();
  await writer.query('BEGIN');
  const pendingId=randomUUID();
  await writer.query(`INSERT INTO messages(id,workspace_id,channel_id,thread_id,author_type,user_id,client_message_id,request_hash,text) VALUES($1,$2,$3,$4,'human',$5,$6,'test','activationraceneedle')`,[pendingId,seed.workspace_id,seed.channel_id,seed.thread_id,seed.owner_id,randomUUID()]);
  stop=await startSearchConsumer(bus,store,engine);
  await store.backfillPage();
  await writer.query('COMMIT');
  app=createApi(new PostgresStore(pool),{allowDevelopmentTokens:true,search:config});
  const search=async(q:string,token=seed.owner_token,workspace=seed.workspace_id,extra='')=>{
    const response=await app!.inject({method:'GET',url:`/v1/workspaces/${workspace}/search?q=${encodeURIComponent(q)}${extra}`,headers:{authorization:`Bearer ${token}`}});
    assert.equal(response.statusCode,200,response.body);return response.json();
  };
  // Bounded assertion retries are test synchronization, never production polling.
  const eventually=async(check:()=>Promise<boolean>)=>{
    for(let i=0;i<100;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,100));}
    assert.fail('search did not converge within 10 seconds');
  };
  await eventually(async()=> (await search('historicalneedle')).items.some((m:any)=>m.id===first.id));
  await eventually(async()=> (await search('activationraceneedle')).items.some((m:any)=>m.id===pendingId));
  writer.release();heldWriter=undefined;
  const hit=(await search('historicalneedle')).items[0];assert.equal(hit.channel_id,seed.channel_id);assert.equal(hit.author.id,seed.owner_id);
  assert.equal((await search('historicalneedle',other.owner_token,other.workspace_id)).items.length,0);
  const privateChannel=await chat.createChannel(seed.owner_id,seed.workspace_id,{name:'private-search',private:true});
  const secret=await chat.send(seed.owner_id,privateChannel.id,{client_message_id:randomUUID(),text:'secretonlyneedle'});
  await eventually(async()=> (await search('secretonlyneedle')).items.length===1);
  assert.equal((await search('secretonlyneedle',seed.collaborator_token)).items.length,0);
  assert.equal((await search('secretonlyneedle',seed.collaborator_token,seed.workspace_id,`&channel_id=${privateChannel.id}`)).items.length,0);
  const dm=await chat.directMessages.open(seed.owner_id,seed.workspace_id,{user_id:seed.owner_id});
  await chat.send(seed.owner_id,dm.id,{client_message_id:randomUUID(),text:'directneedle private self conversation'});
  await eventually(async()=> (await search('directneedle')).items.length===1);
  assert.equal((await search('directneedle')).items[0].channel_kind,'direct');
  assert.equal((await search('directneedle',seed.collaborator_token)).items.length,0);
  assert.equal((await search('historicalneedle from:me')).items.length,1);
  assert.equal((await search('historicalneedle in:general')).items.length,1);
  const reply=await chat.send(seed.collaborator_id,seed.channel_id,{client_message_id:randomUUID(),thread_id:first.thread_id,text:'replyneedle https://example.test'});
  await eventually(async()=> (await search('replyneedle has:link is:thread')).items.length===1);
  assert.equal((await search('replyneedle')).items[0].is_reply,true);
  // Stop all consumers so assertions below prove hydration rejects stale indexed content.
  await app.close();app=undefined;await stop();stop=undefined;
  const stale=await store.document(first.id,seed.channel_id);
  await pool.query('UPDATE messages SET text=$1 WHERE channel_id=$2 AND id=$3',['replacementneedle',seed.channel_id,first.id]);
  await indexMessage(store,engine,first.id,seed.channel_id);
  await engine.upsert([stale!]); // Deliberately late old revision must not overwrite the current document.
  const readOnly=createApi(new PostgresStore(pool),{allowDevelopmentTokens:true,search:{...config,indexing:false}});
  app=readOnly;
  assert.equal((await search('historicalneedle')).items.length,0);
  assert.equal((await search('replacementneedle')).items.length,1);
  await pool.query('DELETE FROM notifications WHERE channel_id=$1 AND message_id=$2',[seed.channel_id,reply.id]);
  await pool.query('DELETE FROM messages WHERE channel_id=$1 AND id=$2',[seed.channel_id,reply.id]);
  assert.equal((await search('replyneedle')).items.length,0);
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[privateChannel.id,seed.owner_id]);
  assert.equal((await search('secretonlyneedle')).items.length,0);
  const pending=await chat.send(seed.owner_id,seed.channel_id,{client_message_id:randomUUID(),text:'restartneedle'});
  assert.equal((await search('restartneedle')).items.length,0);
  const originalUpsert=engine.upsert.bind(engine);let failedWrites=0;
  engine.upsert=async docs=>{if(!failedWrites&&docs.some(d=>d.text==='restartneedle')){failedWrites++;throw new Error('transient index outage');}await originalUpsert(docs);};
  stop=await startSearchConsumer(bus,store,engine);
  await eventually(async()=> (await search('restartneedle')).items.some((m:any)=>m.id===pending.id));
  assert.equal(failedWrites,1,'failed handler must recover through durable delayed NAK');
  // Replayed events are idempotent, and stale versions stay invisible.
  await Promise.all([indexMessage(store,engine,first.id,seed.channel_id),indexMessage(store,engine,first.id,seed.channel_id)]);
  assert.equal((await search('replacementneedle')).items.length,1);
  const firstPage=await search('filler');assert.equal(firstPage.items.length,20);assert.ok(firstPage.next_cursor);
  const expectedNext=(await search('filler',seed.owner_token,seed.workspace_id,`&cursor=${encodeURIComponent(firstPage.next_cursor)}`)).items[0].id;
  await pool.query('DELETE FROM notifications WHERE message_id=$1',[firstPage.items[0].id]);
  await pool.query('DELETE FROM messages WHERE channel_id=$1 AND id=$2',[seed.channel_id,firstPage.items[0].id]);
  await indexMessage(store,engine,firstPage.items[0].id,seed.channel_id);
  const secondPage=await search('filler',seed.owner_token,seed.workspace_id,`&cursor=${encodeURIComponent(firstPage.next_cursor)}`);
  assert.equal(secondPage.items[0].id,expectedNext,'deletion before a cursor must not skip an untouched message');
  assert.equal(secondPage.items.length,20);assert.ok(!secondPage.items.some((m:any)=>firstPage.items.some((p:any)=>p.id===m.id)));
  await chat.send(seed.collaborator_id,seed.channel_id,{client_message_id:randomUUID(),text:'formerwriterneedle'});
  await eventually(async()=> (await search('formerwriterneedle')).items.length===1);
  await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[seed.workspace_id,seed.collaborator_id]);
  assert.equal((await search('formerwriterneedle from:"Demo collaborator"')).items.length,1,'former authors remain searchable');
  assert.ok(secret.id);
});
