import type {ChatEvent,ChatMessage} from '@space/contracts';
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {io} from 'socket.io-client';
import {bootstrap} from '@space/postgres/bootstrap';
import {migrate} from '@space/postgres/migrate';
import {PostgresStore} from '@space/postgres/store';
import {createApi} from '@space/server/api';
import {EventBridge} from '@space/event-service/bridge';

const url=process.env.TEST_DATABASE_URL;
if (!url) throw Error('TEST_DATABASE_URL required');
const schema='thread_broadcast_'+randomBytes(5).toString('hex');
const admin=new Pool({connectionString:url}),pool=new Pool({connectionString:url,options:'-c search_path='+schema});
const app=createApi(new PostgresStore(pool),{allowDevelopmentTokens:true});
const second=createApi(new PostgresStore(pool),{allowDevelopmentTokens:true});
const bridge=new EventBridge({databaseUrl:url,natsUrl:process.env.NATS_URL??process.env.TEST_NATS_URL??'nats://127.0.0.1:54222',schema});
let address:string,secondAddress:string;
before(async()=>{
  await admin.query('CREATE SCHEMA '+schema); await migrate(pool); await bridge.start();
  [address,secondAddress]=await Promise.all([app,second].map(server=>server.listen({host:'127.0.0.1',port:0}))) as [string,string];
});
after(async()=>{
  await Promise.all([app.close(),second.close()]);await bridge.close();await pool.end();
  for(let attempt=0; ;attempt++) {
    try {await admin.query('SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name=$1',[bridge.slot]);break;}
    catch(error){if ((error as {code?:string}).code !== '55006' || attempt>=6) throw error;await delay(50*2**attempt);}
  }
  await admin.query(`DROP PUBLICATION IF EXISTS "${bridge.publication}"`);
  await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();
});
async function api(token:string,method:'POST'|'PUT'|'GET'|'PATCH'|'DELETE',path:string,body?:object,status=200){
  const response=await app.inject({method,url:'/v1'+path,headers:{authorization:'Bearer '+token},payload:body});
  assert.equal(response.statusCode,status,path+' '+response.body);return response.json();
}
async function socket(token: string, base = address) {
  const ws = io(base, { transports: ['websocket'], auth: { token }, reconnection: false, autoConnect: false });
  ws.on('chat.events', (_frame, ack:()=>void) => ack());
  const connected = new Promise<void>((resolve, reject) => { ws.once('connect', resolve); ws.once('connect_error', reject); });
  ws.connect(); await connected;
  return ws;
}
function nextMessage(ws: Awaited<ReturnType<typeof socket>>, predicate:(e:ChatEvent & {type:'message.created'|'message.updated'})=>boolean) {
  return new Promise<ChatMessage>((resolve,reject)=>{
    const listen = ({events}:{events:ChatEvent[]}) => {
      for (const event of events) if (event.type !== 'task.event' && predicate(event)) {
        clearTimeout(timer); ws.off('chat.events',listen); resolve(event.payload); return;
      }
    };
    const timer=setTimeout(()=>{ws.off('chat.events',listen);reject(new Error('No matching channel event'));},5000);
    ws.on('chat.events',listen);
  });
}

test('two clients see one shared reply, with separate channel and thread positions after promotion', async () => {
  const a = await bootstrap(pool);
  const base = '/channels/'+a.channel_id;
  const root = await api(a.owner_token,'POST',base+'/messages',{client_message_id:randomUUID(),text:'Thread root'},201);
  const sender = await socket(a.owner_token), reader = await socket(a.collaborator_token,secondAddress);
  try {
    await pool.query(`INSERT INTO mention_preferences(user_id,mode) VALUES($1,'all') ON CONFLICT(user_id) DO UPDATE SET mode='all'`,[a.collaborator_id]);
    assert.ok((await reader.timeout(3000).emitWithAck('channel.subscribe',{channel_id:a.channel_id,after:root.sequence})).data);
    const file = randomUUID();
    await pool.query(`INSERT INTO assets(id,workspace_id,channel_id,uploader_id,name,size,type,staging_key,object_key,status)
      VALUES($1::uuid,$2,$3,$4,'plan.txt',1,'text/plain',$1::uuid::text,$1::uuid::text,'ready')`,[file,a.workspace_id,a.channel_id,a.owner_id]);
    const input = {asset_ids:[file],channel_id:a.channel_id,thread_id:root.thread_id,client_message_id:randomUUID(),text:'Immediate',also_send_to_channel:true};
    const next = nextMessage(reader, e=>e.payload.client_message_id===input.client_message_id);
    const immediate = (await sender.timeout(3000).emitWithAck('message.send',input)).data;
    assert.equal(immediate.channel_broadcast_sequence,immediate.sequence);
    const received=await next;
    assert.equal(received.channel_broadcast_sequence,immediate.sequence);
    assert.deepEqual(received.attachments?.map(f=>f.id),[file]);
    assert.deepEqual((await pool.query('SELECT message_id FROM assets WHERE id=$1',[file])).rows,[{message_id:immediate.id}]);
    assert.equal((await sender.timeout(3000).emitWithAck('message.send',input)).data.id,immediate.id);
    assert.equal((await sender.timeout(3000).emitWithAck('message.send',{...input,also_send_to_channel:false})).error,'idempotency_conflict');
    const msg = (text:string,thread?:string) => api(a.owner_token,'POST',base+'/messages',{client_message_id:randomUUID(),text,...(thread?{thread_id:thread}:{})},201);
    const reply = await msg('Later',root.thread_id), last = await msg('Intervening post');
    const timeline = () => api(a.collaborator_token,'GET',base+'/messages');
    assert.deepEqual((await timeline()).messages.map((m:any)=>m.id),[root.id,immediate.id,last.id]);
    await api(a.collaborator_token,'POST',base+'/read',{sequence:last.sequence});
    const path = base+'/messages/'+reply.id+'/broadcast';
    await api(a.collaborator_token,'PUT',path,{},404);
    const promotion = nextMessage(reader,e=>e.type==='message.updated' && e.payload.id===reply.id);
    const results = await Promise.all([api(a.owner_token,'PUT',path,{}),api(a.owner_token,'PUT',path,{})]);
    const promoted = results[0];
    assert.equal(promoted.channel_broadcast_sequence,results[1].channel_broadcast_sequence);
    assert.equal(promoted.sequence,reply.sequence);
    assert.ok(BigInt(promoted.channel_broadcast_sequence)>BigInt(last.sequence));
    assert.equal((await promotion).channel_broadcast_sequence,promoted.channel_broadcast_sequence);
    const visible = await timeline();
    assert.deepEqual(visible.messages.map((m:any)=>m.id),[root.id,immediate.id,last.id,reply.id]);
    assert.equal(visible.newer_cursor,promoted.channel_broadcast_sequence);
    assert.deepEqual((await api(a.collaborator_token,'GET',base+'/messages?after='+last.sequence)).messages.map((m:any)=>m.id),[reply.id]);
    const replies = await api(a.collaborator_token,'GET','/threads/'+root.thread_id+'/history');
    assert.deepEqual(replies.messages.map((m:any)=>m.id),[root.id,immediate.id,reply.id]);
    assert.equal(replies.messages.at(-1).sequence,reply.sequence);
    const unread = () => api(a.collaborator_token,'GET','/workspaces/'+a.workspace_id+'/unread');
    assert.equal((await unread()).channels[0].unread_count,1);
    await api(a.collaborator_token,'POST',base+'/read',{sequence:promoted.channel_broadcast_sequence});
    assert.equal((await unread()).channels[0].unread_count,0);
    assert.equal((await pool.query("SELECT id FROM notifications WHERE message_id=$1 AND user_id=$2 AND kind<>'reaction'",[reply.id,a.collaborator_id])).rowCount,1);
    assert.equal((await pool.query("SELECT 1 FROM channel_events WHERE channel_id=$1 AND thread_id=$2 AND type='message.created' AND payload->>'id'=$3",[a.channel_id,root.thread_id,reply.id])).rowCount,1);
    await api(a.owner_token,'PUT',base+'/messages/'+root.id+'/broadcast',{},404);
  } finally {sender.disconnect();reader.disconnect();}
});

test('promotion and scheduled delivery require posting access and reject ciphertext-only rooms', async () => {
  const a=await bootstrap(pool), base='/channels/'+a.channel_id;
  const owner=a.owner_token,member=a.collaborator_token;
  const root=await api(owner,'POST',base+'/messages',{client_message_id:randomUUID(),text:'Root'},201);
  const payload=(extra={})=>({client_message_id:randomUUID(),text:'Reply',thread_id:root.thread_id,...extra});
  const plain=await api(member,'POST',base+'/messages',payload(),201);
  const soon=new Date(Date.now()+100000).toISOString();
  const schedule=await api(member,'POST',base+'/scheduled-messages',{id:randomUUID(),thread_id:root.thread_id,text:'Scheduled',send_at:soon,also_send_to_channel:true},201);
  assert.equal(schedule.also_send_to_channel,true);
  const perms=await api(owner,'GET',base+'/permissions');
  await api(owner,'PATCH',base+'/permissions',{revision:perms.revision,posting:'admins',allow_replies:true});
  await api(member,'PUT',base+'/messages/'+plain.id+'/broadcast',{},403);
  await api(member,'POST',base+'/messages',payload({also_send_to_channel:true}),403);
  await api(member,'POST',base+'/scheduled-messages',{id:randomUUID(),thread_id:root.thread_id,text:'Scheduled',send_at:soon,also_send_to_channel:true},403);
  await api(member,'POST',base+'/messages',payload(),201);
  await api(owner,'POST',base+'/messages',{client_message_id:randomUUID(),text:'Invalid',also_send_to_channel:true},400);

  const { ScheduledMessageStore }=await import('@space/postgres/scheduled-messages');
  const { ChatStore }=await import('@space/postgres/chat');
  const store=new ScheduledMessageStore(pool,new ChatStore(pool));
  const due=async(id:string)=>{
    const {rows}=await pool.query("UPDATE scheduled_messages SET send_at=now()-interval '1 minute' WHERE id=$1 RETURNING version",[id]);
    await store.deliver(id,rows[0].version);
    return (await pool.query('SELECT status,message_id FROM scheduled_messages WHERE id=$1',[id])).rows[0];
  };
  assert.equal((await due(schedule.id)).status,'failed');
  const privileged=await api(owner,'POST',base+'/scheduled-messages',{id:randomUUID(),thread_id:root.thread_id,text:'Scheduled',send_at:soon,also_send_to_channel:true},201);
  const delivered=await due(privileged.id);
  assert.equal(delivered.status,'sent');
  const posted=await api(owner,'GET',base+'/messages/'+delivered.message_id);
  assert.equal(posted.channel_broadcast_sequence,posted.sequence);

  const dm=await api(owner,'POST','/workspaces/'+a.workspace_id+'/direct-messages',{user_id:a.collaborator_id});
  const room='/channels/'+dm.id;
  const dr=await api(owner,'POST',room+'/messages',{text:'DM',client_message_id:randomUUID()},201);
  const reply=await api(member,'POST',room+'/messages',{text:'DM reply',client_message_id:randomUUID(),thread_id:dr.thread_id},201);
  assert.equal((await api(member,'PUT',room+'/messages/'+reply.id+'/broadcast',{})).id,reply.id);
  await pool.query('UPDATE channels SET encrypted_since=now() WHERE id=$1',[dm.id]);
  await api(member,'PUT',room+'/messages/'+reply.id+'/broadcast',{},409);
  await api(member,'POST',room+'/messages',{client_message_id:randomUUID(),thread_id:dr.thread_id,text:'Encrypted room',also_send_to_channel:true},409);
});
