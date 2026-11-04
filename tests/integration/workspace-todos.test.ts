import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';
const schema = `todos_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true });
before(async () => { assert.ok(process.env.TEST_DATABASE_URL); await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
type Seed = Awaited<ReturnType<typeof bootstrap>>;
async function request(token: string, method: 'GET' | 'POST', path: string, payload?: object, status = 200) {
  const response = await app.inject({ method, url: `/v1${path}`, headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() }, payload });
  assert.equal(response.statusCode, status, `${path}: ${response.body}`); return response.body ? response.json() : null;
}
const hub = (a: Seed, path: string, token = a.owner_token) => request(token, 'GET', `/workspaces/${a.workspace_id}/hub/${path}`);
const mutate = (a: Seed, path: string, payload: object, token = a.owner_token, status = 200) => request(token, 'POST', `/workspaces/${a.workspace_id}/hub/${path}`, payload, status);
const send = (a: Seed, text = 'Hello', extra: object = {}, token = a.owner_token, channel = a.channel_id) => request(token, 'POST', `/channels/${channel}/messages`, { client_message_id: randomUUID(), text, ...extra }, 201);

test('todo partial changes, rich documents and CAS preserve concurrent edits and retries', async () => {
  const a = await bootstrap(pool), id = randomUUID(), document = {ops:[{insert:'Rich body',attributes:{bold:true}},{insert:'\n'}]};
  const created = await mutate(a,`todos/${id}`,{title:'Original',document,remind_at:'2030-01-01T09:00:00Z',create_only:true});
  assert.deepEqual(created.document,document); assert.equal(created.archived,false); assert.equal(created.deleted,false);
  const edited = await mutate(a,`todos/${id}`,{title:'Edited',expected_updated_at:created.updated_at});
  assert.notEqual(edited.updated_at,created.updated_at);
  const done = await mutate(a,`todos/${id}`,{completed:true}); assert.equal(done.title,'Edited'); assert.deepEqual(done.document,document);
  await mutate(a,`todos/${id}`,{title:'Stale',expected_updated_at:created.updated_at},a.owner_token,409);
  const retried = await mutate(a,`todos/${id}`,{title:'Original',create_only:true}); assert.equal(retried.title,'Edited'); assert.equal(retried.completed,true);
  await mutate(a,`todos/${id}`,{deleted:true}); assert.equal((await hub(a,'todos')).items.length,0);
  await mutate(a,`todos/${id}`,{deleted:false,archived:true}); assert.equal((await hub(a,'todos?archived=true')).items.length,1);
  for(const payload of [{title:'bad',remind_at:'2026-02-30T09:00:00Z'},{title:'bad',document:{ops:[{insert:'x',attributes:{link:'javascript:x'}}]}},{completed:'yes'},{channel_id:a.channel_id},{expected_updated_at:'bad'}]) await mutate(a,`todos/${randomUUID()}`,payload,a.owner_token,400);
});

test('todo filtering, stable due pagination and scoped bounded cleanup', async () => {
  const a=await bootstrap(pool), ids:string[]=[];
  for (const [title,remind_at] of [['none',null],['future','2030-01-01T09:00:00Z'],['overdue','2020-01-01T09:00:00Z'],['same','2020-01-01T09:00:00Z']] as const) {const id=randomUUID();ids.push(id);await mutate(a,`todos/${id}`,{title,remind_at});}
  const first=await hub(a,'todos?limit=2'), second=await hub(a,`todos?limit=2&after=${first.next_cursor}`);
  assert.deepEqual(first.items.map((x:any)=>x.id),ids.slice(2).sort()); assert.deepEqual(second.items.map((x:any)=>x.id),[ids[1],ids[0]]);
  assert.equal((await hub(a,'todos?reminder=overdue')).items.length,2); assert.equal((await hub(a,'todos?reminder=upcoming')).items.length,1);assert.equal((await hub(a,'todos?reminder=none')).items.length,1);
  const cleanup=await mutate(a,'todos/cleanup',{action:'complete',scope:'overdue30'});assert.equal(cleanup.items.length,2);assert.ok(cleanup.items.every((x:any)=>x.completed));
  assert.equal((await hub(a,'todos?status=open')).items.length,2);assert.equal((await hub(a,'todos?status=completed')).items.length,2);
  await mutate(a,'todos/cleanup',{action:'archive',scope:'completed'});assert.equal((await hub(a,'todos')).items.length,2);assert.equal((await hub(a,'todos?archived=true')).items.length,2);
  await mutate(a,'todos/cleanup',{action:'delete',scope:'all'});assert.equal((await hub(a,'todos')).items.length,0);
});

test('source todo creation and current reads reject revoked sources',async()=>{
  const a=await bootstrap(pool),b=await bootstrap(pool),m=await send(a,'Secret'),id=randomUUID();
  await mutate(b,`todos/${randomUUID()}`,{title:'Secret',channel_id:a.channel_id,message_id:m.id},b.owner_token,404);
  await mutate(a,`todos/${id}`,{title:'Secret',channel_id:a.channel_id,message_id:m.id});assert.equal((await hub(a,'todos')).items.length,1);
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[a.channel_id,a.owner_id]);assert.equal((await hub(a,'todos')).items.length,0);
  await mutate(a,`todos/${id}`,{completed:true},a.owner_token,404);
});

test('todo cleanup caps each atomic operation at 240 items',async()=>{
 const a=await bootstrap(pool);
 await pool.query("INSERT INTO hub_todos(id,workspace_id,user_id,title) SELECT gen_random_uuid(),$1,$2,'Bulk' FROM generate_series(1,245)",[a.workspace_id,a.owner_id]);
 const first=await mutate(a,'todos/cleanup',{action:'complete',scope:'all'});assert.equal(first.items.length,240);assert.ok(first.next_cursor);
 const second=await mutate(a,'todos/cleanup',{action:'complete',scope:'all',after:first.next_cursor});assert.equal(second.items.length,5);assert.equal(second.next_cursor,null);
});

test('concurrent todo editors have one CAS winner while partial completion preserves text',async()=>{
 const a=await bootstrap(pool), id=randomUUID();
 const original=await mutate(a,`todos/${id}`,{title:'Original'});
 const responses=await Promise.all(['First','Second'].map(title=>app.inject({method:'POST',url:`/v1/workspaces/${a.workspace_id}/hub/todos/${id}`,headers:{authorization:`Bearer ${a.owner_token}`,'idempotency-key':randomUUID()},payload:{title,expected_updated_at:original.updated_at}})));
 assert.deepEqual(responses.map(x=>x.statusCode).sort(),[200,409]);
 const winner=responses.find(x=>x.statusCode===200)!.json();
 await mutate(a,`todos/${id}`,{completed:true});
 const detail=await hub(a,`todos/${id}`);assert.equal(detail.title,winner.title);assert.equal(detail.completed,true);
 await request(a.collaborator_token,'GET',`/workspaces/${a.workspace_id}/hub/todos/${id}`,undefined,404);
 const other=await mutate(a,`todos/${randomUUID()}`,{title:'Other owner'},a.collaborator_token);
 await mutate(a,'todos/cleanup',{action:'delete',scope:'all'});
 assert.equal((await hub(a,'todos',a.collaborator_token)).items[0].id,other.id);
});

test('todo sort cursors preserve timestamp precision and reject invalid or mismatched cursors',async()=>{
 const a=await bootstrap(pool),ids:string[]=[];
 for(let n=1;n<=5;n++) {
  const id=randomUUID();ids.push(id);await mutate(a,`todos/${id}`,{title:`Item ${n}`});
  await pool.query("UPDATE hub_todos SET created_at=('2026-01-01T00:00:00.00000'||$2::text||'Z')::timestamptz,remind_at=('2030-01-01T00:00:00.00000'||$2::text||'Z')::timestamptz WHERE id=$1",[id,n]);
 }
 for(const sort of ['due','oldest','newest']) {
  const one=await hub(a,`todos?sort=${sort}&limit=2`),two=await hub(a,`todos?sort=${sort}&limit=2&after=${one.next_cursor}`),three=await hub(a,`todos?sort=${sort}&limit=2&after=${two.next_cursor}`);
  assert.deepEqual([...one.items,...two.items,...three.items].map(x=>x.id),sort==='newest'?[...ids].reverse():ids);assert.equal(three.next_cursor,null);
  await request(a.owner_token,'GET',`/workspaces/${a.workspace_id}/hub/todos?sort=${sort==='due'?'newest':'due'}&after=${one.next_cursor}`,undefined,400);
 }
 for(const query of ['sort=no','status=no','reminder=no','archived=no','after='+ 'a'.repeat(513)])await request(a.owner_token,'GET',`/workspaces/${a.workspace_id}/hub/todos?${query}`,undefined,400);
});

test('identical CAS retries succeed without overwriting intervening partial changes',async()=>{
 const a=await bootstrap(pool), id=randomUUID();
 const original=await mutate(a,`todos/${id}`,{title:'Original'});
 const body={title:'Edited',document:{ops:[{insert:'Edited\n'}]},remind_at:'2030-01-01T09:00:00Z',expected_updated_at:original.updated_at};
 const saved=await mutate(a,`todos/${id}`,body);
 const replay=await mutate(a,`todos/${id}`,body);assert.equal(replay.updated_at,saved.updated_at);
 await mutate(a,`todos/${id}`,{completed:true});
 const replayAfterCompletion=await mutate(a,`todos/${id}`,body);assert.equal(replayAfterCompletion.completed,true);
 await mutate(a,`todos/${id}`,{title:'Later edit'});
 await mutate(a,`todos/${id}`,body,a.owner_token,409);
 assert.equal((await hub(a,`todos/${id}`)).title,'Later edit');
});

test('remove deleted source cleanup never treats revoked access as deletion or returns source text',async()=>{
 const a=await bootstrap(pool),deletedSource=await send(a,'Deleted source'),liveSource=await send(a,'Revoked source');
 const deletedTodo=randomUUID(),liveTodo=randomUUID(),otherTodo=randomUUID();
 await mutate(a,`todos/${deletedTodo}`,{title:'Deleted source secret',document:{ops:[{insert:'Private body'}]},channel_id:a.channel_id,message_id:deletedSource.id});
 await mutate(a,`todos/${liveTodo}`,{title:'Revoked source secret',channel_id:a.channel_id,message_id:liveSource.id});
 await mutate(a,`todos/${otherTodo}`,{title:'Other owner deleted source',channel_id:a.channel_id,message_id:deletedSource.id},a.collaborator_token);
 await pool.query('DELETE FROM messages WHERE channel_id=$1 AND id=$2',[a.channel_id,deletedSource.id]);
 await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[a.channel_id,a.owner_id]);
 const result=await mutate(a,'todos/cleanup',{action:'remove_deleted',scope:'all'});
 assert.equal(result.items.length,1);assert.equal(result.items[0].id,deletedTodo);assert.equal(result.items[0].deleted,true);
 assert.equal(result.items[0].title,'Deleted message');assert.equal(result.items[0].document,null);assert.equal(result.items[0].channel_id,null);assert.equal(result.items[0].message_id,null);
 assert.equal((await pool.query('SELECT deleted FROM hub_todos WHERE id=$1',[liveTodo])).rows[0].deleted,false);
 assert.equal((await pool.query('SELECT deleted FROM hub_todos WHERE id=$1',[otherTodo])).rows[0].deleted,false);
 assert.equal((await mutate(a,'todos/cleanup',{action:'remove_deleted',scope:'all'})).items.length,0);
 await mutate(a,'todos/cleanup',{action:'remove_deleted',scope:'completed'},a.owner_token,400);
});

test('valid rich documents at the parser byte limit survive JSONB storage formatting',async()=>{
 const a=await bootstrap(pool),document={ops:Array.from({length:2100},()=>({insert:'x'}))};
 const saved=await mutate(a,`todos/${randomUUID()}`,{title:'Many text runs',document});
 assert.equal(saved.document.ops.length,2100);
});

test('cleanup rejects coerced action and scope arrays before mutating',async()=>{
 const a=await bootstrap(pool);await mutate(a,`todos/${randomUUID()}`,{title:'Keep me'});
 for(const body of [{action:['complete'],scope:'all'},{action:'delete',scope:['all']}])await mutate(a,'todos/cleanup',body,a.owner_token,400);
 assert.equal((await hub(a,'todos')).items.length,1);
});
