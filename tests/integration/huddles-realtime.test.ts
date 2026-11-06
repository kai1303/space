import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {io} from 'socket.io-client';
import {connect} from 'nats';
import {EventBus,streamName} from '@space/events';
import {migrate} from '@space/postgres/migrate';
import {bootstrap} from '@space/postgres/bootstrap';
import {PostgresStore} from '@space/postgres/store';
import {EventBridge} from '@space/event-service/bridge';
import {createApi} from '@space/server/api';
import type {HuddleMedia} from '@space/server/huddle-media';

test('authenticated routes, pushed discovery and durable room shutdown across API instances',{timeout:60000},async t=>{
 assert.ok(process.env.TEST_DATABASE_URL);
 const schema=`huddle_rt_${randomBytes(6).toString('hex')}`,url=new URL(process.env.TEST_DATABASE_URL);
 // This fixture owns and deletes its broker streams; the shared CDC must not publish to them.
 url.pathname=`/${schema}`;
 url.searchParams.set('options',`-c search_path=${schema}`);
 const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL}),pool=new Pool({connectionString:url.toString()});
 const natsUrl=process.env.NATS_URL??'nats://127.0.0.1:54222';
 const bridge=new EventBridge({databaseUrl:url.toString(),natsUrl,schema});
 let failures:EventBus|undefined;
 const rooms=new Set<string>();let closed!:(id:string)=>void;
 const removed=new Promise<string>(resolve=>closed=resolve);
 const media:HuddleMedia={url:'ws://localhost:7880',create:async id=>{rooms.add(id);},remove:async id=>{rooms.delete(id);closed(id);},exists:async id=>rooms.has(id),token:async()=> 'room-scoped-test-token',webhook:async()=>{throw Error('bad signature');}};
 const apps=[0,1].map(()=>createApi(new PostgresStore(pool),{allowDevelopmentTokens:true,huddles:media,realtime:{eventUrl:natsUrl}}));
 t.after(async()=>{await failures?.close();await Promise.all(apps.map(a=>a.close()));await bridge.close();await pool.end();await admin.query(`DROP DATABASE ${schema}`);await admin.end();
  const broker=await connect({servers:natsUrl});try{const manager=await broker.jetstreamManager();for(const suffix of ['CHAT','WORK','SEARCH'])await manager.streams.delete(`${streamName(schema)}_${suffix}`).catch(()=>{});}finally{await broker.close();}
 });
 await admin.query(`CREATE DATABASE ${schema}`);await pool.query(`CREATE SCHEMA ${schema}`);await migrate(pool);const a=await bootstrap(pool);
 const addresses=await Promise.all(apps.map(a=>a.listen({port:0,host:'127.0.0.1'})));await bridge.start();
 const client=io(addresses[1]!,{transports:['websocket'],auth:{token:a.collaborator_token},autoConnect:false});t.after(()=>{client.disconnect();});
 await new Promise<void>((resolve,reject)=>{client.once('connect',resolve);client.once('connect_error',reject);client.connect();});
 const subscribed=await client.timeout(5000).emitWithAck('updates.subscribe',{scope:'channel',id:a.channel_id});assert.ok(!subscribed.error);
 const changed=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('No huddle discovery update')),10000);client.on('updates.changed',value=>{if(value.id===a.channel_id){clearTimeout(timer);resolve();}});});
 const path=`/v1/channels/${a.channel_id}/huddle/join`,headers={authorization:`Bearer ${a.owner_token}`};
 assert.equal((await apps[0]!.inject({method:'POST',url:path,payload:{}})).statusCode,401);
 const joined=await apps[0]!.inject({method:'POST',url:path,headers,payload:{}});assert.equal(joined.statusCode,200,joined.body);
 assert.equal(joined.json().token,'room-scoped-test-token');await changed;
 const listed=await apps[1]!.inject({url:`/v1/workspaces/${a.workspace_id}/huddles`,headers});assert.equal(listed.json().items[0].id,joined.json().huddle.id);
 const forged=await apps[0]!.inject({method:'POST',url:'/v1/huddles/webhook',headers:{'content-type':'application/webhook+json'},payload:'{"event":"room_finished"}'});assert.equal(forged.statusCode,401);
 await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[a.workspace_id,a.collaborator_id]);
 const timeout=setTimeout(()=>closed('deadline-exceeded'),10000);
 try{assert.equal(await removed,joined.json().huddle.id);}finally{clearTimeout(timeout);}
 assert.equal(rooms.size,0);
 failures=new EventBus(natsUrl,schema);await failures.start();
 let exhausted!:(data:Record<string,unknown>)=>void;const failure=new Promise<Record<string,unknown>>(resolve=>exhausted=resolve);
 await failures.subscribe('huddle_failure.*',{durable:'test-huddle-failures',maxPending:1},async d=>{exhausted(d.event.data);await d.ack();});
 media.remove=async()=>{throw Error('provider unavailable');};
 await failures.publish({id:randomUUID(),schema,kind:'huddle.close',aggregate_id:joined.json().huddle.id,data:{attempts:7}});
 const deadline=setTimeout(()=>exhausted({error:'not retained'}),10000);
 try{assert.deepEqual((({operation,attempts})=>({operation,attempts}))(await failure),{operation:'huddle.close',attempts:8});}finally{clearTimeout(deadline);}
});
