import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {io,type Socket} from 'socket.io-client';
import {migrate} from '@space/postgres/migrate';
import {bootstrap} from '@space/postgres/bootstrap';
import {ChatStore} from '@space/postgres/chat';
import {PostgresStore} from '@space/postgres/store';
import {EventBridge} from '@space/event-service/bridge';
import {createApi} from '@space/server/api';
const timeout=15000;
function event<T>(socket:Socket,name:string,match:(v:T)=>boolean=()=>true):Promise<T>{return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.off(name,read);reject(Error(`Missing ${name}`));},timeout);const read=(value:T)=>{if(!match(value))return;clearTimeout(timer);socket.off(name,read);resolve(value);};socket.on(name,read);});}
async function command(socket:Socket,name:string,input:object){const reply=await socket.timeout(timeout).emitWithAck(name,input);if(reply.error)throw Error(reply.error);return reply.data;}
test('two API instances deliver durable invitations, scoped transient signaling, reconnect snapshots and deadlines',{timeout:120000},async t=>{
 const url=process.env.TEST_DATABASE_URL;if(!url)throw Error('TEST_DATABASE_URL required');
 const schema=`call_rt_${randomBytes(6).toString('hex')}`,admin=new Pool({connectionString:url});
 const scoped=new URL(url);scoped.searchParams.set('options',`-c search_path=${schema}`);
 const pool=new Pool({connectionString:scoped.toString()}),natsUrl=process.env.NATS_URL??'nats://127.0.0.1:54222';
 const bridge=new EventBridge({databaseUrl:scoped.toString(),natsUrl,schema});
 const apps=[createApi(new PostgresStore(pool),{allowDevelopmentTokens:true,realtime:{eventUrl:natsUrl}}),createApi(new PostgresStore(pool),{allowDevelopmentTokens:true,realtime:{eventUrl:natsUrl}})];
 const sockets:Socket[]=[];
 t.after(async()=>{sockets.forEach(s=>s.disconnect());await Promise.all(apps.map(a=>a.close()));await bridge.close();await pool.end();await admin.query('SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name=$1',[bridge.slot]);await admin.query(`DROP PUBLICATION IF EXISTS "${bridge.publication}"`);await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
 await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);
 const seed=await bootstrap(pool),other=await bootstrap(pool),chat=new ChatStore(pool);
 const dm=await chat.directMessages.open(seed.owner_id,seed.workspace_id,{user_id:seed.collaborator_id});
 const addresses=await Promise.all(apps.map(a=>a.listen({host:'127.0.0.1',port:0})));await bridge.start();
 async function connect(token:string,api:number){const s=io(addresses[api]!,{transports:['websocket'],auth:{token},autoConnect:false});sockets.push(s);const ready=event(s,'connect');s.connect();await ready;return s;}
 const a=await connect(seed.owner_token,0),b=await connect(seed.collaborator_token,1),b2=await connect(seed.collaborator_token,0),stranger=await connect(other.owner_token,1);
 const ad=randomUUID(),bd=randomUUID(),b2d=randomUUID();
 for(const [s,d] of [[a,ad],[b,bd],[b2,b2d],[stranger,randomUUID()]] as const)await command(s,'call.subscribe',{device_id:d});
 let leaked=0;stranger.on('call.signal',()=>leaked++);stranger.on('call.state',v=>{if(v.call)leaked++;});
 const id=randomUUID();const incoming=event<any>(b,'call.state',v=>v.call?.id===id),incoming2=event<any>(b2,'call.state',v=>v.call?.id===id);
 await command(a,'call.start',{id,channel_id:dm.id,device_id:ad,mode:'video'});
 assert.equal((await incoming).call.state,'ringing');await incoming2;
 const accepted=event<any>(a,'call.state',v=>v.call?.state==='accepted');await command(b,'call.accept',{call_id:id});const acceptedView=(await accepted).call;assert.equal(acceptedView.selected,true);assert.equal('caller_device' in acceptedView,false);assert.equal('callee_device' in acceptedView,false);
 const otherDeviceView=(await command(b2,'call.subscribe',{device_id:b2d})).call;assert.equal(otherDeviceView.selected,false);assert.equal('callee_device' in otherDeviceView,false);
 await assert.rejects(command(b2,'call.accept',{call_id:id}),/call_other_device/);
 const signal={call_id:id,generation:randomUUID(),description:{type:'offer',sdp:'v=0\r\n'}};
 const delivered=event<any>(b,'call.signal');await command(a,'call.signal',signal);assert.deepEqual(await delivered,signal);
 await assert.rejects(command(stranger,'call.signal',signal),/not_found/);
 await assert.rejects(command(b2,'call.signal',signal),/call_other_device/);
 assert.equal((await pool.query("SELECT count(*)::int n FROM event_outbox WHERE payload::text LIKE '%v=0%' ")).rows[0].n,0,'SDP is never persisted');
 b.disconnect();const reconnected=event(b,'connect');b.connect();await reconnected;
 assert.equal((await command(b,'call.subscribe',{device_id:bd,call_id:id})).call.state,'accepted');
 await command(b,'call.heartbeat',{call_id:id});
 const ended=event<any>(a,'call.state',v=>v.call?.state==='ended');await command(b,'call.end',{call_id:id});assert.equal((await ended).call.reason,'completed');
 const missed=randomUUID();await command(a,'call.start',{id:missed,channel_id:dm.id,device_id:ad,mode:'audio'});
 // Move only this fixture's deadline into the past, then exercise actual WAL -> broker -> deadline consumer.
 const expired=event<any>(b,'call.state',v=>v.call?.id===missed&&v.call.state==='ended');
 await pool.query("UPDATE dm_calls SET created_at=now()-interval '31 seconds' WHERE id=$1",[missed]);
 await pool.query("INSERT INTO event_outbox(kind,aggregate_id,payload,available_at) VALUES('call.deadline',$1,'{}',now())",[missed]);
 assert.equal((await expired).call.reason,'missed');assert.equal(leaked,0);
 const history=await apps[0]!.inject({url:`/v1/channels/${dm.id}/calls`,headers:{authorization:`Bearer ${seed.owner_token}`}});assert.equal(history.statusCode,200);assert.equal(history.json().length,2);assert.equal('caller_device' in history.json()[0],false);assert.equal('callee_device' in history.json()[0],false);
});
