import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';

const schema = `todo_sync_${randomBytes(8).toString('hex')}`;
const admin = new Pool({connectionString:process.env.TEST_DATABASE_URL});
const pool = new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
const app = createApi(new PostgresStore(pool),{allowDevelopmentTokens:true});
before(async()=>{assert.ok(process.env.TEST_DATABASE_URL);await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await app.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
async function call(token:string,method:'GET'|'POST',url:string,payload?:object,status=200) {
 const r=await app.inject({method,url:`/v1${url}`,headers:{authorization:`Bearer ${token}`},payload});
 assert.equal(r.statusCode,status,r.body);return r.json();
}
async function setup() {
 const user=await bootstrap(pool),id=randomUUID(),base=`/workspaces/${user.workspace_id}/hub/todo-sources`;
 const source=await call(user.owner_token,'POST',`${base}/${id}`,{name:'Issue tracker'},201);
 return {...user,id,base,token:source.token};
}
const item=(revision='1',title='Imported task')=>({external_id:'ISSUE-123',revision,title,completed:false,url:'https://issues.example.com/ISSUE-123'});
const sync=(s:Awaited<ReturnType<typeof setup>>,body:object,status=200)=>call(s.token,'POST',`/todo-sync/${s.id}/items`,body,status);

test('imports are idempotent and preserve local reminders, Saved, and Clear state',async()=>{
 const s=await setup(),first=await sync(s,item());
 assert.equal(first.result,'applied');
 const hub=`/workspaces/${s.workspace_id}/hub/todos`;
 const detail=await call(s.owner_token,'GET',`${hub}/${first.id}`);
 assert.equal(detail.title,'Imported task');assert.equal(detail.external.name,'Issue tracker');assert.equal(detail.external.url,item().url);
 await call(s.owner_token,'POST',`${hub}/${first.id}`,{title:'Local edit',completed:true,archived:true,deleted:true,remind_at:'2030-01-01T09:00:00Z'});
 const replay=await sync(s,item());assert.equal(replay.result,'unchanged');assert.equal(replay.id,first.id);
 const newer=await sync(s,item('2','Updated externally'));assert.equal(newer.id,first.id);
 const row=(await pool.query('SELECT * FROM hub_todos WHERE id=$1',[first.id])).rows[0];
 assert.equal(row.title,'Updated externally');assert.equal(row.completed,false);assert.equal(row.archived,true);assert.equal(row.deleted,true);assert.equal(row.remind_at.toISOString(),'2030-01-01T09:00:00.000Z');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM hub_todos WHERE external_source_id=$1',[s.id])).rows[0].n,1);
});

test('out-of-order revisions are ignored and reused revisions with different content conflict',async()=>{
 const s=await setup(),current=await sync(s,item('10','Newest'));
 assert.equal((await sync(s,item('9','Old'))).result,'stale');
 await sync(s,item('10','Different'),409);
 const stored=await call(s.owner_token,'GET',`/workspaces/${s.workspace_id}/hub/todos/${current.id}`);assert.equal(stored.title,'Newest');
});

test('overlapping deliveries create one task and retain the highest revision',async()=>{
 const s=await setup();
 const results=await Promise.all(Array.from({length:12},(_,n)=>sync(s,item(String(n+1),`Revision ${n+1}`))));
 assert.equal(new Set(results.map(r=>r.id)).size,1);
 const rows=(await pool.query('SELECT title,external_revision FROM hub_todos WHERE external_source_id=$1',[s.id])).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].title,'Revision 12');assert.equal(rows[0].external_revision,'12');
});

test('sync credentials cannot access personal APIs, other sources, or other owners',async()=>{
 const s=await setup(),other=await setup();
 await sync(s,item());
 await call(s.token,'GET',`/workspaces/${s.workspace_id}/hub/todos`,undefined,401);
 await call(s.token,'POST',`/todo-sync/${other.id}/items`,item(),401);
 await call(s.collaborator_token,'POST',`${s.base}/${s.id}/revoke`,{},404);
 const sources=await call(s.owner_token,'GET',s.base);assert.equal(sources.items[0].token,undefined);assert.equal(sources.items[0].token_hash,undefined);
 const stored=(await pool.query('SELECT token_hash FROM todo_sync_sources WHERE id=$1',[s.id])).rows[0].token_hash;assert.notEqual(stored,s.token);assert.equal(stored.length,64);
});

test('rotation, expiry, revocation and membership removal invalidate sync tokens',async()=>{
 const s=await setup(),rotated=await call(s.owner_token,'POST',`${s.base}/${s.id}/token`,{});
 await sync(s,item(),401);s.token=rotated.token;await sync(s,item());
 await pool.query("UPDATE todo_sync_sources SET expires_at=now()-interval '1 second' WHERE id=$1",[s.id]);await sync(s,item('2'),401);
 s.token=(await call(s.owner_token,'POST',`${s.base}/${s.id}/token`,{})).token;
 await call(s.owner_token,'POST',`${s.base}/${s.id}/revoke`,{});await sync(s,item('2'),401);
 const memberSource=randomUUID();
 const memberToken=(await call(s.collaborator_token,'POST',`${s.base}/${memberSource}`,{name:'Member source'},201)).token;
 await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[s.workspace_id,s.collaborator_id]);
 await call(memberToken,'POST',`/todo-sync/${memberSource}/items`,item(),401);
});

test('input validation and receipt pagination do not expose local task content',async()=>{
 const s=await setup();
 for(const patch of [{revision:1},{revision:'01'},{revision:'0'},{revision:'9223372036854775808'},{completed:'yes'},{url:'javascript:alert(1)'},{url:'https://name:password@example.com'},{title:' '},{external_id:'x'.repeat(201)},{deleted:true},{workspace_id:s.workspace_id}])await sync(s,{...item(),...patch},400);
 const first=await sync(s,item());await sync(s,{...item(),external_id:'ISSUE-124'});
 await call(s.owner_token,'POST',`/workspaces/${s.workspace_id}/hub/todos/${first.id}`,{title:'Private local text'});
 const receipts=await call(s.token,'GET',`/todo-sync/${s.id}/items?limit=1`);
 assert.equal(receipts.items.length,1);assert.ok(receipts.next_cursor);assert.deepEqual(Object.keys(receipts.items[0]).sort(),['external_id','id','revision']);
 const next=await call(s.token,'GET',`/todo-sync/${s.id}/items?limit=1&after=${receipts.next_cursor}`);assert.equal(next.items.length,1);assert.notEqual(next.items[0].id,receipts.items[0].id);assert.equal(next.next_cursor,null);
});

test('sync works without development tokens while credential management retains session origin checks',async()=>{
 const s=await setup();
 const api=createApi(new PostgresStore(pool),{auth:{baseURL:'https://space.example',origins:new Set(['https://space.example']),
   actor:async headers=>headers.cookie==='session=valid'?s.owner_id:undefined,handler:async()=>new Response(null,{status:404})}});
 try {
  const imported=await api.inject({method:'POST',url:`/v1/todo-sync/${s.id}/items`,headers:{authorization:`Bearer ${s.token}`},payload:item()});
  assert.equal(imported.statusCode,200,imported.body);
  const route=`/v1${s.base}/${s.id}/token`;
  assert.equal((await api.inject({method:'POST',url:route,headers:{authorization:`Bearer ${s.token}`},payload:{}})).statusCode,401);
  assert.equal((await api.inject({method:'POST',url:route,headers:{cookie:'session=valid'},payload:{}})).statusCode,403);
  assert.equal((await api.inject({method:'POST',url:route,headers:{cookie:'session=valid',origin:'https://space.example'},payload:{}})).statusCode,200);
 } finally {await api.close();}
});
