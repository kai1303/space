import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {migrate} from '@space/postgres/migrate';
import {bootstrap} from '@space/postgres/bootstrap';
import {ChatStore} from '@space/postgres/chat';
import {CallStore} from '@space/postgres/calling';
const schema=`calls_${randomBytes(6).toString('hex')}`;
const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
const calls=new CallStore(pool),chat=new ChatStore(pool);
before(async()=>{if(!process.env.TEST_DATABASE_URL)throw Error('TEST_DATABASE_URL required');await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
async function setup(){const a=await bootstrap(pool);const dm=await chat.directMessages.open(a.owner_id,a.workspace_id,{user_id:a.collaborator_id});return {a,dm,input:{id:randomUUID(),channel_id:dm.id,device_id:randomUUID(),mode:'video' as const}};}
test('duplicate starts are idempotent, busy is global, and input identity cannot change',async()=>{
 const {a,input}=await setup();const results=await Promise.all([calls.start(a.owner_id,input),calls.start(a.owner_id,input)]);
 assert.equal(results[0].id,results[1].id);
 await assert.rejects(calls.start(a.owner_id,{...input,id:randomUUID()}),{code:'call_busy'});
 await assert.rejects(calls.start(a.collaborator_id,{...input,id:randomUUID(),device_id:randomUUID()}),{code:'call_busy'});
 await assert.rejects(calls.start(a.owner_id,{...input,mode:'audio'}),{code:'call_conflict'});
 await calls.end(a.owner_id,input.id,input.device_id,'cancelled');
 assert.equal((await pool.query('SELECT count(*)::int n FROM dm_call_participants WHERE call_id=$1',[input.id])).rows[0].n,0);
 assert.equal((await calls.history(a.owner_id,input.channel_id))[0]!.reason,'cancelled');
});
test('only one device accepts and other devices cannot signal or hang up the accepted call',async()=>{
 const {a,input}=await setup();await calls.start(a.owner_id,input);
 const d1=randomUUID(),d2=randomUUID();const outcomes=await Promise.allSettled([calls.accept(a.collaborator_id,input.id,d1),calls.accept(a.collaborator_id,input.id,d2)]);
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
 const call=(outcomes.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<any>).value;
 const winner=call.callee_device,loser=winner===d1?d2:d1;
 assert.equal((await calls.accept(a.collaborator_id,input.id,winner)).callee_device,winner);
 await assert.rejects(calls.endpoint(a.collaborator_id,input.id,loser),{code:'call_other_device'});
 await assert.rejects(calls.end(a.collaborator_id,input.id,loser,'completed'),{code:'call_other_device'});
 assert.equal((await calls.endpoint(a.collaborator_id,input.id,winner)).peer_id,a.owner_id);
 await calls.end(a.collaborator_id,input.id,winner,'completed');
});
test('accept/cancel races never resurrect ended calls',async()=>{
 const {a,input}=await setup();await calls.start(a.owner_id,input);
 await Promise.allSettled([calls.accept(a.collaborator_id,input.id,randomUUID()),calls.end(a.owner_id,input.id,input.device_id,'cancelled')]);
 assert.equal((await calls.read(a.owner_id,input.id)).state,'ended');
 await assert.rejects(calls.accept(a.collaborator_id,input.id,randomUUID()),{code:'call_ended'});
});
test('expiry is targeted, ignores fresh presence, and atomically frees participants',async()=>{
 const {a,input}=await setup();await calls.start(a.owner_id,input);
 await calls.expire(input.id);assert.equal((await calls.read(a.owner_id,input.id)).state,'ringing');
 await pool.query("UPDATE dm_calls SET created_at=now()-interval '31 seconds' WHERE id=$1",[input.id]);
 await calls.expire(input.id);assert.equal((await calls.read(a.owner_id,input.id)).reason,'missed');
 await calls.expire(input.id);assert.equal((await calls.read(a.owner_id,input.id)).revision,2);
 const next={...input,id:randomUUID()};await calls.start(a.owner_id,next);const device=randomUUID();await calls.accept(a.collaborator_id,next.id,device);
 await calls.heartbeat(a.owner_id,next.id,next.device_id);await calls.expire(next.id);assert.equal((await calls.read(a.owner_id,next.id)).state,'accepted');
 await pool.query("UPDATE dm_call_participants SET expires_at=now()-interval '1 second' WHERE user_id=$1",[a.collaborator_id]);
 await calls.expire(next.id);assert.equal((await calls.read(a.owner_id,next.id)).reason,'failed');
});
test('only two active DM participants may call, read history or signal; revocation ends the call',async()=>{
 const {a,input}=await setup(),b=await bootstrap(pool);
 await assert.rejects(calls.start(b.owner_id,input),{code:'not_found'});
 await assert.rejects(calls.start(a.owner_id,{...input,channel_id:a.channel_id}),{code:'not_found'});
 const self=await chat.directMessages.open(a.owner_id,a.workspace_id,{user_id:a.owner_id});
 await assert.rejects(calls.start(a.owner_id,{...input,channel_id:self.id}),{code:'not_found'});
 await calls.start(a.owner_id,input);
 await assert.rejects(calls.read(b.owner_id,input.id),{code:'not_found'});
 await assert.rejects(calls.history(b.owner_id,input.channel_id),{code:'not_found'});
 await assert.rejects(calls.accept(a.owner_id,input.id,randomUUID()),{code:'call_not_recipient'});
 await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[a.workspace_id,a.collaborator_id]);
 assert.equal((await calls.read(a.owner_id,input.id)).reason,'access_revoked');
 await assert.rejects(calls.start(a.owner_id,{...input,id:randomUUID()}),{code:'call_unavailable'});
});
test('a call start cannot race a committed membership removal',async()=>{
 const {a,input}=await setup();const tx=await pool.connect();
 try{
  await tx.query('BEGIN');await tx.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[a.workspace_id,a.collaborator_id]);
  const starting=calls.start(a.owner_id,input);
  // Force overlap while the revocation remains uncommitted; this is a bounded test rendezvous.
  await new Promise(resolve=>setTimeout(resolve,50));await tx.query('COMMIT');
  await assert.rejects(starting,{code:'call_unavailable'});
  assert.equal((await pool.query('SELECT count(*)::int n FROM dm_call_participants WHERE call_id=$1',[input.id])).rows[0].n,0);
 }finally{await tx.query('ROLLBACK');tx.release();}
});
