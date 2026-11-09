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
test('unjoined actors, other workspaces, archived channels and DMs cannot join',async()=>{
 const a=await bootstrap(pool),b=await bootstrap(pool),m=media(),service=new HuddleService(store,m.provider);
 await assert.rejects(service.join(b.owner_id,a.channel_id),{code:'not_found'});
 await assert.rejects(store.list(b.owner_id,a.workspace_id),{code:'not_found'});
 const dm=await new ChatStore(pool).directMessages.open(a.owner_id,a.workspace_id,{user_id:a.collaborator_id});
 await assert.rejects(service.join(a.owner_id,dm.id),{code:'not_found'});
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
