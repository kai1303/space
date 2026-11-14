import { observeOutbox } from '../fixtures/observe-outbox.js';
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {migrate} from '@space/postgres/migrate';
import {bootstrap} from '@space/postgres/bootstrap';
import {HuddleStore} from '@space/postgres/huddles';
import {ChatStore} from '@space/postgres/chat';
import {HuddleService} from '@space/server/huddles';
import type {HuddleMedia} from '@space/server/huddle-media';

const schema=`huddles_${randomBytes(6).toString('hex')}`;
const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
const store=new HuddleStore(pool);
before(async()=>{assert.ok(process.env.TEST_DATABASE_URL);await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool); await observeOutbox(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
function media(){const rooms=new Set<string>();const provider:HuddleMedia={url:'ws://localhost:7880',create:async id=>{rooms.add(id);},remove:async id=>{rooms.delete(id);},exists:async id=>rooms.has(id),token:async(id,actor)=>`${id}:${actor}`,webhook:async()=>({event:'room_finished'})};return {rooms,provider};}

test('simultaneous starts share one room and both members can join',async()=>{
 const a=await bootstrap(pool),m=media(),service=new HuddleService(store,m.provider);
 const sessions=await Promise.all(Array.from({length:8},(_,i)=>service.join(i%2?a.owner_id:a.collaborator_id,a.channel_id)));
 assert.equal(new Set(sessions.map(s=>s.huddle.id)).size,1);assert.equal(m.rooms.size,1);
 assert.equal((await store.list(a.owner_id,a.workspace_id)).items.length,1);
 assert.equal(sessions[0]!.huddle.state,'active');
});
test('unjoined actors, other workspaces and archived channels cannot join',async()=>{
 const a=await bootstrap(pool),b=await bootstrap(pool),m=media(),service=new HuddleService(store,m.provider);
 await assert.rejects(service.join(b.owner_id,a.channel_id),{code:'not_found'});
 await assert.rejects(store.list(b.owner_id,a.workspace_id),{code:'not_found'});
 const dm=await new ChatStore(pool).directMessages.open(a.owner_id,a.workspace_id,{user_id:a.collaborator_id});
 await assert.rejects(service.join(b.owner_id,dm.id),{code:'not_found'});
 await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[a.channel_id,a.collaborator_id]);
 await assert.rejects(service.join(a.collaborator_id,a.channel_id),{code:'not_found'});
 await pool.query('UPDATE channels SET archived_at=now() WHERE id=$1',[a.channel_id]);
 await assert.rejects(service.join(a.owner_id,a.channel_id),{code:'not_found'});assert.equal(m.rooms.size,0);
});
test('revocation during room creation cannot issue a token or resurrect the room',async()=>{
 const a=await bootstrap(pool),m=media();let issued=0;
 m.provider.create=async id=>{m.rooms.add(id);await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[a.workspace_id,a.collaborator_id]);};
 m.provider.token=async()=>{issued++;return 'forbidden';};
 await assert.rejects(new HuddleService(store,m.provider).join(a.collaborator_id,a.channel_id));
 assert.equal(issued,0);assert.equal(m.rooms.size,0);
 const h=(await pool.query('SELECT * FROM channel_huddles WHERE channel_id=$1',[a.channel_id])).rows[0];
 assert.equal(h.state,'ended');
 assert.equal((await pool.query("SELECT count(*)::int n FROM observed_outbox WHERE kind='huddle.close' AND aggregate_id=$1",[h.id])).rows[0].n,1);
});
test('duplicate terminal events and delayed provisioning cannot reopen a room',async()=>{
 const a=await bootstrap(pool),m=media(),service=new HuddleService(store,m.provider);
 const first=await service.join(a.owner_id,a.channel_id);
 await store.end(first.huddle.id);await store.end(first.huddle.id);await service.provision(first.huddle.id);
 assert.equal(m.rooms.has(first.huddle.id),false);
 const second=await service.join(a.owner_id,a.channel_id);assert.notEqual(first.huddle.id,second.huddle.id);
 await store.end(first.huddle.id);assert.equal((await store.current(a.owner_id,a.channel_id))?.id,second.huddle.id);
});
test('missing media room recovers on the next authorized start without polling',async()=>{
 const a=await bootstrap(pool),m=media(),service=new HuddleService(store,m.provider);
 const first=await service.join(a.owner_id,a.channel_id);m.rooms.clear();
 await assert.rejects(service.join(a.owner_id,a.channel_id),{code:'huddle_ended'});
 const next=await service.join(a.owner_id,a.channel_id);assert.notEqual(next.huddle.id,first.huddle.id);
});
test('committed revocation wins against an overlapping start',async()=>{
 const a=await bootstrap(pool),client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[a.workspace_id,a.collaborator_id]);
  const starting=store.start(a.collaborator_id,a.channel_id);
  const rejected=assert.rejects(starting,{code:'not_found'});
  await new Promise(resolve=>setTimeout(resolve,25));await client.query('COMMIT');await rejected;
  assert.equal((await pool.query('SELECT count(*)::int n FROM channel_huddles WHERE channel_id=$1',[a.channel_id])).rows[0].n,0);
 }finally{await client.query('ROLLBACK');client.release();}
});
test('deleted huddle state preserves the durable media cleanup obligation',async()=>{
 const a=await bootstrap(pool),h=await store.start(a.owner_id,a.channel_id);
 await pool.query('DELETE FROM channel_huddles WHERE id=$1',[h.id]);
 assert.equal(await store.raw(h.id),null);
 assert.equal((await pool.query("SELECT count(*)::int n FROM observed_outbox WHERE kind='huddle.close' AND aggregate_id=$1",[h.id])).rows[0].n,1);
});

test('DM invitations, attendance and the saved thread are private and idempotent',async()=>{
 const a=await bootstrap(pool),b=await bootstrap(pool),chat=new ChatStore(pool),service=new HuddleService(store,media().provider);
 const dm=await chat.directMessages.open(a.owner_id,a.workspace_id,{user_id:a.collaborator_id});
 const first=await service.join(a.owner_id,dm.id),room=first.huddle;
 assert.equal(room.channel_name,dm.name);assert.ok(room.thread_id);
 assert.equal((await store.invitations(a.collaborator_id))[0]?.id,room.id);
 assert.equal((await store.invitations(b.owner_id)).length,0);
 const again=await Promise.all([service.join(a.owner_id,dm.id),service.join(a.collaborator_id,dm.id)]);
 assert.deepEqual(again.map(x=>x.huddle.thread_id),[room.thread_id,room.thread_id]);
 assert.equal((await store.invitations(a.collaborator_id)).length,0);
 assert.equal((await pool.query('SELECT count(*)::int n FROM messages WHERE thread_id=$1',[room.thread_id])).rows[0].n,1);
 await store.end(room.id);
 assert.equal((await store.recent(a.collaborator_id,a.workspace_id))[0]?.thread_id,room.thread_id);
 assert.deepEqual(await store.recent(b.owner_id,a.workspace_id),[]);
 await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[a.workspace_id,a.collaborator_id]);
 assert.deepEqual(await store.recent(a.collaborator_id,a.workspace_id),[]);
 await assert.rejects(service.join(a.owner_id,dm.id),{code:'not_found'});
});
test('encrypted DMs can huddle without creating a plaintext thread',async()=>{
 const a=await bootstrap(pool),chat=new ChatStore(pool),service=new HuddleService(store,media().provider);
 const dm=await chat.directMessages.open(a.owner_id,a.workspace_id,{user_id:a.collaborator_id});
 await pool.query('UPDATE channels SET encrypted_since=now() WHERE id=$1',[dm.id]);
 const {huddle}=await service.join(a.owner_id,dm.id);
 assert.equal(huddle.thread_id,null);
 assert.equal((await store.invitations(a.collaborator_id))[0]?.id,huddle.id);
 assert.equal((await pool.query('SELECT count(*)::int n FROM messages WHERE channel_id=$1',[dm.id])).rows[0].n,0);
});

test('channel invites require attendance and membership, dismiss idempotently and expire with the room',async()=>{
 const a=await bootstrap(pool),b=await bootstrap(pool),service=new HuddleService(store,media().provider);
 const {huddle}=await service.join(a.owner_id,a.channel_id);
 const listed=await new ChatStore(pool).channels(a.collaborator_id,a.workspace_id);
 assert.equal(listed.items.find(c=>c.id===a.channel_id)?.active_huddle,true);
 assert.equal((await store.people(a.owner_id,huddle.id,'')).items.some(row=>row.id===a.collaborator_id),true);
 await assert.rejects(store.invite(a.collaborator_id,huddle.id,a.owner_id),{code:'not_found'});
 await assert.rejects(store.invite(a.owner_id,huddle.id,b.owner_id),{code:'not_found'});
 await Promise.all([store.invite(a.owner_id,huddle.id,a.collaborator_id),store.invite(a.owner_id,huddle.id,a.collaborator_id)]);
 assert.deepEqual((await store.invitations(a.collaborator_id)).map(h=>h.id),[huddle.id]);
 await store.dismiss(a.collaborator_id,huddle.id);await store.dismiss(a.collaborator_id,huddle.id);
 assert.deepEqual(await store.invitations(a.collaborator_id),[]);
 await store.end(huddle.id);
 await assert.rejects(service.join(a.collaborator_id,a.channel_id,huddle.id),{code:'huddle_ended'});
 assert.equal(await store.current(a.owner_id,a.channel_id),null);
});
