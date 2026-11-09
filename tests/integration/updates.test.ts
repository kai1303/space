import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { io } from 'socket.io-client';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { ChatStore } from '@space/postgres/chat';
import { createApi } from '@space/server/api';
import { RedisSocketAdapter } from '@space/redis';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const schema = `updates_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
const adapter = new RedisSocketAdapter(process.env.TEST_REDIS_URL,schema);
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, realtime: { adapter, } });
let address: string;
before(async () => { await adapter.connect(); await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); address = await app.listen({ host: '127.0.0.1', port: 0 }); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
async function connect(token: string, base=address) {
 const socket = io(base, { transports: ['websocket'], auth: { token }, reconnection: false });
 await new Promise<void>((resolve,reject) => { socket.once('connect',resolve); socket.once('connect_error',reject); });
 return socket;
}
async function until(check: () => boolean, message: string) {
 const deadline=Date.now()+2000;
 while (!check()) { assert.ok(Date.now()<deadline,message); await delay(10); }
}

test('resource subscriptions authorize scopes, change after commit, and stay quiet while idle', async () => {
 const a=await bootstrap(pool), outsider=await bootstrap(pool), socket=await connect(a.owner_token);
 const changed: unknown[]=[];
 socket.on('updates.changed', (value, ack) => { changed.push(value); ack?.(); });
 try {
  assert.deepEqual(await socket.timeout(500).emitWithAck('updates.subscribe',{scope:'channel',id:outsider.channel_id}),{error:'not_found'});
  assert.deepEqual(await socket.timeout(500).emitWithAck('updates.subscribe',{scope:'channel',id:a.channel_id}),{data:{scope:'channel',id:a.channel_id}});
  await until(()=>changed.length>0,'initial update must follow subscription acknowledgement');
  changed.length=0; await delay(180); assert.equal(changed.length,0,'idle reconciliation must not trigger HTTP refreshes');
  const tx=await pool.connect();
  try {
   await tx.query('BEGIN'); await tx.query('UPDATE channels SET topic=$1 WHERE id=$2',['Updated after commit',a.channel_id]);
   await delay(100); assert.equal(changed.length,0,'uncommitted writes must remain invisible');
   await tx.query('COMMIT');
  } finally { tx.release(); }
  await until(()=>changed.length>0,'channel metadata changes must wake subscribers');
  assert.deepEqual(changed.at(-1),{scope:'channel',id:a.channel_id});
  changed.length=0; await delay(150); assert.equal(changed.length,0);
 } finally { socket.disconnect(); }
});

test('WAL delivery survives deleted legacy hints and revokes a lost membership', async () => {
 const a=await bootstrap(pool), socket=await connect(a.collaborator_token);
 const changed: unknown[]=[], revoked: unknown[]=[];
 socket.on('updates.changed', (value,ack)=>{changed.push(value);ack?.();}); socket.on('updates.revoked',value=>revoked.push(value));
 socket.on('updates.changed',(_value,ack)=>ack());
 try {
  await socket.timeout(500).emitWithAck('updates.subscribe',{scope:'thread',id:a.thread_id});
  await until(()=>changed.length>0,'initial thread invalidation'); changed.length=0;
  const tx=await pool.connect();
  try { await tx.query('BEGIN'); await tx.query('UPDATE channels SET description=$1 WHERE id=$2',['Missed Redis hint',a.channel_id]); await tx.query('DELETE FROM chat_delivery_outbox'); await tx.query('COMMIT'); } finally { tx.release(); }
  await until(()=>changed.length>0,'retained revision must repair a missed hint');
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[a.channel_id,a.collaborator_id]);
  await until(()=>revoked.length>0,'removed members must receive revocation');
  assert.deepEqual(revoked[0],{scope:'thread',id:a.thread_id,error:'not_found'});
 } finally { socket.disconnect(); }
});

test('UI triggers omit channel sequence and agent heartbeat-only writes', async () => {
 const a=await bootstrap(pool);
 const tx=await pool.connect();
 try {
  // Inspect trigger output before commit, while the delivery bridge cannot drain it.
  await tx.query('BEGIN');
  await tx.query('DELETE FROM chat_delivery_outbox');
  await tx.query('UPDATE channels SET event_sequence=event_sequence+1 WHERE id=$1',[a.channel_id]);
  assert.equal((await tx.query('SELECT count(*) FROM chat_delivery_outbox')).rows[0].count,'0');
  await tx.query('UPDATE users SET display_name=$1 WHERE id=$2',['Changed profile',a.owner_id]);
  assert.notEqual((await tx.query('SELECT count(*) FROM chat_delivery_outbox')).rows[0].count,'0','profiles must enqueue UI updates');
 } finally { await tx.query('ROLLBACK');tx.release(); }
});

test('workspace updates and connector wake hints cross API instances through durable events', async () => {
 const { RedisSocketAdapter }=await import('@space/redis');
 const { AgentConnectionStore }=await import('@space/postgres/agent-connections');
 const oneAdapter=new RedisSocketAdapter(process.env.TEST_REDIS_URL,schema), twoAdapter=new RedisSocketAdapter(process.env.TEST_REDIS_URL,schema);
 await Promise.all([oneAdapter.connect(),twoAdapter.connect()]);
 // The remote server cannot rely on its reconciliation or outbox timer to discover work.
 const one=createApi(new PostgresStore(pool),{allowDevelopmentTokens:true,realtime:{adapter:oneAdapter,}});
 const two=createApi(new PostgresStore(pool),{allowDevelopmentTokens:true,realtime:{adapter:twoAdapter,}});
 await one.listen({host:'127.0.0.1',port:0}); const secondAddress=await two.listen({host:'127.0.0.1',port:0});
 const a=await bootstrap(pool), connections=new AgentConnectionStore(pool), tasks=new PostgresStore(pool);
 const pairing=await connections.createPairing(a.owner_id,a.workspace_id,{}), credential=randomBytes(32).toString('base64url');
 const agent=await connections.claim({code:pairing.code,credential});
 await connections.setChannelEnabled(a.owner_id,agent.installation_id,a.channel_id,true);
 const browser=io(secondAddress,{transports:['websocket'],auth:{token:a.owner_token},reconnection:false});
 const connector=io(`${secondAddress}/agents`,{transports:['websocket'],auth:{token:credential},reconnection:false});
 try {
  await Promise.all([browser,connector].map(socket=>new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);})));
  await connector.timeout(1000).emitWithAck('agent.heartbeat',{auth_status:'ready'});
  let available=0, changes=0;
  connector.on('agent.tasks.available',()=>{available++;}); browser.on('updates.changed',(_value,ack)=>{changes++;ack?.();});
  await browser.timeout(1000).emitWithAck('updates.subscribe',{scope:'workspace',id:a.workspace_id});
  await until(()=>changes>0,'initial workspace invalidation'); changes=0;
  await pool.query('UPDATE users SET title=$1 WHERE id=$2',['Remote title',a.owner_id]);
  await until(()=>changes>0,'remote outbox hints must wake workspace subscribers');
  const task=await tasks.createTask(a.owner_id,{workspace_id:a.workspace_id,thread_id:a.thread_id,installation_id:agent.installation_id,skill:'codex.run',goal:'Cross instance wake'},randomBytes(16).toString('hex'));
  await tasks.approveTask(a.owner_id,task.id);
  await until(()=>available>0,'remote outbox hints must wake queued connectors');
  assert.equal((await connector.timeout(1000).emitWithAck('agent.task.claim',{})).data.task_id,task.id);
 } finally { browser.disconnect(); connector.disconnect(); await one.close(); await two.close(); }
});

test('authentication revocation emits a global unauthorized error and closes the socket', async () => {
 const a=await bootstrap(pool), socket=await connect(a.owner_token), revoked: unknown[]=[], errors: unknown[]=[];
 socket.on('updates.revoked',value=>revoked.push(value)); socket.on('chat.error',value=>errors.push(value));
 socket.on('updates.changed',(_value,ack)=>ack());
 try {
  await socket.timeout(500).emitWithAck('updates.subscribe',{scope:'workspace',id:a.workspace_id});
  await pool.query('DELETE FROM human_credentials WHERE user_id=$1',[a.owner_id]);
  await until(()=>!socket.connected,'invalidated credentials must disconnect');
  assert.deepEqual(errors,[{error:'unauthorized'}]);
  assert.deepEqual(revoked,[],'global authentication loss must not mark a resource permanently revoked');
 } finally { socket.disconnect(); }
});


test('task progress refreshes its task scope without refetching workspace, channel or thread resources', async () => {
 const a=await bootstrap(pool), tasks=new PostgresStore(pool);
 const task=await tasks.createTask(a.owner_id,{workspace_id:a.workspace_id,thread_id:a.thread_id,installation_id:a.installation_id,skill:'demo.echo',goal:'Scoped progress'},randomUUID());
 const scopes=[{scope:'workspace',id:a.workspace_id},{scope:'channel',id:a.channel_id},{scope:'thread',id:a.thread_id},{scope:'task',id:task.id}];
 const sockets=await Promise.all(scopes.map(()=>connect(a.owner_token)));
 const counts=[0,0,0,0];
 try {
  await Promise.all(sockets.map(async(socket,index)=>{
   socket.on('updates.changed',(_value,ack)=>{counts[index]=(counts[index]??0)+1;ack?.();});
   assert.ok((await socket.timeout(500).emitWithAck('updates.subscribe',scopes[index])).data);
  }));
  await until(()=>counts.every(count=>count>0),'initial scope revisions'); counts.fill(0);
  await pool.query("SELECT append_chat_event($1,$2,'task.event',$3::jsonb)",[a.channel_id,a.thread_id,JSON.stringify({task_id:task.id,type:'execution.progress',data:{text:'Streaming'}})]);
  await until(()=>counts[3]!>0,'task progress must wake the task detail');
  await delay(180); assert.deepEqual(counts.slice(0,3),[0,0,0],'stream chunks must not refetch metadata');
 } finally { sockets.forEach(socket=>socket.disconnect()); }
});


test('a lost invalidation ACK disconnects for replay without permanently revoking access', {timeout:9000}, async () => {
 const a=await bootstrap(pool), socket=await connect(a.owner_token), revoked: unknown[]=[];
 socket.on('updates.changed',()=>{}); socket.on('updates.revoked',value=>revoked.push(value));
 try {
  await socket.timeout(500).emitWithAck('updates.subscribe',{scope:'channel',id:a.channel_id});
  const deadline=Date.now()+6500;
  while (socket.connected && Date.now()<deadline) await delay(20);
  assert.equal(socket.connected,false,'unacknowledged updates must disconnect instead of consuming the revision');
  assert.deepEqual(revoked,[],'a lost ACK does not revoke resource access');
  const replacement=await connect(a.owner_token); let changes=0;
  try {
   replacement.on('updates.changed',(_value,ack)=>{changes++;ack();});
   assert.ok((await replacement.timeout(500).emitWithAck('updates.subscribe',{scope:'channel',id:a.channel_id})).data);
   await until(()=>changes>0,'replacement socket must replay an initial invalidation');
  } finally { replacement.disconnect(); }
 } finally { socket.disconnect(); }
});


test('one socket retains multiple resources and unsubscribes only the matching resource', async () => {
 const a=await bootstrap(pool), socket=await connect(a.owner_token), changed: {scope:string;id:string}[]=[];
 socket.on('updates.changed',(value,ack)=>{changed.push(value);ack();});
 try {
  for (const value of [{scope:'workspace',id:a.workspace_id},{scope:'channel',id:a.channel_id},{scope:'thread',id:a.thread_id}]) {
   assert.deepEqual(await socket.timeout(500).emitWithAck('updates.subscribe',value),{data:value});
  }
  await until(()=>changed.length===3,'all resources must receive their initial invalidation');
  changed.length=0;
  await socket.timeout(500).emitWithAck('updates.subscribe',{scope:'channel',id:a.channel_id});
  await delay(120); assert.equal(changed.length,0,'duplicate subscribe must preserve the acknowledged revision');
  assert.deepEqual(await socket.timeout(500).emitWithAck('updates.unsubscribe',{scope:'channel',id:a.channel_id}),{data:{scope:'channel',id:a.channel_id}});
  await pool.query('UPDATE channels SET topic=$1 WHERE id=$2',['Shared socket',a.channel_id]);
  await until(()=>changed.length===2,'remaining workspace and thread resources must update');
  assert.deepEqual(new Set(changed.map(value=>value.scope)),new Set(['workspace','thread']));
  assert.equal(socket.connected,true);
 } finally { socket.disconnect(); }
});

test('resource and channel authorization loss leave workspace streams connected', async () => {
 const a=await bootstrap(pool), socket=await connect(a.collaborator_token), revoked: unknown[]=[], channelRevoked: unknown[]=[], unread: unknown[]=[];
 socket.on('updates.changed',(_value,ack)=>ack()); socket.on('chat.events',(_value,ack)=>ack());
 socket.on('updates.revoked',value=>revoked.push(value)); socket.on('channel.revoked',value=>channelRevoked.push(value));
 socket.on('workspace.unread',(value,ack)=>{unread.push(value);ack();});
 try {
  await socket.timeout(500).emitWithAck('updates.subscribe',{scope:'thread',id:a.thread_id});
  await socket.timeout(500).emitWithAck('updates.subscribe',{scope:'workspace',id:a.workspace_id});
  await socket.timeout(500).emitWithAck('workspace.subscribe',{workspace_id:a.workspace_id});
  await socket.timeout(500).emitWithAck('channel.subscribe',{channel_id:a.channel_id,after:'0'});
  await until(()=>unread.length>0,'initial unread stream');
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[a.channel_id,a.collaborator_id]);
  await until(()=>revoked.length>0 && channelRevoked.length>0,'only inaccessible streams must be revoked');
  assert.deepEqual(revoked,[{scope:'thread',id:a.thread_id,error:'not_found'}]);
  assert.deepEqual(channelRevoked,[{channel_id:a.channel_id,error:'not_found'}]);
  assert.equal(socket.connected,true);
  await delay(150); assert.equal(revoked.length,1,'revoked resources must be removed');
 } finally { socket.disconnect(); }
});

test('a slow resource ACK does not block other resources, chat, or workspace unread', async () => {
 const a=await bootstrap(pool), socket=await connect(a.owner_token), seen=new Set<string>();
 socket.on('updates.changed',(value,ack)=>{seen.add(value.scope);if(value.scope!=='thread') ack();});
 socket.on('workspace.unread',(_value,ack)=>{seen.add('unread');ack();});
 socket.on('chat.events',(_value,ack)=>{seen.add('chat');ack();});
 try {
  await new ChatStore(pool).send(a.owner_id,a.channel_id,{client_message_id:randomUUID(),text:'Independent delivery'});
  await socket.timeout(500).emitWithAck('updates.subscribe',{scope:'thread',id:a.thread_id});
  await until(()=>seen.has('thread'),'slow stream must start first');
  await socket.timeout(500).emitWithAck('updates.subscribe',{scope:'workspace',id:a.workspace_id});
  await socket.timeout(500).emitWithAck('workspace.subscribe',{workspace_id:a.workspace_id});
  await socket.timeout(500).emitWithAck('channel.subscribe',{channel_id:a.channel_id,after:'0'});
  await until(()=>['workspace','unread','chat'].every(value=>seen.has(value)),'unrelated streams must not wait for the slow ACK');
 } finally { socket.disconnect(); }
});

test('channel and workspace unsubscribe ignore nonmatching ids and stop matching streams', async () => {
 const a=await bootstrap(pool), socket=await connect(a.owner_token), seen: string[]=[];
 socket.on('workspace.unread',(_value,ack)=>{seen.push('unread');ack();});
 socket.on('chat.events',(_value,ack)=>{seen.push('chat');ack();});
 try {
  await socket.timeout(500).emitWithAck('workspace.subscribe',{workspace_id:a.workspace_id});
  await socket.timeout(500).emitWithAck('channel.subscribe',{channel_id:a.channel_id,after:'0'});
  await until(()=>seen.includes('unread'),'initial unread'); seen.length=0;
  await socket.timeout(500).emitWithAck('workspace.unsubscribe',{workspace_id:randomUUID()});
  await socket.timeout(500).emitWithAck('channel.unsubscribe',{channel_id:randomUUID()});
  await new ChatStore(pool).send(a.owner_id,a.channel_id,{client_message_id:randomUUID(),text:'Still subscribed'});
  await until(()=>seen.includes('chat') && seen.includes('unread'),'nonmatching unsubscribe must preserve streams');
  await socket.timeout(500).emitWithAck('workspace.unsubscribe',{workspace_id:a.workspace_id});
  await socket.timeout(500).emitWithAck('channel.unsubscribe',{channel_id:a.channel_id});
  seen.length=0;
  await new ChatStore(pool).send(a.owner_id,a.channel_id,{client_message_id:randomUUID(),text:'Unsubscribed'});
  await delay(180); assert.deepEqual(seen,[]);
 } finally { socket.disconnect(); }
});

test('resource subscription cap is bounded, duplicates do not consume slots, and unsubscribe frees a slot', async () => {
 const a=await bootstrap(pool), socket=await connect(a.owner_token), ids=Array.from({length:65},()=>randomUUID());
 socket.on('updates.changed',(_value,ack)=>ack());
 await pool.query('INSERT INTO threads(id,workspace_id,channel_id) SELECT unnest($1::uuid[]),$2,$3',[ids,a.workspace_id,a.channel_id]);
 try {
  for (const id of ids.slice(0,64)) {
   assert.deepEqual(await socket.timeout(1000).emitWithAck('updates.subscribe',{scope:'thread',id}),{data:{scope:'thread',id}});
  }
  assert.ok((await socket.timeout(1000).emitWithAck('updates.subscribe',{scope:'thread',id:ids[0]})).data,'duplicate must work at cap');
  assert.deepEqual(await socket.timeout(1000).emitWithAck('updates.subscribe',{scope:'thread',id:ids[64]}),{error:'subscription_limit'});
  await socket.timeout(1000).emitWithAck('updates.unsubscribe',{scope:'thread',id:ids[0]});
  assert.ok((await socket.timeout(1000).emitWithAck('updates.subscribe',{scope:'thread',id:ids[64]})).data,'unsubscribe must free a slot');
 } finally { socket.disconnect(); }
});


test('workspace revocation removes only that workspace while other workspace streams stay live', async () => {
 const a=await bootstrap(pool), b=await bootstrap(pool), socket=await connect(a.owner_token), revoked: unknown[]=[], workspaceRevoked: unknown[]=[], changes: unknown[]=[];
 await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[b.workspace_id,a.owner_id]);
 socket.on('updates.changed',(value,ack)=>{changes.push(value);ack();}); socket.on('chat.events',(_value,ack)=>ack());
 socket.on('workspace.unread',(_value,ack)=>ack()); socket.on('updates.revoked',value=>revoked.push(value)); socket.on('workspace.revoked',value=>workspaceRevoked.push(value));
 try {
  await socket.timeout(500).emitWithAck('updates.subscribe',{scope:'workspace',id:b.workspace_id});
  await socket.timeout(500).emitWithAck('updates.subscribe',{scope:'channel',id:a.channel_id});
  await socket.timeout(500).emitWithAck('workspace.subscribe',{workspace_id:b.workspace_id});
  await socket.timeout(500).emitWithAck('channel.subscribe',{channel_id:a.channel_id,after:'0'});
  await until(()=>changes.length===2,'initial independent resources'); changes.length=0;
  await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[b.workspace_id,a.owner_id]);
  await until(()=>revoked.length>0 && workspaceRevoked.length>0,'workspace membership loss must be scoped');
  assert.deepEqual(revoked,[{scope:'workspace',id:b.workspace_id,error:'not_found'}]);
  assert.deepEqual(workspaceRevoked,[{workspace_id:b.workspace_id,error:'not_found'}]);
  await pool.query('UPDATE channels SET topic=$1 WHERE id=$2',['Still accessible',a.channel_id]);
  await until(()=>changes.length>0,'other workspace channel must remain subscribed');
  assert.equal(socket.connected,true);
 } finally { socket.disconnect(); }
});

test('late ACK failures from removed subscriptions cannot disconnect their replacements', {timeout:9000}, async () => {
 const a=await bootstrap(pool), socket=await connect(a.owner_token), counts=new Map<string,number>(), revoked: unknown[]=[];
 for (const event of ['updates.changed','workspace.unread','chat.events']) socket.on(event,(_value,ack)=>{
  const count=(counts.get(event)??0)+1; counts.set(event,count); if(count>1) ack();
 });
 for (const event of ['updates.revoked','workspace.revoked','channel.revoked']) socket.on(event,value=>revoked.push(value));
 const subscribe=async()=>{
  await socket.timeout(500).emitWithAck('updates.subscribe',{scope:'channel',id:a.channel_id});
  await socket.timeout(500).emitWithAck('workspace.subscribe',{workspace_id:a.workspace_id});
  await socket.timeout(500).emitWithAck('channel.subscribe',{channel_id:a.channel_id,after:'0'});
 };
 try {
  await new ChatStore(pool).send(a.owner_id,a.channel_id,{client_message_id:randomUUID(),text:'Replace while awaiting ACK'});
  await subscribe();
  await until(()=>counts.size===3,'all original streams must be awaiting ACK');
  await socket.timeout(500).emitWithAck('updates.unsubscribe',{scope:'channel',id:a.channel_id});
  await socket.timeout(500).emitWithAck('workspace.unsubscribe',{workspace_id:a.workspace_id});
  await socket.timeout(500).emitWithAck('channel.unsubscribe',{channel_id:a.channel_id});
  await subscribe();
  await until(()=>[...counts.values()].every(count=>count>=2),'replacement streams must deliver independently');
  await delay(5200);
  assert.equal(socket.connected,true,'stale ACK timeouts must not disconnect current streams');
  assert.deepEqual(revoked,[]);
 } finally { socket.disconnect(); }
});


test('a transient live authentication failure disconnects without scope revocation and permits replay', async () => {
 const a=await bootstrap(pool), store=new PostgresStore(pool), authenticate=store.authenticate.bind(store);
 let unavailable=false;
 store.authenticate=async token=>{if(unavailable) throw new Error('database timeout');return authenticate(token);};
 const temporary=createApi(store,{allowDevelopmentTokens:true,realtime:{}});
 const base=await temporary.listen({host:'127.0.0.1',port:0}), socket=await connect(a.owner_token,base), revoked: unknown[]=[], errors: unknown[]=[];
 socket.on('updates.changed',(_value,ack)=>ack());socket.on('updates.revoked',value=>revoked.push(value));socket.on('chat.error',value=>errors.push(value));
 try {
  await socket.timeout(500).emitWithAck('updates.subscribe',{scope:'channel',id:a.channel_id});
  unavailable=true;
  await pool.query("UPDATE channels SET topic='Recheck subscribed metadata' WHERE id=$1",[a.channel_id]);
  await until(()=>!socket.connected,'transient live authentication failures must disconnect for retry');
  assert.deepEqual(errors,[{error:'internal_error'}]);assert.deepEqual(revoked,[]);
  unavailable=false;
  const replacement=await connect(a.owner_token,base), scopes=new Set<string>();
  replacement.on('updates.changed',(value,ack)=>{scopes.add(value.scope);ack();});
  try {
   await replacement.timeout(500).emitWithAck('updates.subscribe',{scope:'workspace',id:a.workspace_id});
   await replacement.timeout(500).emitWithAck('updates.subscribe',{scope:'channel',id:a.channel_id});
   await until(()=>scopes.size===2,'reconnected socket must replay all restored resources');
  } finally { replacement.disconnect(); }
 } finally {socket.disconnect();await temporary.close();}
});

test('idle resource subscribers do not periodically query revision state', async () => {
 const a=await bootstrap(pool), socket=await connect(a.owner_token);
 let accepted!:()=>void;
 const first=new Promise<void>(resolve=>{accepted=resolve;});
 socket.on('updates.changed',(_value,ack)=>{ack();accepted();});
 const original=pool.query;
 try {
  await socket.timeout(1000).emitWithAck('updates.subscribe',{scope:'channel',id:a.channel_id});
  await first;await delay(120);
  let reads=0;
  pool.query=(function(...args:any[]){if(String(args[0]).includes('resource_update_revisions'))reads++;return (original as any).apply(pool,args);}) as typeof pool.query;
  await delay(220);
  assert.equal(reads,0,'idle streams must wait for committed events instead of reconciliation timers');
 } finally {pool.query=original;socket.disconnect();}
});

test('broker reconnect restores ephemeral realtime delivery before catch-up and future updates', {timeout:30000}, async()=>{
 const {createServer,connect:connectNet}=await import('node:net');
 const upstream=new URL(process.env.TEST_NATS_URL ?? 'nats://127.0.0.1:54222');
 let offline=false;
 const connections=new Set<import('node:net').Socket>();
 const proxy=createServer(socket=>{
  if(offline){socket.destroy();return;}
  const remote=connectNet(Number(upstream.port),upstream.hostname);
  connections.add(socket);connections.add(remote);socket.pipe(remote);remote.pipe(socket);
  socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());
  socket.on('close',()=>{connections.delete(socket);remote.destroy();});remote.on('close',()=>{connections.delete(remote);socket.destroy();});
 });
 await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const port=(proxy.address() as {port:number}).port;
 const temporary=createApi(new PostgresStore(pool),{allowDevelopmentTokens:true,realtime:{eventUrl:`nats://127.0.0.1:${port}`}});
 const base=await temporary.listen({host:'127.0.0.1',port:0}),a=await bootstrap(pool),socket=await connect(a.owner_token,base);
 let changes=0;
 socket.on('updates.changed',(_value,ack)=>{changes++;ack();});
 try{
  await socket.timeout(1000).emitWithAck('updates.subscribe',{scope:'channel',id:a.channel_id});
  await until(()=>changes>0,'initial snapshot');await delay(150);
  const before=changes;
  offline=true;for(const connection of connections)connection.destroy();
  await delay(6500); // Exceed the broker's default ephemeral consumer inactivity window.
  const unavailable=await temporary.inject({method:'GET',url:'/readyz'});
  assert.equal(unavailable.statusCode,503);
  assert.equal(unavailable.json().realtime.broker,false);
  await pool.query("UPDATE channels SET description='Changed during outage' WHERE id=$1",[a.channel_id]);
  offline=false;
  const deadline=Date.now()+10000;
  while(changes<=before && Date.now()<deadline)await delay(20);
  assert.ok(changes>before,'reconnect must catch up the missed invalidation');
  await delay(100);const recovered=changes;
  await pool.query("UPDATE channels SET description='Changed after reconnect' WHERE id=$1",[a.channel_id]);
  await until(()=>changes>recovered,'the replacement ephemeral consumer must deliver future events');
  assert.equal((await temporary.inject({method:'GET',url:'/readyz'})).statusCode,200);
 }finally{
  offline=false;socket.disconnect();await temporary.close();
  for(const connection of connections)connection.destroy();
  await new Promise<void>(resolve=>proxy.close(()=>resolve()));
 }
});

test('a broker sequence gap catches up a quiet channel after its hint is evicted',async()=>{
 const {EventBus}=await import('@space/events');
 type Handler=Parameters<InstanceType<typeof EventBus>['subscribe']>[2];
 class ProbeBus extends EventBus{
  readonly handlers=new Map<string,Handler>();
  override async start(){}
  override async subscribeTransient(){return()=>{};}
  override async subscribe(filter:string,_options:Parameters<InstanceType<typeof EventBus>['subscribe']>[1],handler:Handler){this.handlers.set(filter,handler);return async()=>{this.handlers.delete(filter);};}
  async send(sequence:number,channel_id:string){await this.handlers.get('chat.changed.*')!({sequence,event:{id:randomUUID(),schema,kind:'chat.changed',aggregate_id:channel_id,data:{channel_id}},ack(){},retry(){}});}
 }
 const bus=new ProbeBus('nats://unused',schema),temporary=createApi(new PostgresStore(pool),{allowDevelopmentTokens:true,realtime:{events:bus}});
 const base=await temporary.listen({host:'127.0.0.1',port:0}),a=await bootstrap(pool),socket=await connect(a.owner_token,base);
 let changes=0;
 socket.on('updates.changed',(_value,ack)=>{changes++;ack();});
 try{
  await socket.timeout(1000).emitWithAck('updates.subscribe',{scope:'channel',id:a.channel_id});
  await until(()=>changes>0,'initial snapshot');await delay(50);
  const before=changes,other=randomUUID();
  await bus.send(1,other);
  await pool.query("UPDATE channels SET topic='Missed quiet-channel hint' WHERE id=$1",[a.channel_id]);
  // The quiet channel's sequence2 never reached this API; sequence3 belongs elsewhere.
  await bus.send(3,other);
  await until(()=>changes>before,'a gap must refresh all subscribed scopes, including the quiet channel');
 }finally{socket.disconnect();await temporary.close();await bus.close();}
});
