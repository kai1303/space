import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import type { HubMessage, HubTodo } from '@space/contracts';
import { createApi } from '@space/server/api';
const schema = `hub_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true });
before(async () => { assert.ok(process.env.TEST_DATABASE_URL); await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
type Seed = Awaited<ReturnType<typeof bootstrap>>;
async function request(token: string, method: 'GET' | 'POST' | 'PATCH', path: string, payload?: object, status = 200) {
  const response = await app.inject({ method, url: `/v1${path}`, headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() }, payload });
  assert.equal(response.statusCode, status, `${path}: ${response.body}`); return response.body ? response.json() : null;
}
const hub = (a: Seed, path: string, token = a.owner_token) => request(token, 'GET', `/workspaces/${a.workspace_id}/hub/${path}`);
const mutate = (a: Seed, path: string, payload: object, token = a.owner_token, status = 200) => request(token, 'POST', `/workspaces/${a.workspace_id}/hub/${path}`, payload, status);
const send = (a: Seed, text = 'Hello', extra: object = {}, token = a.owner_token, channel = a.channel_id) => request(token, 'POST', `/channels/${channel}/messages`, { client_message_id: randomUUID(), text, ...extra }, 201);
async function revokeSeedOwner(a: Seed) {
  // Keep a valid primary owner while exercising the former owner's revoked access.
  await pool.query("UPDATE workspace_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2", [a.workspace_id, a.collaborator_id]);
  await pool.query('UPDATE workspaces SET primary_owner_id=$2 WHERE id=$1', [a.workspace_id, a.collaborator_id]);
  await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2', [a.workspace_id, a.owner_id]);
}

test('hub reads require current workspace membership and authentication', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  for (const path of ['threads', 'sent', 'saved', 'files', 'todos', 'starred']) {
    assert.deepEqual(await hub(a, path), { items: [], next_cursor: null });
    await request(b.owner_token, 'GET', `/workspaces/${a.workspace_id}/hub/${path}`, undefined, 404);
    const unauthenticated = await app.inject({ method: 'GET', url: `/v1/workspaces/${a.workspace_id}/hub/${path}` });
    assert.equal(unauthenticated.statusCode, 401);
  }
});

test('sent and participant threads exclude inaccessible channels and internal session entries', async () => {
  const a = await bootstrap(pool);
  const root = await send(a, 'Root'); await send(a, 'Reply', { thread_id: root.thread_id }, a.collaborator_token);
  const other = await send(a, 'Other root', {}, a.collaborator_token);
  await send(a, 'Other reply', { thread_id: other.thread_id }, a.collaborator_token);
  assert.deepEqual((await hub(a, 'threads')).items.map((m: any) => m.id), [root.id]);
  const first = (await hub(a, 'threads')).items[0]; assert.equal(first.reply_count, 1); assert.equal(first.author_name, 'Demo owner');
  await pool.query('INSERT INTO agent_sessions(id,workspace_id,installation_id,origin_thread_id) VALUES($1,$2,$3,$4)', [randomUUID(), a.workspace_id, a.installation_id, root.thread_id]);
  const session = (await pool.query('SELECT id FROM agent_sessions WHERE origin_thread_id=$1', [root.thread_id])).rows[0].id;
  const task = await request(a.owner_token, 'POST', '/tasks', { workspace_id: a.workspace_id, thread_id: root.thread_id, installation_id: a.installation_id, goal: 'Internal task', skill: 'demo.echo' }, 201);
  const internal = randomUUID();
  await pool.query("INSERT INTO messages(id,workspace_id,channel_id,thread_id,author_type,installation_id,text,agent_session_id,task_id) VALUES($1,$2,$3,$4,'agent',$5,'Private session',$6,$7)", [internal, a.workspace_id, a.channel_id, root.thread_id, a.installation_id, session, task.id]);
  assert.equal((await hub(a, 'threads')).items[0].reply_count, 1);
  await mutate(a, `saved/${internal}`, { channel_id: a.channel_id, active: true }, a.owner_token, 404);
  assert.deepEqual((await hub(a, 'sent')).items.map((m: any) => m.id), [root.id]);
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2', [a.channel_id, a.owner_id]);
  assert.equal((await hub(a, 'threads')).items.length, 0); assert.equal((await hub(a, 'sent')).items.length, 0);
});

test('thread inbox pages unread first and advances only the viewer and observed replies', async () => {
  const a = await bootstrap(pool);
  const root = await send(a, 'Release plan');
  const emptyPage = await hub(a, 'threads');
  assert.deepEqual(emptyPage.items, []);
  const first = await send(a, 'First reply', {thread_id:root.thread_id}, a.collaborator_token);
  await send(a, 'My reply', {thread_id:root.thread_id});
  await send(a, 'More notes', {thread_id:root.thread_id}, a.collaborator_token);
  const last = await send(a, 'Four replies', {thread_id:root.thread_id}, a.collaborator_token);
  const newer = await send(a, 'Another thread');
  const own = await send(a, 'Only my reply', {thread_id:newer.thread_id});
  const firstPage = await hub(a, 'threads?limit=1'), entry = firstPage.items[0];
  assert.equal(entry.id, root.id); assert.equal(entry.root.text,'Release plan');
  assert.equal(entry.unread_count,3); assert.equal(entry.reply_count,4); assert.equal(entry.latest_sequence,last.sequence);
  assert.deepEqual(entry.recent_replies.map((m:{text:string})=>m.text), ['More notes','Four replies']);
  assert.deepEqual(entry.participants.map((p:{id:string})=>p.id), [a.collaborator_id,a.owner_id]);
  assert.equal((await hub(a,'threads?limit=1&after='+firstPage.next_cursor)).items[0].id,newer.id);
  const read = (sequence:string,status=200) => mutate(a,'threads/'+root.thread_id+'/read',{sequence},a.owner_token,status);
  await read(own.sequence,400);
  await read(first.sequence);
  assert.equal((await hub(a,'threads')).items[0].unread_count,2);
  const concurrent = await Promise.all([read(last.sequence),read(first.sequence),read(last.sequence)]);
  assert.ok(concurrent.some(row=>row.sequence===last.sequence));
  assert.deepEqual(await read(first.sequence),{sequence:last.sequence});
  const after = await hub(a,'threads');
  assert.deepEqual(after.items.map((r:{id:string})=>r.id),[newer.id,root.id]);
  assert.equal(after.items[1].unread_count,0);
  assert.equal((await hub(a,'threads',a.collaborator_token)).items[0].unread_count,1);
  const older=await hub(a,`threads/${root.thread_id}/replies?before=${entry.recent_replies[0].sequence}`);
  assert.deepEqual(older.items.map((m:{text:string})=>m.text),['First reply','My reply']);
  await mutate(a,'threads/'+root.thread_id+'/unread',{sequence:last.sequence});
  assert.equal((await hub(a,'threads')).items.find((m:{id:string})=>m.id===root.id).unread_count,1);
  await read(last.sequence);
  await send(a,'Arrived after open',{thread_id:root.thread_id},a.collaborator_token);
  await read(last.sequence);
  assert.equal((await hub(a,'threads')).items[0].unread_count,1);
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[a.channel_id,a.owner_id]);
  await read(last.sequence,404);
  await mutate(a,'threads/'+root.thread_id+'/unread',{sequence:last.sequence},a.owner_token,404);
  assert.deepEqual((await hub(a,'threads')).items,[]);
});

test('actor subscriptions override DM and channel defaults without reopening an unfollowed thread', async () => {
  const a=await bootstrap(pool);
  const settings = (thread:string) => '/threads/'+thread+'/notification-subscription';
  const follow = (thread:string, following:boolean) => request(a.collaborator_token,'PATCH',settings(thread),{following});
  const dm = await request(a.owner_token,'POST','/workspaces/'+a.workspace_id+'/direct-messages',{user_id:a.collaborator_id});
  const root=await send(a,'DM root',{},a.owner_token,dm.id);
  assert.deepEqual(await request(a.collaborator_token,'GET',settings(root.thread_id)),{following:true});
  await send(a,'DM reply',{thread_id:root.thread_id},a.owner_token,dm.id);
  assert.equal((await hub(a,'threads',a.collaborator_token)).items[0].channel_kind,'direct');
  await follow(root.thread_id,false);
  await send(a,'Reply after unfollow',{thread_id:root.thread_id},a.collaborator_token,dm.id);
  await send(a,'Unfollow survives',{thread_id:root.thread_id},a.owner_token,dm.id);
  assert.deepEqual((await hub(a,'threads',a.collaborator_token)).items,[]);
  const notifications=(await request(a.collaborator_token,'GET','/workspaces/'+a.workspace_id+'/notifications')).items;
  assert.ok(notifications.some((n:{kind:string})=>n.kind==='thread_reply'));
  assert.ok(!notifications.some((n:{text:string})=>n.text==='Unfollow survives'));
  const channelRoot=await send(a,'Anyone can follow');
  await send(a,'Channel reply',{thread_id:channelRoot.thread_id});
  await pool.query('UPDATE channel_members SET follow_every_thread=true WHERE channel_id=$1 AND user_id=$2',[a.channel_id,a.collaborator_id]);
  assert.deepEqual(await request(a.collaborator_token,'GET',settings(channelRoot.thread_id)),{following:true});
  assert.equal((await hub(a,'threads',a.collaborator_token)).items[0].id,channelRoot.id);
  await follow(channelRoot.thread_id,false);
  assert.deepEqual((await hub(a,'threads',a.collaborator_token)).items,[]);
  await follow(root.thread_id,true);
  assert.equal((await hub(a,'threads',a.collaborator_token)).items[0].id,root.id);
});

test('inbox previews expose author avatars, actor-owned saves and current reply reactions', async () => {
  const a = await bootstrap(pool), avatar = 'https://example.test/profile.png';
  await pool.query('UPDATE users SET image=$2 WHERE id=$1',[a.collaborator_id,avatar]);
  const root = await send(a, 'Review'), reply = await send(a,'Approved',{thread_id:root.thread_id},a.collaborator_token);
  await mutate(a,'saved/'+reply.id,{channel_id:a.channel_id,active:true});
  const revision = async () => (await pool.query('SELECT revision FROM resource_update_revisions WHERE resource=$1',
    ['workspace-messages:'+a.workspace_id])).rows[0].revision;
  const prev = await revision();
  await request(a.owner_token,'POST','/channels/'+a.channel_id+'/messages/'+reply.id+'/reactions',{emoji:'👍',active:true});
  assert.ok(BigInt(await revision()) > BigInt(prev));
  await request(a.collaborator_token,'POST','/channels/'+a.channel_id+'/messages/'+reply.id+'/reactions',{emoji:'👍',active:true});
  const [row] = (await hub(a,'threads')).items;
  assert.deepEqual(row.root.reactions,[]);
  assert.equal(row.root.viewer_saved,false);
  const [preview] = row.recent_replies;
  assert.equal(preview.author.image,avatar);
  assert.equal(preview.viewer_saved,true);
  assert.deepEqual(preview.reactions,[{emoji:'👍',count:2,user_ids:[a.owner_id,a.collaborator_id].sort()}]);
  assert.equal((await hub(a,'threads',a.collaborator_token)).items[0].recent_replies[0].viewer_saved,false);
  await request(a.owner_token,'POST','/channels/'+a.channel_id+'/messages/'+reply.id+'/reactions',{emoji:'👍',active:false});
  assert.deepEqual((await hub(a,'threads')).items[0].recent_replies[0].reactions,[{emoji:'👍',count:1,user_ids:[a.collaborator_id]}]);
});

test('saved and starred toggles are owner scoped, concurrent and idempotent, with fresh channel authorization', async () => {
  const a = await bootstrap(pool), message = await send(a);
  await Promise.all(Array.from({ length: 8 }, () => mutate(a, `saved/${message.id}`, { channel_id: a.channel_id, active: true })));
  await Promise.all(Array.from({ length: 8 }, () => mutate(a, `starred/${a.channel_id}`, { active: true })));
  assert.equal((await hub(a, 'saved')).items.length, 1); assert.deepEqual((await hub(a, 'starred')).items, [{ id: a.channel_id, name: 'general', kind: 'channel', private: false }]);
  assert.equal((await hub(a, 'saved', a.collaborator_token)).items.length, 0); assert.equal((await hub(a, 'starred', a.collaborator_token)).items.length, 0);
  await mutate(a, `saved/${message.id}`, { channel_id: a.channel_id, active: false }); await mutate(a, `saved/${message.id}`, { channel_id: a.channel_id, active: false });
  assert.equal((await hub(a, 'saved')).items.length, 0);
  await mutate(a, `saved/${message.id}`, { channel_id: a.channel_id, active: true });
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2', [a.channel_id, a.owner_id]);
  for (const path of ['saved', 'starred']) assert.equal((await hub(a, path)).items.length, 0);
  await mutate(a, `saved/${message.id}`, { channel_id: a.channel_id, active: false }, a.owner_token, 404);
  await mutate(a, `starred/${a.channel_id}`, { active: false }, a.owner_token, 404);
});

test('todo IDs cannot be overwritten by another owner or workspace and retries preserve timestamps', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool), id = randomUUID();
  const values = await Promise.all(Array.from({ length: 8 }, () => mutate(a, `todos/${id}`, { title: 'Ship it', completed: false })));
  assert.ok(values.every(todo => todo.id === id)); assert.equal(new Set(values.map(todo => todo.updated_at)).size, 1);
  await mutate(a, `todos/${id}`, { title: 'Stolen', completed: true }, a.collaborator_token, 404);
  await mutate(b, `todos/${id}`, { title: 'Stolen', completed: true }, b.owner_token, 404);
  assert.equal((await hub(a, 'todos', a.collaborator_token)).items.length, 0);
  const done = await mutate(a, `todos/${id}`, { title: 'Ship it', completed: true }); assert.equal(done.completed, true);
  assert.equal((await hub(a, 'todos')).items.length, 1);
  await revokeSeedOwner(a);
  await request(a.owner_token, 'GET', `/workspaces/${a.workspace_id}/hub/todos`, undefined, 404);
  await mutate(a, `todos/${id}`, { title: 'Again', completed: false }, a.owner_token, 404);
});

test('pages are bounded and stable and invalid input is rejected', async () => {
  const a = await bootstrap(pool);
  for (let n = 0; n < 5; n++) await mutate(a, `todos/${randomUUID()}`, { title: `Todo ${n}`, completed: false });
  const first = await hub(a, 'todos?limit=2'), second = await hub(a, `todos?limit=2&after=${first.next_cursor}`), third = await hub(a, `todos?limit=2&after=${second.next_cursor}`);
  assert.equal(first.items.length, 2); assert.equal(second.items.length, 2); assert.equal(third.items.length, 1); assert.equal(third.next_cursor, null);
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map(todo => todo.id)).size, 5);
  for (const query of ['limit=101', 'limit=0', 'after=no', 'extra=true']) await request(a.owner_token, 'GET', `/workspaces/${a.workspace_id}/hub/todos?${query}`, undefined, 400);
  for (const payload of [{ title: '', completed: false }, { title: 'ok', completed: 'false' }, {}]) await mutate(a, `todos/${randomUUID()}`, payload, a.owner_token, 400);
  await mutate(a, `starred/${a.channel_id}`, { active: 'true' }, a.owner_token, 400);
});

test('files show only ready shared attachments with access and ordinary message sources', async () => {
  const a = await bootstrap(pool), message = await send(a), id = randomUUID();
  await pool.query("INSERT INTO assets(id,workspace_id,channel_id,uploader_id,name,size,type,staging_key,object_key,status,message_id,preview) VALUES($1::uuid,$2,$3,$4,'report.pdf',20,'application/pdf',$1::text,$1::text,'ready',$5,'{\"kind\":\"pdf\"}')", [id, a.workspace_id, a.channel_id, a.owner_id, message.id]);
  const file = (await hub(a, 'files')).items[0]; assert.equal(file.filename, 'report.pdf'); assert.equal(file.byte_size, 20); assert.equal(file.message_id, message.id); assert.equal(file.preview_kind, 'pdf');
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2', [a.channel_id, a.owner_id]); assert.equal((await hub(a, 'files')).items.length, 0);
});

test('hub mutations publish durable invalidation without explicit database locks', async () => {
  const a = await bootstrap(pool), message = await send(a), statements: string[] = [], originals = new Map<PoolClient, PoolClient['query']>();
  const trace = (client: PoolClient) => { if (originals.has(client)) return; const query = client.query; originals.set(client, query); client.query = function(this: PoolClient, ...args: any[]) { statements.push(typeof args[0] === 'string' ? args[0] : args[0]?.text ?? ''); return (query as Function).apply(this, args); } as PoolClient['query']; };
  const revision = async () => (await pool.query('SELECT revision::text FROM resource_update_revisions WHERE resource=$1', [`workspace:${a.workspace_id}`])).rows[0]?.revision;
  const before = await revision(); pool.on('acquire', trace);
  try { await mutate(a, `saved/${message.id}`, { channel_id: a.channel_id, active: true }); await mutate(a, `starred/${a.channel_id}`, { active: true }); await mutate(a, `todos/${randomUUID()}`, { title: 'Check', completed: false }); }
  finally { pool.off('acquire', trace); for (const [client, query] of originals) client.query = query; }
  assert.notEqual(await revision(), before); assert.ok(statements.length); assert.ok(statements.every(sql => !/(?:FOR (?:UPDATE|SHARE)|pg_advisory|LOCK TABLE)/i.test(sql)));
});

test('unjoined public channels and foreign resources never become hub access grants', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool), message = await send(a);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')", [a.workspace_id, b.owner_id]);
  for (const path of ['threads', 'sent', 'saved', 'files', 'starred']) assert.equal((await hub(a, path, b.owner_token)).items.length, 0);
  await mutate(a, `saved/${message.id}`, { channel_id: a.channel_id, active: true }, b.owner_token, 404);
  await mutate(a, `starred/${a.channel_id}`, { active: true }, b.owner_token, 404);
  await mutate(b, `saved/${message.id}`, { channel_id: a.channel_id, active: true }, b.owner_token, 404);
  await mutate(b, `starred/${a.channel_id}`, { active: true }, b.owner_token, 404);
  await revokeSeedOwner(a);
  for (const path of ['threads', 'sent', 'saved', 'files', 'todos', 'starred']) await request(a.owner_token, 'GET', `/workspaces/${a.workspace_id}/hub/${path}`, undefined, 404);
  await mutate(a, `saved/${message.id}`, { channel_id: a.channel_id, active: true }, a.owner_token, 404);
  await mutate(a, `starred/${a.channel_id}`, { active: true }, a.owner_token, 404);
});

test('message, saved and file cursors retain tied timestamps without duplicate or missing items', async () => {
  const a = await bootstrap(pool);
  for (let n = 0; n < 5; n++) {
    const message = await send(a, `Message ${n}`), id = randomUUID();
    await mutate(a, `saved/${message.id}`, { channel_id: a.channel_id, active: true });
    await pool.query("INSERT INTO assets(id,workspace_id,channel_id,uploader_id,name,size,type,staging_key,object_key,status,message_id) VALUES($1::uuid,$2,$3,$4,'test.txt',10,'text/plain',$1::text,$1::text,'ready',$5)", [id, a.workspace_id, a.channel_id, a.owner_id, message.id]);
  }
  await pool.query("UPDATE messages SET created_at='2026-01-01' WHERE workspace_id=$1", [a.workspace_id]);
  for (const view of ['sent', 'saved', 'files']) {
    const first = await hub(a, `${view}?limit=2`), second = await hub(a, `${view}?limit=2&after=${first.next_cursor}`), third = await hub(a, `${view}?limit=2&after=${second.next_cursor}`);
    assert.equal(first.items.length, 2); assert.equal(second.items.length, 2); assert.equal(third.items.length, 1); assert.equal(third.next_cursor, null);
    assert.equal(new Set([...first.items, ...second.items, ...third.items].map(item => item.id)).size, 5);
  }
});

test('message and file pages are newest first and preserve microsecond keyset boundaries', async () => {
  const a = await bootstrap(pool), messages: string[] = [], files: string[] = [];
  for (let n = 1; n <= 5; n++) {
    const message = await send(a, `Chronological ${n}`), id = randomUUID(); messages.push(message.id); files.push(id);
    await mutate(a, `saved/${message.id}`, { channel_id: a.channel_id, active: true });
    await pool.query("INSERT INTO assets(id,workspace_id,channel_id,uploader_id,name,size,type,staging_key,object_key,status,message_id) VALUES($1::uuid,$2,$3,$4,'order.txt',10,'text/plain',$1::text,$1::text,'ready',$5)", [id, a.workspace_id, a.channel_id, a.owner_id, message.id]);
    await pool.query("UPDATE messages SET created_at=('2026-01-01T00:00:00.00000' || $2::text || 'Z')::timestamptz WHERE channel_id=$1 AND id=$3", [a.channel_id, n, message.id]);
  }
  for (const view of ['sent', 'saved', 'files']) {
    const first = await hub(a, `${view}?limit=2`), second = await hub(a, `${view}?limit=2&after=${first.next_cursor}`), third = await hub(a, `${view}?limit=2&after=${second.next_cursor}`);
    assert.deepEqual([...first.items, ...second.items, ...third.items].map(item => item.id), [...(view === 'files' ? files : messages)].reverse());
    assert.ok(first.items[0].created_at > first.items[1].created_at); assert.equal(third.next_cursor, null);
    for (const cursor of [randomUUID(), Buffer.from(JSON.stringify({ time: 'invalid', id: randomUUID() })).toString('base64url'), 'a'.repeat(513)]) {
      await request(a.owner_token, 'GET', `/workspaces/${a.workspace_id}/hub/${view}?after=${cursor}`, undefined, 400);
    }
  }
});

test('message-to-do creation retries preserve explicit edits and selected stars report exact state', async () => {
  const a=await bootstrap(pool),id=randomUUID();
  await mutate(a,`todos/${id}`,{title:'Original',completed:false,create_only:true});
  await mutate(a,`todos/${id}`,{title:'Edited',completed:true});
  await mutate(a,`todos/${id}`,{title:'Original',completed:false,create_only:true});
  const todos=await hub(a,'todos');assert.equal(todos.items[0].title,'Edited');assert.equal(todos.items[0].completed,true);
  const path=`/workspaces/${a.workspace_id}/hub/starred/${a.channel_id}`;
  assert.deepEqual(await request(a.owner_token,'GET',path),{active:false});
  await mutate(a,`starred/${a.channel_id}`,{active:true});
  assert.deepEqual(await request(a.owner_token,'GET',path),{active:true});
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[a.channel_id,a.owner_id]);
  await request(a.owner_token,'GET',path,undefined,404);
});

test('file search, ownership, type, sender, channel and dates filter before pagination', async () => {
  const a = await bootstrap(pool), ids: string[] = [];
  for (let n = 0; n < 4; n++) {
    const message = await send(a), id = randomUUID(); ids.push(id);
    await pool.query("INSERT INTO assets(id,workspace_id,channel_id,uploader_id,name,size,type,staging_key,object_key,status,message_id,preview) VALUES($1::uuid,$2,$3,$4,$5,20,'application/pdf',$1::text,$1::text,'ready',$6,'{\"kind\":\"pdf\"}')", [id,a.workspace_id,a.channel_id,n === 0 ? a.collaborator_id : a.owner_id,n === 0 ? 'Needle_100%.pdf' : 'other.pdf',message.id]);
    await pool.query("UPDATE messages SET created_at=('2026-01-0' || $1::text || 'T00:00:00.000001Z')::timestamptz WHERE channel_id=$2 AND id=$3",[n+1,a.channel_id,message.id]);
  }
  assert.equal((await hub(a,'files?limit=1')).items[0].id, ids[3]);
  const result = await hub(a,`files?q=Needle_100%25&kind=pdf&ownership=shared&from=${a.collaborator_id}&channel=${a.channel_id}&since=2026-01-01T00%3A00%3A00Z&before=2026-01-02T00%3A00%3A00Z&limit=1`);
  assert.deepEqual(result.items.map((f: any) => f.id),[ids[0]]); assert.equal(result.next_cursor,null);
  assert.equal(result.items[0].uploader_name,'Demo collaborator'); assert.equal(result.items[0].starred,false);
  assert.equal((await hub(a,'files?ownership=created')).items.length,3);
  const first = await hub(a,'files?sort=oldest&limit=2'), second = await hub(a,`files?sort=oldest&limit=2&after=${first.next_cursor}`);
  assert.deepEqual([...first.items,...second.items].map((f: any) => f.id),ids);
  for (const query of ['kind=bad','sort=bad','ownership=bad','from=no','since=no','q='+ 'a'.repeat(256),'starred=bad']) await request(a.owner_token,'GET',`/workspaces/${a.workspace_id}/hub/files?${query}`,undefined,400);
});

test('file stars and view history are durable, personal, concurrent and access checked', async () => {
  const a=await bootstrap(pool), b=await bootstrap(pool), message=await send(a), id=randomUUID();
  await pool.query("INSERT INTO assets(id,workspace_id,channel_id,uploader_id,name,size,type,staging_key,object_key,status,message_id) VALUES($1::uuid,$2,$3,$4,'star.txt',10,'text/plain',$1::text,$1::text,'ready',$5)",[id,a.workspace_id,a.channel_id,a.owner_id,message.id]);
  await Promise.all(Array.from({length:6},()=>mutate(a,`files/${id}/star`,{active:true})));
  await Promise.all([mutate(a,`files/${id}/view`,{}),mutate(a,`files/${id}/star`,{active:true})]);
  const file=(await hub(a,'files?starred=true&sort=recent')).items[0]; assert.equal(file.id,id); assert.equal(file.starred,true); assert.ok(file.last_viewed_at);
  assert.equal((await hub(a,'files?starred=true',a.collaborator_token)).items.length,0);
  assert.equal((await hub(a,'files',a.collaborator_token)).items[0].last_viewed_at,null);
  await mutate(b,`files/${id}/star`,{active:true},b.owner_token,404);
  await mutate(a,`files/${id}/star`,{active:false}); await mutate(a,`files/${id}/star`,{active:false});
  assert.equal((await hub(a,'files?starred=true')).items.length,0); assert.ok((await hub(a,'files')).items[0].last_viewed_at);
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[a.channel_id,a.owner_id]);
  await mutate(a,`files/${id}/star`,{active:true},a.owner_token,404); await mutate(a,`files/${id}/view`,{},a.owner_token,404);
  assert.equal((await hub(a,'files')).items.length,0);
});

test('recent file order keeps unviewed files chronological and viewing moves a file to the front', async () => {
  const a=await bootstrap(pool),ids=['ffffffff-ffff-4fff-8fff-fffffffffff1','11111111-1111-4111-8111-111111111112','22222222-2222-4222-8222-222222222223'];
  for(let n=0;n<ids.length;n++) {
    const message=await send(a);
    await pool.query("INSERT INTO assets(id,workspace_id,channel_id,uploader_id,name,size,type,staging_key,object_key,status,message_id) VALUES($1::uuid,$2,$3,$4,'recent.txt',10,'text/plain',$1::text,$1::text,'ready',$5)",[ids[n],a.workspace_id,a.channel_id,a.owner_id,message.id]);
    await pool.query("UPDATE messages SET created_at=('2026-01-0' || $1::text || 'T00:00:00Z')::timestamptz WHERE channel_id=$2 AND id=$3",[n+1,a.channel_id,message.id]);
  }
  assert.deepEqual((await hub(a,'files?sort=recent')).items.map((file:any)=>file.id),[...ids].reverse());
  await mutate(a,`files/${ids[0]}/view`,{});
  const first=await hub(a,'files?sort=recent&limit=1'),second=await hub(a,`files?sort=recent&limit=2&after=${first.next_cursor}`);
  assert.deepEqual([...first.items,...second.items].map((file:any)=>file.id),[ids[0],ids[2],ids[1]]);
});

test('multiple file types are ORed before pagination and an empty selection returns no files', async () => {
  const a=await bootstrap(pool), ids: string[]=[];
  for (const [name,kind] of [['doc.pdf','pdf'],['note.txt','text'],['photo.png','image'],['archive.zip','unsupported']]) {
    const message=await send(a),id=randomUUID();ids.push(id);
    await pool.query("INSERT INTO assets(id,workspace_id,channel_id,uploader_id,name,size,type,staging_key,object_key,status,message_id,preview) VALUES($1::uuid,$2,$3,$4,$5,10,'application/octet-stream',$1::text,$1::text,'ready',$6,$7::jsonb)",[id,a.workspace_id,a.channel_id,a.owner_id,name,message.id,JSON.stringify({kind})]);
  }
  const first=await hub(a,'files?kinds=image,pdf&sort=oldest&limit=1');
  const second=await hub(a,`files?kinds=image,pdf&sort=oldest&limit=1&after=${first.next_cursor}`);
  assert.deepEqual([...first.items,...second.items].map((file:any)=>file.id),[ids[0],ids[2]]);assert.equal(second.next_cursor,null);
  assert.deepEqual(await hub(a,'files?kinds='),{items:[],next_cursor:null});
  assert.equal((await hub(a,'files?kinds=other')).items[0].id,ids[3]);
  assert.equal((await hub(a,'files?kinds=image,pdf,text,audio,video,other')).items.length,4);
  assert.equal((await hub(a,'files?kind=pdf')).items[0].id,ids[0]);
  for(const query of ['kinds=bad','kinds=pdf,,image','kinds=all','kinds=pdf,pdf','kinds=pdf&kind=image','kinds='+ 'a'.repeat(100)]) await request(a.owner_token,'GET',`/workspaces/${a.workspace_id}/hub/files?${query}`,undefined,400);
});

test('Saved uses bookmark time, moves exactly once across concurrent attempts, and scopes cleanup by owner',async()=>{
  const a=await bootstrap(pool),old=await send(a,'An older message'),recent=await send(a,'A newer message');
  for(const m of [recent,old])await mutate(a,'saved/'+m.id,{channel_id:a.channel_id,active:true});
  await mutate(a,'saved/'+old.id,{channel_id:a.channel_id,active:true},a.collaborator_token);
  const first=await hub(a,'saved?limit=1');
  assert.equal(first.items[0].id,old.id);assert.equal((await hub(a,'saved?after='+first.next_cursor)).items[0].id,recent.id);
  const moved=await Promise.all(Array.from({length:4},()=>mutate(a,'saved/cleanup',{action:'move',message_id:old.id})));
  assert.equal(moved.reduce((sum,r)=>sum+r.count,0),1);
  assert.deepEqual((await hub(a,'todos')).items.map((todo: HubTodo)=>todo.message_id),[old.id]);
  await mutate(a,'saved/cleanup',{action:'clear'});
  assert.equal((await hub(a,'saved')).items.length,0);
  assert.deepEqual((await hub(a,'saved',a.collaborator_token)).items.map((message: HubMessage)=>message.id),[old.id]);
});
