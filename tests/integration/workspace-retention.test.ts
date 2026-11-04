import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { WorkspaceRetentionStore } from '@space/postgres/workspace-retention';
const schema=`retention_${randomBytes(8).toString('hex')}`;
const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
const store=new WorkspaceRetentionStore(pool), zero='00000000-0000-0000-0000-000000000000';
before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL); await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool);
});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
type Seed=Awaited<ReturnType<typeof bootstrap>>;
async function message(a:Seed,age=2,id=randomUUID()) {
  await pool.query("INSERT INTO messages(id,workspace_id,channel_id,thread_id,author_type,user_id,client_message_id,request_hash,text,document,created_at) VALUES($1,$2,$3,$4,'human',$5,gen_random_uuid(),'test','Secret retained body','{\"ops\":[{\"insert\":\"Secret retained body\"}]}',now()-make_interval(days=>$6))",[id,a.workspace_id,a.channel_id,a.thread_id,a.owner_id,age]);
  return id;
}
async function policy(a:Seed,days:number|null){return(await pool.query('INSERT INTO workspace_preferences(workspace_id,retention_days) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET retention_days=excluded.retention_days RETURNING retention_version::text AS version',[a.workspace_id,days])).rows[0].version as string;}
const expire=(a:Seed,id:string,v='0')=>store.expire(a.workspace_id,a.channel_id,id,v);

test('default forever and disabled policies never erase; latest policy wins over stale deadlines',async()=>{
  const a=await bootstrap(pool),id=await message(a);
  assert.equal(await expire(a,id),0);
  assert.equal((await pool.query('SELECT retained_at FROM messages WHERE id=$1',[id])).rows[0].retained_at,null);
  const v=await policy(a,1); await policy(a,10); assert.ok(await expire(a,id,v)>0);
  await policy(a,null); assert.equal(await expire(a,id,v),0);
  assert.equal((await pool.query('SELECT text FROM messages WHERE id=$1',[id])).rows[0].text,'Secret retained body');
});

test('expiry irreversibly redacts live/replay content and todo copies while preserving identity and unrelated workspaces',async()=>{
  const a=await bootstrap(pool),b=await bootstrap(pool),id=await message(a),other=await message(b),todo=randomUUID();
  await pool.query("INSERT INTO hub_todos(id,workspace_id,user_id,title,document,channel_id,message_id) VALUES($1,$2,$3,'Secret copied title','{\"ops\":[{\"insert\":\"Secret\"}]}',$4,$5)",[todo,a.workspace_id,a.owner_id,a.channel_id,id]);
  const version=await policy(a,1); await Promise.all(Array.from({length:4},()=>expire(a,id,version)));
  const row=(await pool.query('SELECT text,document,attachments,agent_response,retained_at FROM messages WHERE id=$1',[id])).rows[0];
  assert.ok(row.retained_at);assert.equal(row.text,'Message removed by workspace retention.');assert.equal(row.document,null);assert.deepEqual(row.attachments,[]);assert.equal(row.agent_response,null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM message_identities WHERE id=$1',[id])).rows[0].n,1);
  const history=(await pool.query("SELECT payload FROM channel_events WHERE channel_id=$1 AND payload->>'id'=$2",[a.channel_id,id])).rows;
  assert.ok(history.length>=2);assert.ok(history.every(r=>!JSON.stringify(r.payload).includes('Secret')));
  const copy=(await pool.query('SELECT title,document,deleted FROM hub_todos WHERE id=$1',[todo])).rows[0];assert.equal(copy.deleted,true);assert.equal(copy.document,null);assert.equal(copy.title,row.text);
  assert.equal((await pool.query('SELECT text FROM messages WHERE id=$1',[other])).rows[0].text,'Secret retained body');
  await assert.rejects(pool.query("UPDATE messages SET text='restored' WHERE id=$1",[id]),/cannot be restored/);
  await assert.rejects(pool.query("UPDATE channel_events SET payload='{}' WHERE channel_id=$1",[a.channel_id]),/append-only/);
});

test('asset deletion is durable, scoped, retryable and removes file history',async()=>{
  const a=await bootstrap(pool),id=await message(a),asset=randomUUID(),version=await policy(a,1);
  await pool.query("INSERT INTO assets(id,workspace_id,channel_id,uploader_id,name,size,type,staging_key,object_key,status,message_id) VALUES($1::uuid,$2,$3,$4,'secret.txt',10,'text/plain','staging/'||$1::text,'files/'||$1::text,'ready',$5)",[asset,a.workspace_id,a.channel_id,a.owner_id,id]);
  await pool.query('INSERT INTO hub_file_state(workspace_id,user_id,asset_id,starred) VALUES($1,$2,$3,true)',[a.workspace_id,a.owner_id,asset]);
  await expire(a,id,version);
  assert.equal((await pool.query('SELECT count(*)::int n FROM assets WHERE id=$1',[asset])).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM hub_file_state WHERE asset_id=$1',[asset])).rows[0].n,0);
  await assert.rejects(store.deleteAsset(asset,async()=>{throw new Error('storage offline');}),/offline/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM retention_asset_deletions WHERE id=$1',[asset])).rows[0].n,1);
  const keys:string[]=[];await store.deleteAsset(asset,async key=>{keys.push(key);});await store.deleteAsset(asset,async()=>assert.fail('already removed'));
  assert.deepEqual(keys,[`staging/${asset}`,`files/${asset}`,`previews/${asset}/display.webp`,`previews/${asset}/thumbnail.webp`]);
});

test('historical backfill is bounded, duplicate-safe and cancelled by changed policy',async()=>{
  const a=await bootstrap(pool);
  for(let i=0;i<103;i++)await message(a);
  const version=await policy(a,1);
  const counts=await Promise.all([store.backfill(a.workspace_id,version,zero),store.backfill(a.workspace_id,version,zero)]);
  assert.deepEqual(counts.sort((a,b)=>a-b),[0,100]);
  const continuation=(await pool.query("SELECT payload FROM event_outbox WHERE kind='retention.backfill' AND aggregate_id=$1 AND payload->>'after_id'<>$2",[a.workspace_id,zero])).rows[0].payload;
  assert.equal(await store.backfill(a.workspace_id,version,continuation.after_id),3);
  await policy(a,null);assert.equal(await store.backfill(a.workspace_id,version,randomUUID()),0);
});

test('new message deadlines survive concurrent policy activation and wait for active asset processing',async()=>{
  const a=await bootstrap(pool),client=await pool.connect(),id=randomUUID();
  try{
    await client.query('BEGIN');await client.query("INSERT INTO messages(id,workspace_id,channel_id,thread_id,author_type,user_id,client_message_id,request_hash,text,created_at) VALUES($1,$2,$3,$4,'human',$5,gen_random_uuid(),'test','Concurrent secret',now()-interval '2 days')",[id,a.workspace_id,a.channel_id,a.thread_id,a.owner_id]);
    const version=await policy(a,1);await store.backfill(a.workspace_id,version,zero);await client.query('COMMIT');
    const event=(await pool.query("SELECT payload FROM event_outbox WHERE kind='retention.message_due' AND aggregate_id=$1",[id])).rows[0].payload;
    assert.equal(event.version,'0');
    const asset=randomUUID();await pool.query("INSERT INTO assets(id,workspace_id,channel_id,uploader_id,name,size,type,staging_key,object_key,status,message_id,processing_token,processing_until) VALUES($1::uuid,$2,$3,$4,'busy.txt',10,'text/plain',$1::text,$1::text,'ready',$5,gen_random_uuid(),now()+interval '1 minute')",[asset,a.workspace_id,a.channel_id,a.owner_id,id]);
    assert.ok(await expire(a,id,event.version)>0);
    await pool.query('UPDATE assets SET processing_token=NULL,processing_until=NULL WHERE id=$1',[asset]);await expire(a,id,event.version);
    assert.ok((await pool.query('SELECT retained_at FROM messages WHERE id=$1',[id])).rows[0].retained_at);
  }finally{await client.query('ROLLBACK');client.release();}
});
