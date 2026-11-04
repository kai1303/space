import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';
import { io } from 'socket.io-client';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate, migrationFiles } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';
const schema=`notifications_${randomBytes(8).toString('hex')}`;
const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
const app=createApi(new PostgresStore(pool),{allowDevelopmentTokens:true});
before(async()=>{assert.ok(process.env.TEST_DATABASE_URL);await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await app.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
async function api(token:string,method:'GET'|'POST'|'PATCH'|'DELETE',path:string,payload?:object,status=200){const r=await app.inject({method,url:`/v1${path}`,headers:{authorization:`Bearer ${token}`},payload});assert.equal(r.statusCode,status,`${path}: ${r.body}`);return r.body?r.json():null;}
type Seed=Awaited<ReturnType<typeof bootstrap>>;
const activity=(a:Seed,token=a.collaborator_token,query='')=>api(token,'GET',`/workspaces/${a.workspace_id}/notifications${query}`);
const settings=(a:Seed,patch:object,token=a.collaborator_token)=>api(token,'PATCH',`/workspaces/${a.workspace_id}/notification-settings`,patch);
const send=(a:Seed,text='Hello',extra:object={},token=a.owner_token,channel=a.channel_id)=>api(token,'POST',`/channels/${channel}/messages`,{client_message_id:randomUUID(),text,...extra},201);
const mention=(id:string,label='Demo collaborator')=>({ops:[{insert:`@${label}`,attributes:{mention:{kind:'user',id,label}}},{insert:' hello'}]});
const mark=(a:Seed,id:string,read:boolean,token=a.collaborator_token)=>api(token,'PATCH',`/workspaces/${a.workspace_id}/notifications/${id}`,{read});
const claim=(a:Seed,id:string,token=a.collaborator_token)=>api(token,'POST',`/workspaces/${a.workspace_id}/notifications/${id}/claim`,{});

test('mentions and DMs deduplicate, exclude self, and display viewer-relative DM names',async()=>{
 const a=await bootstrap(pool),dm=await api(a.owner_token,'POST',`/workspaces/${a.workspace_id}/direct-messages`,{user_id:a.collaborator_id});
 const request={client_message_id:randomUUID(),text:'@Demo collaborator hello',document:mention(a.collaborator_id)};
 await Promise.all([1,2].map(()=>api(a.owner_token,'POST',`/channels/${dm.id}/messages`,request,201)));
 await send(a,'Plain DM',{},a.owner_token,dm.id);
 const result=await activity(a);assert.deepEqual(result.items.map((n:any)=>n.kind),['direct_message','mention']);assert.equal(result.unread_count,2);assert.equal(result.items[0].channel_name,'Demo owner');assert.equal(result.items[0].channel_kind,'direct');assert.equal((await activity(a,a.owner_token)).items.length,0);
 assert.equal((await activity(a,a.collaborator_token,'?kind=direct_message')).items.length,2);
 const b=await bootstrap(pool);await api(b.owner_token,'GET',`/workspaces/${a.workspace_id}/notifications`,undefined,404);
});
test('thread authors, repliers and mentioned humans follow; explicit unsubscribe survives participation',async()=>{
 const a=await bootstrap(pool),root=await send(a);
 assert.deepEqual(await api(a.owner_token,'GET',`/threads/${root.thread_id}/notification-subscription`),{following:true});
 await send(a,'Reply',{thread_id:root.thread_id},a.collaborator_token);
 assert.equal((await activity(a,a.owner_token)).items[0].kind,'thread_reply');
 await api(a.owner_token,'PATCH',`/threads/${root.thread_id}/notification-subscription`,{following:false});
 await send(a,'Owner speaks',{thread_id:root.thread_id});await send(a,'Another reply',{thread_id:root.thread_id},a.collaborator_token);
 assert.equal((await activity(a,a.owner_token)).items.length,1);assert.deepEqual(await api(a.owner_token,'GET',`/threads/${root.thread_id}/notification-subscription`),{following:false});
 const mentioned=await send(a,'@Demo collaborator hello',{document:mention(a.collaborator_id)});
 assert.deepEqual(await api(a.collaborator_token,'GET',`/threads/${mentioned.thread_id}/notification-subscription`),{following:true});
});
test('reactions notify the original human once per reactor and emoji despite retries or remove/re-add',async()=>{
 const a=await bootstrap(pool),root=await send(a);
 const react=(active:boolean,token=a.collaborator_token)=>api(token,'POST',`/channels/${a.channel_id}/messages/${root.id}/reactions`,{emoji:'👍',active});
 await react(true);await react(true);await react(false);await react(true);await react(true,a.owner_token);
 const result=await activity(a,a.owner_token);assert.equal(result.items.length,1);assert.equal(result.items[0].kind,'reaction');assert.equal(result.items[0].emoji,'👍');assert.equal(result.items[0].author_name,'Demo collaborator');
});
test('preferences default safely, share legacy pause, retain paused unread and all-mode root activity',async()=>{
 const a=await bootstrap(pool);assert.deepEqual(await api(a.collaborator_token,'GET',`/workspaces/${a.workspace_id}/notification-settings`),{mode:'mentions',desktop_enabled:false,preview_enabled:false,thread_replies:true,paused_until:null});
 const pause=new Date(Date.now()+3600000).toISOString();await settings(a,{mode:'all',desktop_enabled:true,paused_until:pause});
 await send(a);const result=await activity(a);assert.equal(result.items[0].kind,'channel_message');assert.equal(result.items[0].silent,true);assert.equal(result.unread_count,1);assert.equal((await claim(a,result.items[0].id)).deliver,false);
 assert.equal(new Date((await api(a.collaborator_token,'GET',`/workspaces/${a.workspace_id}/mention-settings`)).paused_until).toISOString(),pause);
 await settings(a,{paused_until:null,mode:'none'});await send(a,'@Demo collaborator hello',{document:mention(a.collaborator_id)});assert.equal((await activity(a)).items[0].silent,true);
});
test('read watermark excludes a later arrival; unread filters retain the global count and watermark',async()=>{
 const a=await bootstrap(pool);await settings(a,{mode:'all'});await send(a,'First');const first=await activity(a);await send(a,'Second');
 await api(a.collaborator_token,'POST',`/workspaces/${a.workspace_id}/notifications/read`,{through:first.latest_id});
 const next=await activity(a,a.collaborator_token,'?unread=true');assert.equal(next.items.length,1);assert.equal(next.items[0].text,'Second');assert.equal(next.unread_count,1);assert.notEqual(next.latest_id,first.latest_id);
 const empty=await activity(a,a.collaborator_token,'?kind=reaction');assert.equal(empty.items.length,0);assert.equal(empty.unread_count,1);assert.equal(empty.latest_id,next.latest_id);
 await mark(a,next.items[0].id,true);await mark(a,first.items[0].id,false);assert.equal((await activity(a)).unread_count,1);
});
test('concurrent desktop claims are once only and recheck read, current preferences, freshness and channel access',async()=>{
 const a=await bootstrap(pool);await settings(a,{mode:'all',desktop_enabled:true,preview_enabled:true});await send(a);let n=(await activity(a)).items[0];
 const claims=await Promise.all(Array.from({length:5},()=>claim(a,n.id)));assert.equal(claims.filter(r=>r.deliver).length,1);assert.equal(claims.find(r=>r.deliver).notification.text,'Hello');assert.equal(claims.find(r=>r.deliver).preview_enabled,true);
 await send(a);n=(await activity(a)).items[0];await mark(a,n.id,true);assert.equal((await claim(a,n.id)).deliver,false);await mark(a,n.id,false);await settings(a,{desktop_enabled:false});assert.equal((await claim(a,n.id)).deliver,false);
 await settings(a,{desktop_enabled:true});await pool.query("UPDATE notifications SET created_at=now()-interval '3 minutes' WHERE id=$1",[n.id]);assert.equal((await claim(a,n.id)).deliver,false);
 await send(a);n=(await activity(a)).items[0];await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[a.channel_id,a.collaborator_id]);assert.equal((await activity(a)).unread_count,0);assert.equal((await claim(a,n.id)).deliver,false);await api(a.collaborator_token,'PATCH',`/workspaces/${a.workspace_id}/notifications/${n.id}`,{read:true},404);
});
test('notification routes reject malformed input and revoked membership',async()=>{
 const a=await bootstrap(pool);
 for(const query of ['?before=no','?kind=bogus','?unread=no','?limit=500'])await api(a.collaborator_token,'GET',`/workspaces/${a.workspace_id}/notifications${query}`,undefined,400);
 for(const patch of [{},{mode:'bad'},{mode:['all']},{desktop_enabled:'yes'},{preview_enabled:1},{thread_replies:0},{paused_until:'bad'},{paused_until:new Date(Date.now()+8*86400000).toISOString()},{extra:true}])await api(a.collaborator_token,'PATCH',`/workspaces/${a.workspace_id}/notification-settings`,patch,400);
 await api(a.collaborator_token,'POST',`/workspaces/${a.workspace_id}/notifications/read`,{through:'not-number'},400);
 await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[a.workspace_id,a.collaborator_id]);
 for(const path of ['notifications','notification-settings'])await api(a.collaborator_token,'GET',`/workspaces/${a.workspace_id}/${path}`,undefined,404);
});

test('required mutation bodies cannot silently become reads or no-ops',async()=>{
 const a=await bootstrap(pool);
 await api(a.collaborator_token,'POST',`/workspaces/${a.workspace_id}/notifications/read`,{},400);
 await api(a.collaborator_token,'PATCH',`/threads/${a.thread_id}/notification-subscription`,undefined,415);
 await api(a.collaborator_token,'PATCH',`/threads/${a.thread_id}/notification-subscription`,{},400);
});

test('activity has stable bounded pages, excludes inaccessible public mentions and retains authorized unreads only',async()=>{
 const a=await bootstrap(pool),b=await bootstrap(pool);
 await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[a.workspace_id,b.owner_id]);
 await send(a,'@Demo owner hello',{document:mention(b.owner_id,'Demo owner')});
 assert.equal((await activity(a,b.owner_token)).items.length,0);
 await settings(a,{mode:'all'});
 for(let i=0;i<52;i++)await send(a,`Message ${i}`);
 const first=await activity(a),second=await activity(a,a.collaborator_token,`?before=${first.next_cursor}`);
 assert.equal(first.items.length,50);assert.equal(second.items.length,2);assert.equal(second.next_cursor,null);
 assert.equal(new Set([...first.items,...second.items].map(n=>n.id)).size,52);assert.equal(second.latest_id,first.latest_id);assert.equal(second.unread_count,52);
 await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[a.workspace_id,a.collaborator_id]);
 await api(a.collaborator_token,'POST',`/workspaces/${a.workspace_id}/notifications/${first.items[0].id}/claim`,{},404);
});

test('current pause/mode/thread preferences suppress delivery and read changes remain separate from channel unread',async()=>{
 const a=await bootstrap(pool);await settings(a,{mode:'all',desktop_enabled:true});await send(a);
 const first=(await activity(a)).items[0];
 await settings(a,{paused_until:new Date(Date.now()+3600000).toISOString()});assert.equal((await claim(a,first.id)).deliver,false);
 await settings(a,{paused_until:null,mode:'mentions'});assert.equal((await claim(a,first.id)).deliver,false);
 const root=await send(a,'Root',{},a.collaborator_token);await send(a,'Reply',{thread_id:root.thread_id});
 const reply=(await activity(a)).items[0];assert.equal(reply.kind,'thread_reply');await settings(a,{thread_replies:false});assert.equal((await claim(a,reply.id)).deliver,false);
 const unread=await api(a.collaborator_token,'GET',`/workspaces/${a.workspace_id}/unread`);await mark(a,first.id,true);
 assert.deepEqual(await api(a.collaborator_token,'GET',`/workspaces/${a.workspace_id}/unread`),unread);
});

test('historical migration preserves safe mention activity and participation without granting access',async()=>{
 const historical=`notifications_old_${randomBytes(8).toString('hex')}`,old=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${historical}`});
 try{
  await admin.query(`CREATE SCHEMA ${historical}`);
  await old.query('CREATE TABLE schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const [index,file] of migrationFiles.slice(0,migrationFiles.indexOf('040_notifications.sql')).entries()){
   await old.query(await readFile(new URL(`../../adapters/postgres/migrations/${file}`,import.meta.url),'utf8'));await old.query('INSERT INTO schema_migrations(version) VALUES($1)',[index+1]);
  }
  // Seed only columns present before notification migration 040.
  const a={workspace_id:randomUUID(),channel_id:randomUUID(),thread_id:randomUUID(),owner_id:randomUUID(),collaborator_id:randomUUID()},id=randomUUID();
  await old.query("INSERT INTO users(id,display_name) VALUES($1,'Legacy owner'),($2,'Legacy collaborator')",[a.owner_id,a.collaborator_id]);
  await old.query("INSERT INTO workspaces(id,name) VALUES($1,'Legacy workspace')",[a.workspace_id]);
  await old.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[a.workspace_id,a.owner_id,a.collaborator_id]);
  await old.query("INSERT INTO channels(id,workspace_id,name,private,created_by) VALUES($1,$2,'general',false,$3)",[a.channel_id,a.workspace_id,a.owner_id]);
  await old.query('INSERT INTO channel_members(workspace_id,channel_id,user_id) VALUES($1,$2,$3),($1,$2,$4)',[a.workspace_id,a.channel_id,a.owner_id,a.collaborator_id]);
  await old.query('INSERT INTO threads(id,workspace_id,channel_id) VALUES($1,$2,$3)',[a.thread_id,a.workspace_id,a.channel_id]);
  await old.query("INSERT INTO messages(id,workspace_id,channel_id,thread_id,author_type,user_id,client_message_id,request_hash,text) VALUES($1,$2,$3,$4,'human',$5,$6,'hash','Old mention')",[id,a.workspace_id,a.channel_id,a.thread_id,a.owner_id,randomUUID()]);
  await old.query('INSERT INTO mention_notifications(workspace_id,channel_id,message_id,user_id,silent,read_at) VALUES($1,$2,$3,$4,true,now())',[a.workspace_id,a.channel_id,id,a.collaborator_id]);
  await migrate(old);await migrate(old);
  const n=(await old.query('SELECT * FROM notifications')).rows;assert.equal(n.length,1);assert.equal(n[0].kind,'mention');assert.equal(n[0].silent,true);assert.ok(n[0].read_at);
  const followers=(await old.query('SELECT user_id FROM notification_subscriptions WHERE thread_id=$1',[a.thread_id])).rows.map(r=>r.user_id).sort();assert.deepEqual(followers,[a.owner_id,a.collaborator_id].sort());
 }finally{await old.end();await admin.query(`DROP SCHEMA IF EXISTS ${historical} CASCADE`);}
});

test('notification mutations use atomic optimistic writes without explicit database locks',async()=>{
 const a=await bootstrap(pool);await settings(a,{mode:'all',desktop_enabled:true});await send(a);const item=(await activity(a)).items[0];
 const statements:string[]=[],originals=new Map<PoolClient,PoolClient['query']>();
 const trace=(client:PoolClient)=>{if(originals.has(client))return;const query=client.query;originals.set(client,query);client.query=function(this:PoolClient,...args:any[]){statements.push(typeof args[0]==='string'?args[0]:args[0]?.text??'');return (query as Function).apply(this,args);} as PoolClient['query'];};
 pool.on('acquire',trace);
 try{await settings(a,{preview_enabled:true});await claim(a,item.id);await mark(a,item.id,true);await api(a.collaborator_token,'POST',`/workspaces/${a.workspace_id}/notifications/read`,{through:item.id});await api(a.owner_token,'PATCH',`/threads/${item.thread_id}/notification-subscription`,{following:false});}
 finally{pool.off('acquire',trace);for(const [client,query] of originals)client.query=query;}
 assert.ok(statements.length>0);assert.ok(statements.every(statement=>!/(?:FOR (?:UPDATE|SHARE)|pg_advisory|LOCK TABLE)/i.test(statement)));
});

test('workspace-only subscriptions wake for unopened notifications and replay after reconnect',async()=>{
 const temporary=createApi(new PostgresStore(pool),{allowDevelopmentTokens:true,realtime:{}});
 const base=await temporary.listen({host:'127.0.0.1',port:0}),a=await bootstrap(pool);
 const connect=async()=>{const socket=io(base,{transports:['websocket'],auth:{token:a.collaborator_token},reconnection:false});await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});return socket;};
 let socket=await connect();
 const changed=()=>new Promise<void>((resolve,reject)=>{const deadline=setTimeout(()=>reject(Error('No workspace notification invalidation')),3000);socket.once('updates.changed',(value,ack)=>{ack?.();clearTimeout(deadline);assert.equal(value.scope,'workspace');resolve();});});
 try{
  let next=changed();await socket.timeout(1000).emitWithAck('updates.subscribe',{scope:'workspace',id:a.workspace_id});await next;
  next=changed();await send(a,'@Demo collaborator hello',{document:mention(a.collaborator_id)});await next;assert.equal((await activity(a)).unread_count,1);
  socket.disconnect();await send(a,'@Demo collaborator hello',{document:mention(a.collaborator_id)});socket=await connect();
  next=changed();await socket.timeout(1000).emitWithAck('updates.subscribe',{scope:'workspace',id:a.workspace_id});await next;assert.equal((await activity(a)).unread_count,2);
 }finally{socket.disconnect();await temporary.close();}
});

test('a delayed insert that commits after a fetched watermark remains unread',async()=>{
 const a=await bootstrap(pool),first=await send(a,'Delayed'),second=await send(a,'Visible first');
 const tx=await pool.connect();let delayed:Promise<unknown>|undefined;
 try{
  await pool.query(`CREATE FUNCTION delay_notification_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.message_id='${first.id}'::uuid THEN PERFORM pg_sleep(1.5); END IF; RETURN NEW; END; $$`);
  await pool.query('CREATE TRIGGER aaa_notification_delay_test BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION delay_notification_test()');
  await tx.query('BEGIN');const pid=(await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const insert='INSERT INTO notifications(workspace_id,channel_id,message_id,user_id,actor_id,kind) VALUES($1,$2,$3,$4,$5,\'channel_message\')';
  delayed=tx.query(insert,[a.workspace_id,a.channel_id,first.id,a.collaborator_id,a.owner_id]);
  const deadline=Date.now()+1000;
  while((await pool.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event!=='PgSleep'){
   assert.ok(Date.now()<deadline,'first insert must be paused before ordering its recipient feed');await new Promise(resolve=>setTimeout(resolve,10));
  }
  await pool.query(insert,[a.workspace_id,a.channel_id,second.id,a.collaborator_id,a.owner_id]);
  const snapshot=await activity(a);assert.equal(snapshot.items.length,1);assert.equal(snapshot.items[0].message_id,second.id);
  await delayed;await tx.query('COMMIT');
  await api(a.collaborator_token,'POST',`/workspaces/${a.workspace_id}/notifications/read`,{through:snapshot.latest_id});
  const unread=await activity(a,a.collaborator_token,'?unread=true');assert.deepEqual(unread.items.map((n:any)=>n.message_id),[first.id]);assert.ok(BigInt(unread.latest_id)>BigInt(snapshot.latest_id));
 }finally{await delayed;await tx.query('ROLLBACK');tx.release();await pool.query('DROP TRIGGER IF EXISTS aaa_notification_delay_test ON notifications');await pool.query('DROP FUNCTION IF EXISTS delay_notification_test()');}
});

test('concurrent cross-channel messages keep recipient order and claims do not publish feedback updates',async()=>{
 const a=await bootstrap(pool);await settings(a,{mode:'all',desktop_enabled:true});
 const other=await api(a.owner_token,'POST',`/workspaces/${a.workspace_id}/channels`,{name:'Another feed',private:false},201);
 await api(a.collaborator_token,'POST',`/channels/${other.id}/join`,{});
 const requests=Array.from({length:8},(_,i)=>({method:'POST' as const,url:`/v1/channels/${i%2?a.channel_id:other.id}/messages`,headers:{authorization:`Bearer ${a.owner_token}`},payload:{client_message_id:randomUUID(),text:`Concurrent ${i}`}}));
 const responses=await Promise.all(requests.map(request=>app.inject(request)));
 for(const [index,response] of responses.entries()){
  if(response.statusCode===201)continue;
  assert.equal(response.statusCode,409,response.body);assert.equal(response.json().error,'session_conflict');
  // Preserve the client identity when retrying a contended write after the burst settles.
  const retry=await app.inject(requests[index]!);assert.equal(retry.statusCode,201,retry.body);
 }
 const result=await activity(a);assert.equal(result.items.length,8);assert.equal(new Set(result.items.map((n:any)=>n.id)).size,8);
 const revision=()=>pool.query('SELECT resource,revision::text FROM resource_update_revisions ORDER BY resource');
 const before=(await revision()).rows;await claim(a,result.items[0].id);assert.deepEqual((await revision()).rows,before,'desktop claims must not feed another Activity invalidation');
});

test('legacy mention read state and Activity read/unread stay synchronized',async()=>{
 const a=await bootstrap(pool);await send(a,'@Demo collaborator hello',{document:mention(a.collaborator_id)});
 const notification=(await activity(a)).items[0],legacy=(await api(a.collaborator_token,'GET',`/workspaces/${a.workspace_id}/mentions`)).items[0];
 await api(a.collaborator_token,'POST',`/workspaces/${a.workspace_id}/mentions/${legacy.id}/read`,{});assert.ok((await activity(a)).items[0].read_at);
 await mark(a,notification.id,false);assert.equal((await api(a.collaborator_token,'GET',`/workspaces/${a.workspace_id}/mentions`)).items[0].read_at,null);
 await mark(a,notification.id,true);assert.ok((await api(a.collaborator_token,'GET',`/workspaces/${a.workspace_id}/mentions`)).items[0].read_at);
 await mark(a,notification.id,false);
 await Promise.all([mark(a,notification.id,true),api(a.collaborator_token,'POST',`/workspaces/${a.workspace_id}/mentions/${legacy.id}/read`,{})]);
 assert.ok((await activity(a)).items[0].read_at);
});
