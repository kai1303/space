import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {io,type Socket} from 'socket.io-client';
import {AppError,type TypingEvent} from '@space/contracts';
import {ChatStore} from '@space/postgres/chat';
import {RedisSocketAdapter} from '@space/redis';
import {bootstrap} from '@space/postgres/bootstrap';
import {migrate} from '@space/postgres/migrate';
import {PostgresStore} from '@space/postgres/store';
import {createApi} from '@space/server/api';
const url=process.env.TEST_DATABASE_URL;
if(!url)throw new Error('TEST_DATABASE_URL is required');
const schema=`typing_${randomBytes(8).toString('hex')}`,admin=new Pool({connectionString:url});
const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:10});
const adapters=[new RedisSocketAdapter(process.env.TEST_REDIS_URL,schema),new RedisSocketAdapter(process.env.TEST_REDIS_URL,schema)];
const apps=adapters.map(adapter=>createApi(new PostgresStore(pool),{allowDevelopmentTokens:true,realtime:{adapter}}));
let addresses:string[];
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await Promise.all(adapters.map(a=>a.connect()));addresses=await Promise.all(apps.map(app=>app.listen({host:'127.0.0.1',port:0})));});
after(async()=>{await Promise.all(apps.map(app=>app.close()));await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
async function connect(token:string,channel:string,instance=0){
 const socket=io(addresses[instance]!,{transports:['websocket'],auth:{token},reconnection:false});
 socket.on('chat.events',(_value,ack)=>ack?.());
 await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});
 assert.ok((await socket.timeout(2000).emitWithAck('channel.subscribe',{channel_id:channel,after:'0'})).data);
 return socket;
}
const command=(socket:Socket,body:object)=>socket.timeout(2000).emitWithAck('typing.change',body);
function next(socket:Socket,predicate:(value:any)=>boolean, name='chat.typing'){return new Promise<any>((resolve,reject)=>{
 const timer=setTimeout(()=>{socket.off(name,receive);reject(new Error('Typing event not received'));},2500);
 const receive=(value:any)=>{if(predicate(value)){clearTimeout(timer);socket.off(name,receive);resolve(value);}};
 socket.on(name,receive);
});}
test('typing reaches other API instances with server identity, separate thread scope, and no persisted events',async()=>{
 const a=await bootstrap(pool),other=await bootstrap(pool);
 const sender=await connect(a.owner_token,a.channel_id),viewer=await connect(a.collaborator_token,a.channel_id,1),unrelated=await connect(other.owner_token,other.channel_id,1);
 const local:any[]=[],wrong:any[]=[];sender.on('chat.typing',v=>local.push(v));unrelated.on('chat.typing',v=>wrong.push(v));
 try{
  const before=(await pool.query('SELECT count(*) FROM channel_events')).rows[0].count;
  const incoming=next(viewer,v=>v.active);
  assert.ok((await command(sender,{channel_id:a.channel_id,active:true})).data);
  const event=await incoming;
  assert.equal(event.user.id,a.owner_id);assert.ok(event.user.name);assert.equal(event.thread_id,null);assert.equal(event.source_id,sender.id);
  assert.ok(event.expires_at>Date.now());assert.equal(event.text,undefined);
  const thread=next(viewer,v=>v.active&&v.thread_id===a.thread_id);
  assert.ok((await command(sender,{channel_id:a.channel_id,thread_id:a.thread_id,active:true})).data);await thread;
  const stopped=next(viewer,v=>!v.active&&v.thread_id===a.thread_id);
  await command(sender,{channel_id:a.channel_id,thread_id:a.thread_id,active:false});await stopped;
  await delay(50);assert.equal(local.length,0);assert.equal(wrong.length,0);
  assert.equal((await pool.query('SELECT count(*) FROM channel_events')).rows[0].count,before);
 }finally{sender.disconnect();viewer.disconnect();unrelated.disconnect();}
});
test('typing rejects spoofed users, foreign channels and foreign threads, and rechecks revoked recipients',async()=>{
 const a=await bootstrap(pool),other=await bootstrap(pool);
 const sender=await connect(a.owner_token,a.channel_id),viewer=await connect(a.collaborator_token,a.channel_id,1);
 const received:any[]=[];viewer.on('chat.typing',v=>received.push(v));
 try{
  assert.equal((await command(sender,{channel_id:a.channel_id,active:true,user:{id:other.owner_id,name:'Spoof'}})).error,'unknown_field');
  assert.equal((await command(sender,{channel_id:other.channel_id,active:true})).error,'not_found');
  assert.equal((await command(sender,{channel_id:a.channel_id,thread_id:other.thread_id,active:true})).error,'not_found');
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[a.channel_id,a.collaborator_id]);
  // A fresh window avoids the deliberate per-socket control rate limit.
  await delay(1050);
  assert.ok((await command(sender,{channel_id:a.channel_id,active:true})).data);
  await delay(150);assert.equal(received.length,0);
 }finally{sender.disconnect();viewer.disconnect();}
});
test('typing clears on send, channel departure and disconnect without stopping another tab',async()=>{
 const a=await bootstrap(pool);
 const sender=await connect(a.owner_token,a.channel_id),tab=await connect(a.owner_token,a.channel_id),viewer=await connect(a.collaborator_token,a.channel_id,1);
 try{
  const first=next(viewer,v=>v.active&&v.source_id===sender.id);await command(sender,{channel_id:a.channel_id,active:true});await first;
  const second=next(viewer,v=>v.active&&v.source_id===tab.id);await command(tab,{channel_id:a.channel_id,active:true});await second;
  const source=sender.id;const stopped=next(viewer,v=>!v.active&&v.source_id===source);sender.disconnect();await stopped;
  const sent=next(viewer,v=>!v.active&&v.source_id===tab.id);
  const {randomUUID}=await import('node:crypto');
  assert.ok((await tab.timeout(2000).emitWithAck('message.send',{channel_id:a.channel_id,client_message_id:randomUUID(),text:'Sent from the second tab'})).data);await sent;
  const again=next(viewer,v=>v.active&&v.source_id===tab.id);await command(tab,{channel_id:a.channel_id,active:true});await again;
  const left=next(viewer,v=>!v.active&&v.source_id===tab.id);await tab.timeout(2000).emitWithAck('channel.unsubscribe',{channel_id:a.channel_id});await left;
 }finally{sender.disconnect();tab.disconnect();viewer.disconnect();}
});

test('abandoned typing expires on a one-shot deadline and archived channels cannot start typing',async()=>{
 const a=await bootstrap(pool),sender=await connect(a.owner_token,a.channel_id),viewer=await connect(a.collaborator_token,a.channel_id,1);
 try{
  const active=next(viewer,v=>v.active);await command(sender,{channel_id:a.channel_id,active:true});const started=await active;
  const expired=new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{viewer.off('chat.typing',listener);reject(new Error('Typing never expired'));},7500);const listener=(v:any)=>{if(!v.active&&v.source_id===sender.id){clearTimeout(timer);viewer.off('chat.typing',listener);resolve(v);}};viewer.on('chat.typing',listener);});
  await expired;assert.ok(Date.now()>=started.expires_at-100);
  await pool.query('UPDATE channels SET archived_at=now() WHERE id=$1',[a.channel_id]);
  assert.equal((await command(sender,{channel_id:a.channel_id,active:true})).error,'channel_archived');
 }finally{sender.disconnect();viewer.disconnect();}
});

test('a replacement channel subscription survives an old typing check', {timeout:8000}, async t => {
 const a = await bootstrap(pool);
 const sender = await connect(a.owner_token, a.channel_id), viewer = await connect(a.collaborator_token, a.channel_id);
 let markEntered!: () => void, release!: () => void;
 const entered = new Promise<void>(resolve => { markEntered = resolve; });
 const released = new Promise<void>(resolve => { release = resolve; });
 const original = ChatStore.prototype.typingActor;
 let held = false;
 t.mock.method(ChatStore.prototype, 'typingActor', async function(this:ChatStore, ...args: Parameters<typeof original>) {
   if (args[0] === a.collaborator_id && !held) {
     held = true;
     markEntered();
     await released;
     throw new AppError(404, 'not_found');
   }
   return original.apply(this,args);
 });
 try {
   await command(sender, {channel_id:a.channel_id,active:true});
   await entered;
   assert.ok((await viewer.timeout(2000).emitWithAck('channel.subscribe',{channel_id:a.channel_id,after:'0'})).data);
   const delivered = next(viewer, event => !event.active);
   await command(sender, {channel_id:a.channel_id,active:false});
   release();
   await delivered;
 } finally { release(); viewer.disconnect(); sender.disconnect(); }
});

test('background DM typing reaches only the visible DM peer across servers and stops on disconnect', async () => {
 const a = await bootstrap(pool);
 const chat = new ChatStore(pool);
 const dm = await chat.directMessages.open(a.owner_id, a.workspace_id, {user_id:a.collaborator_id});
 const sender = await connect(a.owner_token, dm.id);
 const peer = await connect(a.collaborator_token, a.channel_id, 1);
 const eventName = 'workspace.dm-typing';
 const received: TypingEvent[] = [], own: TypingEvent[] = [];
 for (const socket of [sender, peer]) socket.on('workspace.unread', (_value, ack) => ack());
 peer.on(eventName, e => received.push(e));
 sender.on(eventName, e => own.push(e));
 try {
  for (const socket of [sender, peer]) assert.ok((await socket.timeout(2000).emitWithAck('workspace.subscribe',{workspace_id:a.workspace_id})).data);
  const start = () => command(sender, {channel_id:dm.id, active:true});
  await start();
  await delay(100);
  assert.equal(received.length, 0, 'a hidden DM stays private to the sidebar');
  await chat.directMessages.open(a.collaborator_id, a.workspace_id, {user_id:a.owner_id});
  const active = next(peer, e => e.active, eventName);
  await start();
  const started = await active;
  assert.equal(started.workspace_id, a.workspace_id);
  assert.equal(started.channel_id, dm.id);
  assert.equal(started.user.id, a.owner_id);
  const stop = next(peer, e => !e.active, eventName);
  await command(sender, {channel_id:dm.id, active:false});
  await stop;
  await delay(1050);
  const again = next(peer, e => e.active, eventName);
  await start(); await again;
  const left = next(peer, e => !e.active, eventName);
  sender.disconnect(); await left;
  assert.equal(own.length, 0);
  await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2', [a.workspace_id, a.collaborator_id]);
  assert.equal((await chat.directMessages.visibleTypingChannels(a.collaborator_id, a.workspace_id, [dm.id])).size, 0);
 } finally { sender.disconnect(); peer.disconnect(); }
});
