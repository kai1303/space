import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { io } from 'socket.io-client';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';
import { RedisSocketAdapter } from '@space/redis';
import { createServer } from 'node:net';
import { EventBus } from '@space/events';
import { deliveryHealth } from '../../apps/server/dist/realtime-health.js';

const schema = `scaling_${randomBytes(6).toString('hex')}`;
const admin = new Pool({connectionString:process.env.TEST_DATABASE_URL});
const pool = new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
const store = new PostgresStore(pool);
const app = createApi(store,{allowDevelopmentTokens:true});
let address:string;
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);address=await app.listen({host:'127.0.0.1',port:0});});
after(async()=>{await app.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
async function connect(token:string,base=address){
  const socket=io(base,{transports:['websocket'],auth:{token},reconnection:false});
  await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',error=>{socket.disconnect();reject(error);});});
  socket.on('updates.changed',(_value,ack)=>ack());
  return socket;
}
async function settled(){await delay(250);}
async function until(check:()=>boolean){const deadline=Date.now()+5000;while(!check()){assert.ok(Date.now()<deadline,'timed out waiting for delivery');await delay(10);}}

test('a channel change does no authentication or revision reads for an unrelated workspace',async()=>{
  const a=await bootstrap(pool),b=await bootstrap(pool),socket=await connect(a.owner_token);
  await socket.timeout(2000).emitWithAck('updates.subscribe',{scope:'workspace',id:a.workspace_id});
  await settled();
  const original=store.authenticate.bind(store);let authentications=0;
  store.authenticate=async token=>{authentications++;return original(token);};
  try{
    await pool.query("UPDATE channels SET topic='Unrelated' WHERE id=$1",[b.channel_id]);
    await settled();
    assert.equal(authentications,0,'unrelated sockets must not be scheduled');
    await pool.query("UPDATE channels SET topic='Relevant' WHERE id=$1",[a.channel_id]);
    await until(()=>authentications>0);
  }finally{store.authenticate=original;socket.disconnect();}
});

test('credential invalidation targets its actor, including sockets without subscriptions',async()=>{
  const a=await bootstrap(pool),b=await bootstrap(pool),one=await connect(a.owner_token),two=await connect(b.owner_token);
  await settled();
  const original=store.authenticate.bind(store);const seen:string[]=[];
  store.authenticate=async token=>{seen.push(token);return original(token);};
  try{
    await pool.query('DELETE FROM human_credentials WHERE user_id=$1',[a.owner_id]);
    await settled();
    assert.equal(one.connected,false);assert.equal(two.connected,true);
    assert.ok(!seen.includes(b.owner_token),'revocation must not reauthenticate unrelated actors');
  }finally{store.authenticate=original;one.disconnect();two.disconnect();}
});

test('targeted WAL hints retain resource scope and actor routing metadata',async()=>{
  const a=await bootstrap(pool);
  // Inspect within a transaction so CDC cannot consume the rows before assertions.
  const client=await pool.connect();await client.query('BEGIN');
  try{
    await client.query('DELETE FROM event_outbox');
    await client.query("UPDATE channels SET topic=$1 WHERE id=$2",[randomUUID(),a.channel_id]);
    const {rows}=await client.query("SELECT payload FROM event_outbox WHERE kind='chat.changed'");
    assert.ok(rows.some(row=>row.payload.keys?.includes(`workspace:${a.workspace_id}`)));
  }finally{await client.query('ROLLBACK');client.release();}
});

test('connection admission rejects excess actor connections and releases capacity on disconnect',async()=>{
  const temporary=createApi(new PostgresStore(pool),{allowDevelopmentTokens:true,realtime:{maxActorConnections:1,maxConnections:3}});
  const base=await temporary.listen({host:'127.0.0.1',port:0}),a=await bootstrap(pool);
  const first=await connect(a.owner_token,base);
  try{
    await assert.rejects(connect(a.owner_token,base),/connection_limit/);
    first.disconnect();await delay(50);
    const replacement=await connect(a.owner_token,base);replacement.disconnect();
  }finally{first.disconnect();await temporary.close();}
});

test('process connection admission caps total transports before authentication',async()=>{
  const temporary=createApi(new PostgresStore(pool),{allowDevelopmentTokens:true,realtime:{maxActorConnections:4,maxConnections:2}});
  const base=await temporary.listen({host:'127.0.0.1',port:0}),a=await bootstrap(pool);
  const first=await connect(a.owner_token,base),second=await connect(a.owner_token,base);
  try{
    await assert.rejects(connect(a.owner_token,base),/websocket error/);
    const health=await temporary.inject({method:'GET',url:'/readyz'});
    assert.equal(health.json().realtime.connections,2);assert.ok(health.json().realtime.rejectedConnections>=1);
  }finally{first.disconnect();second.disconnect();await temporary.close();}
});

test('readiness reports broker, consumer and active CDC separately from database liveness',async()=>{
  const response=await app.inject({method:'GET',url:'/readyz'});
  assert.equal(response.statusCode,200);
  assert.equal(response.json().status,'ready');
  assert.equal(response.json().realtime.broker,true);
  assert.equal(response.json().realtime.consumer,true);
});

test('database liveness stays healthy but readiness rejects a database without CDC',async()=>{
  const name=`health_${randomBytes(6).toString('hex')}`,url=new URL(process.env.TEST_DATABASE_URL!);url.pathname=`/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const isolated=new Pool({connectionString:url.toString(),options:`-c search_path=${name}`});
  const temporary=createApi(new PostgresStore(isolated),{allowDevelopmentTokens:true});
  try{
    await isolated.query(`CREATE SCHEMA ${name}`);await migrate(isolated);await temporary.ready();
    assert.equal((await temporary.inject({method:'GET',url:'/healthz'})).statusCode,200);
    const response=await temporary.inject({method:'GET',url:'/readyz'});
    assert.equal(response.statusCode,503);assert.equal(response.json().realtime.cdc.active,false);
  }finally{await temporary.close();await isolated.end();await admin.query(`DROP DATABASE ${name}`);}
});

test('one slow ACK does not occupy the only database work slot',async()=>{
  const temporary=createApi(new PostgresStore(pool),{allowDevelopmentTokens:true,realtime:{workConcurrency:1}});
  const base=await temporary.listen({host:'127.0.0.1',port:0}),a=await bootstrap(pool),socket=await connect(a.owner_token,base);
  let unread=false;socket.on('workspace.unread',()=>{unread=true;});
  try{
    assert.ok((await socket.timeout(2000).emitWithAck('workspace.subscribe',{workspace_id:a.workspace_id})).data);
    await until(()=>unread);
    assert.ok((await socket.timeout(2000).emitWithAck('updates.subscribe',{scope:'channel',id:a.channel_id})).data);
  }finally{socket.disconnect();await temporary.close();}
});

test('task progress does not schedule unrelated metadata subscriptions in the same workspace',async()=>{
  const a=await bootstrap(pool),socket=await connect(a.owner_token);
  await socket.timeout(2000).emitWithAck('updates.subscribe',{scope:'channel',id:a.channel_id});await settled();
  const original=store.authenticate.bind(store);let reads=0;
  store.authenticate=async token=>{reads++;return original(token);};
  try{
    await pool.query("SELECT append_chat_event($1,$2,'task.event',$3::jsonb)",[a.channel_id,a.thread_id,JSON.stringify({task_id:randomUUID()})]);
    await settled();assert.equal(reads,0);
  }finally{store.authenticate=original;socket.disconnect();}
});

test('API starts and delivers chat with an unavailable Redis adapter',async()=>{
  const refused=createServer(socket=>socket.destroy());await new Promise<void>(resolve=>refused.listen(0,'127.0.0.1',resolve));
  const port=(refused.address() as {port:number}).port;
  const adapter=new RedisSocketAdapter(`redis://127.0.0.1:${port}`,schema);
  const connecting=adapter.connect().catch(()=>{});
  const temporary=createApi(new PostgresStore(pool),{allowDevelopmentTokens:true,realtime:{adapter}});
  try{
    const base=await temporary.listen({host:'127.0.0.1',port:0}),a=await bootstrap(pool),socket=await connect(a.owner_token,base);
    try{
      const result=await socket.timeout(3000).emitWithAck('message.send',{channel_id:a.channel_id,client_message_id:randomUUID(),text:'Redis is optional'});
      assert.ok(result.data?.id);
      const health=await temporary.inject({method:'GET',url:'/readyz'});
      assert.equal(health.statusCode,200);assert.equal(health.json().realtime.typing,false);
    }finally{socket.disconnect();}
  }finally{await temporary.close();await connecting;await new Promise<void>(resolve=>refused.close(()=>resolve()));}
});

test('broker recovery replaces a consumer even when old consumer cleanup fails',async()=>{
  class FailingCleanupBus extends EventBus {
    attached=0; cleaning=false; reconnectNow:()=>void=()=>{};
    override async start() {}
    override onReconnect(callback:()=>void){this.reconnectNow=callback;return()=>{};}
    override async subscribe(filter:string){
      if(filter==='chat.changed.*'){const first=++this.attached===1;return async()=>{if(first&&!this.cleaning)throw new Error('broker disconnected during flush');};}
      return async()=>{};
    }
  }
  const bus=new FailingCleanupBus('nats://unused',schema);
  const temporary=createApi(new PostgresStore(pool),{allowDevelopmentTokens:true,realtime:{events:bus}});
  try{await temporary.ready();assert.equal(bus.attached,1);bus.reconnectNow();await until(()=>bus.attached===2);}
  finally{bus.cleaning=true;await temporary.close();}
});

test('stale unpublished work makes readiness fail even with an active replication slot',async()=>{
  const client=await pool.connect();await client.query('BEGIN');
  try{
    await client.query("INSERT INTO event_outbox(kind,aggregate_id,payload,created_at) VALUES('chat.changed','all','{}',now()-interval '60 seconds')");
    const health=await deliveryHealth(client,schema);
    assert.equal(health.active,true);assert.equal(health.ready,false);assert.ok(health.oldestSeconds>=60);
  }finally{await client.query('ROLLBACK');client.release();}
});
