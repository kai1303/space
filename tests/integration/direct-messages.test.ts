import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { AssetStore } from '@space/postgres/assets';
import { FoundationStore } from '@space/postgres/foundation';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';

const schema = `dm_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true });
before(async () => { if (!process.env.TEST_DATABASE_URL) throw Error('TEST_DATABASE_URL required'); await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
async function api(token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: object, status = 200) {
  const response = await app.inject({ method, url: `/v1${path}`, headers: { authorization: `Bearer ${token}` }, payload });
  assert.equal(response.statusCode, status, `${path}: ${response.body}`); return response.body ? response.json() : null;
}
const open = (a: Awaited<ReturnType<typeof bootstrap>>, user = a.collaborator_id, token = a.owner_token) => api(token, 'POST', `/workspaces/${a.workspace_id}/direct-messages`, { user_id: user });
const inbox = (a: Awaited<ReturnType<typeof bootstrap>>, token = a.owner_token, query = '') => api(token, 'GET', `/workspaces/${a.workspace_id}/direct-messages${query}`);

test('concurrent reciprocal opens return a single private conversation and viewer-relative participants', async () => {
  const a = await bootstrap(pool);
  const rows = await Promise.all([open(a), open(a, a.owner_id, a.collaborator_token), open(a)]);
  assert.equal(new Set(rows.map(r => r.id)).size, 1);
  assert.equal(rows[0].kind, 'direct'); assert.equal(rows[0].private, true);
  assert.equal(rows[0].name, 'Demo collaborator'); assert.equal(rows[1].name, 'Demo owner');
  assert.equal(rows[0].participants.length, 2);
  const details = await api(a.owner_token, 'GET', `/channels/${rows[0].id}`);
  assert.equal(details.kind, 'direct'); assert.equal(details.can_manage, false); assert.equal(details.name, 'Demo collaborator');
  assert.ok(!(await api(a.owner_token, 'GET', `/workspaces/${a.workspace_id}/channels`)).items.some((r: any) => r.id === rows[0].id));
});
test('self messages, bounded people search and inbox pagination', async () => {
  const a = await bootstrap(pool);
  const dm = await open(a, a.owner_id);
  assert.equal(dm.name, 'Demo owner (you)'); assert.equal(dm.participants.length, 1);
  await open(a);
  const first = await inbox(a, a.owner_token, '?limit=1'); assert.equal(first.items.length, 1); assert.ok(first.next_cursor);
  const second = await inbox(a, a.owner_token, `?limit=1&after=${first.next_cursor}`); assert.equal(second.items.length, 1); assert.notEqual(first.items[0].id, second.items[0].id);
  const people = await api(a.owner_token, 'GET', `/workspaces/${a.workspace_id}/direct-message-people?q=collab&limit=1`);
  assert.deepEqual(people.items.map((r: any) => r.id), [a.collaborator_id]);
  await api(a.owner_token, 'GET', `/workspaces/${a.workspace_id}/direct-message-people?limit=1000`, undefined, 400);
});
test('close/reopen preserves history; new incoming messages restore the recipient and unread', async () => {
  const a = await bootstrap(pool), dm = await open(a);
  assert.equal((await inbox(a, a.collaborator_token)).items.length, 0, 'recipient remains hidden until an actual message');
  const request = { client_message_id: randomUUID(), text: 'Hello privately' };
  const sent = await Promise.all([api(a.owner_token, 'POST', `/channels/${dm.id}/messages`, request, 201), api(a.owner_token, 'POST', `/channels/${dm.id}/messages`, request, 201)]);
  assert.equal(sent[0].id, sent[1].id);
  assert.equal((await inbox(a, a.collaborator_token)).items[0].last_message.text, request.text);
  await api(a.collaborator_token, 'PATCH', `/channels/${dm.id}/direct-message`, { hidden: true });
  assert.equal((await inbox(a, a.collaborator_token)).items.length, 0);
  assert.equal((await open(a, a.owner_id, a.collaborator_token)).id, dm.id);
  assert.equal((await api(a.collaborator_token, 'GET', `/channels/${dm.id}/messages`)).messages.length, 1);
  await api(a.collaborator_token, 'PATCH', `/channels/${dm.id}/direct-message`, { hidden: true });
  await api(a.owner_token, 'POST', `/channels/${dm.id}/messages`, { client_message_id: randomUUID(), text: 'Welcome back' }, 201);
  assert.equal((await inbox(a, a.collaborator_token)).items[0].hidden, false);
  const unread = (await api(a.collaborator_token, 'GET', `/workspaces/${a.workspace_id}/unread`)).channels.find((r: any) => r.channel_id === dm.id);
  assert.equal(unread.unread_count, 2);
  assert.equal((await inbox(a, a.collaborator_token, '?unread=true')).items[0].id, dm.id);
  await api(a.collaborator_token, 'POST', `/channels/${dm.id}/read`, { sequence: unread.latest_sequence });
  assert.equal((await api(a.collaborator_token, 'GET', `/workspaces/${a.workspace_id}/unread`)).channels.find((r: any) => r.channel_id === dm.id).unread_count, 0);
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query('UPDATE direct_message_views SET hidden=true WHERE channel_id=$1 AND user_id=$2', [dm.id, a.collaborator_id]);
    const events = await tx.query('SELECT count(*)::int AS count FROM event_outbox WHERE aggregate_id=$1', [dm.id]);
    assert.ok(events.rows[0].count > 0, 'visibility changes enqueue a durable event in the same transaction');
  } finally { await tx.query('ROLLBACK'); tx.release(); }

});
test('DMs reject strangers, cross-workspace users, deactivated participants, membership edits and agent access', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool), dm = await open(a);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'admin')", [a.workspace_id, b.owner_id]);
  for (const path of [`/channels/${dm.id}`, `/channels/${dm.id}/messages`, `/channels/${dm.id}/members`]) await api(b.owner_token, 'GET', path, undefined, 404);
  await open(a, b.collaborator_id).then(() => assert.fail('cross-workspace open succeeded'), error => assert.match(error.message, /404/));
  for (const payload of [{ name: 'Changed' }, { archived: true }]) await api(a.owner_token, 'PATCH', `/channels/${dm.id}`, payload, 403);
  await api(a.owner_token, 'POST', `/channels/${dm.id}/join`, {}, 403);
  await api(a.owner_token, 'POST', `/channels/${dm.id}/members`, { user_id: b.owner_id }, 403);
  await api(a.owner_token, 'DELETE', `/channels/${dm.id}/members/${a.owner_id}`, undefined, 403);
  await assert.rejects(new FoundationStore(pool).grant(a.owner_id, a.installation_id, { channel_id: dm.id, skill: 'demo.echo' }), { status: 403 });
  await api(a.owner_token, 'POST', `/agents/connections/${a.installation_id}/channels/${dm.id}`, { enabled: true }, 403);
  await api(a.owner_token, 'POST', `/channels/${dm.id}/memory/settings`, { enabled: true }, 403);
  await api(a.owner_token, 'DELETE', `/workspaces/${a.workspace_id}/members/${a.collaborator_id}`, undefined, 204);
  await api(a.collaborator_token, 'GET', `/channels/${dm.id}`, undefined, 404);
  await api(a.owner_token, 'POST', `/channels/${dm.id}/messages`, { client_message_id: randomUUID(), text: 'Inactive peer' }, 409);
});

test('concurrent sends, replies and reactions retain ordered history and idempotency conflicts', async () => {
  const a = await bootstrap(pool), dm = await open(a);
  const request = { client_message_id: randomUUID(), text: 'Original' };
  const root = await api(a.owner_token, 'POST', `/channels/${dm.id}/messages`, request, 201);
  await api(a.owner_token, 'POST', `/channels/${dm.id}/messages`, { ...request, text: 'Changed' }, 409);
  const pair = await Promise.all([
    api(a.owner_token, 'POST', `/channels/${dm.id}/messages`, { client_message_id: randomUUID(), text: 'One' }, 201),
    api(a.collaborator_token, 'POST', `/channels/${dm.id}/messages`, { client_message_id: randomUUID(), text: 'Two' }, 201),
  ]);
  assert.notEqual(pair[0].sequence, pair[1].sequence);
  await Promise.all([a.owner_token, a.collaborator_token].map(token => api(token, 'POST', `/channels/${dm.id}/messages/${root.id}/reactions`, { emoji: '👍', active: true })));
  const history = await api(a.owner_token, 'GET', `/channels/${dm.id}/messages`);
  assert.equal(history.messages[0].reactions[0].count, 2);
  await api(a.collaborator_token, 'POST', `/channels/${dm.id}/messages`, { client_message_id: randomUUID(), thread_id: root.thread_id, text: 'Reply' }, 201);
  assert.equal((await api(a.owner_token, 'GET', `/threads/${root.thread_id}/messages`)).length, 2);
  const self = await open(a, a.owner_id);
  await api(a.owner_token, 'POST', `/channels/${self.id}/messages`, { client_message_id: randomUUID(), text: 'A note to myself' }, 201);
  assert.equal((await api(a.owner_token, 'GET', `/workspaces/${a.workspace_id}/unread`)).channels.find((row: any) => row.channel_id === self.id).unread_count, 0);
});
test('inbox sorts by latest activity with a scoped stable cursor', async () => {
  const a = await bootstrap(pool), first = await open(a), second = await open(a, a.owner_id);
  const [older, latest] = [first, second].sort((left, right) => left.id.localeCompare(right.id));
  await api(a.owner_token, 'POST', `/channels/${older.id}/messages`, { client_message_id: randomUUID(), text: 'Earlier' }, 201);
  await api(a.owner_token, 'POST', `/channels/${latest.id}/messages`, { client_message_id: randomUUID(), text: 'Latest activity' }, 201);
  const newest = await inbox(a, a.owner_token, '?limit=1');
  assert.equal(newest.items[0].id, latest.id);
  assert.equal((await inbox(a, a.owner_token, `?limit=1&after=${newest.next_cursor}`)).items[0].id, older.id);
});
test('database invariants protect canonical DM pairs, participants and agent grants', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool), dm = await open(a);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')", [a.workspace_id, b.owner_id]);
  await assert.rejects(pool.query('INSERT INTO channel_members(workspace_id,channel_id,user_id) VALUES($1,$2,$3)', [a.workspace_id, dm.id, b.owner_id]), { code: '23514' });
  await assert.rejects(pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2', [dm.id, a.owner_id]), { code: '23514' });
  const other = await api(a.owner_token, 'POST', `/workspaces/${a.workspace_id}/channels`, { name: 'Unrelated', private: false }, 201);
  await assert.rejects(pool.query('UPDATE channel_members SET channel_id=$1 WHERE channel_id=$2 AND user_id=$3', [other.id, dm.id, a.collaborator_id]), { code: '23514' });
  await assert.rejects(pool.query('UPDATE channels SET private=false WHERE id=$1', [dm.id]), { code: '23514' });
  await assert.rejects(pool.query('INSERT INTO agent_grants(workspace_id,installation_id,channel_id,skill) VALUES($1,$2,$3,$4)', [a.workspace_id, a.installation_id, dm.id, 'demo.echo']), { code: '23514' });
});

test('DM mentions stay within participants before search limits and reject forged outsider targets', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool), dm = await open(a);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')", [a.workspace_id,b.owner_id]);
  await pool.query(`WITH people AS (INSERT INTO users(id,display_name) SELECT gen_random_uuid(),'AAA stranger '||n FROM generate_series(1,35) n RETURNING id)
    INSERT INTO workspace_members(workspace_id,user_id,role) SELECT $1,id,'member' FROM people`, [a.workspace_id]);
  const mentions = await api(a.owner_token, 'GET', `/channels/${dm.id}/mentions`);
  assert.deepEqual(mentions.items.filter((row: any) => row.kind === 'user').map((row: any) => row.id).sort(), [a.owner_id,a.collaborator_id].sort());
  await api(a.owner_token, 'GET', `/channels/${dm.id}/mentions/user/${b.owner_id}`, undefined, 404);
  await api(a.owner_token, 'POST', `/channels/${dm.id}/messages`, { client_message_id: randomUUID(), text: '@Demo owner secret', document: { ops: [
    { insert: '@Demo owner', attributes: { mention: { kind: 'user', id: b.owner_id, label: 'Demo owner' } } }, { insert: ' secret' },
  ] } }, 404);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM mention_notifications WHERE channel_id=$1 AND user_id=$2',[dm.id,b.owner_id])).rows[0].n,0);
});
test('DM attachment creation is bounded and attachment binding/download require membership', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool), dm = await open(a), assets = new AssetStore(pool);
  await assert.rejects(assets.create(b.owner_id, dm.id, { name: 'secret.txt', size: 1 }), { status: 404 });
  const statements: string[] = [], originals = new Map<PoolClient, PoolClient['query']>();
  const trace = (client: PoolClient) => {
    if (originals.has(client)) return;
    const query = client.query; originals.set(client,query);
    client.query = function(this: PoolClient, ...args: any[]) { statements.push(typeof args[0] === 'string' ? args[0] : args[0]?.text ?? ''); return (query as Function).apply(this,args); } as PoolClient['query'];
  };
  pool.on('acquire',trace);
  let asset: Awaited<ReturnType<AssetStore['create']>>;
  try { asset = await assets.create(a.owner_id, dm.id, { name: 'secret.txt', size: 1 }); }
  finally { pool.off('acquire',trace); for (const [client,query] of originals) client.query=query; }
  assert.ok(statements.every(statement=>!/(?:FOR (?:UPDATE|SHARE)|pg_advisory)/i.test(statement)), 'DM asset allocation must not issue explicit locks');
  await assert.rejects(assets.complete(a.collaborator_id, asset.id, async () => ({ kind: 'text', text: 'x', language: 'plaintext', truncated: false })), { status: 404 });
  await assets.complete(a.owner_id, asset.id, async () => ({ kind: 'text', text: 'x', language: 'plaintext', truncated: false }));
  await assert.rejects(assets.download(a.collaborator_id,asset.id), { status: 404 });
  await api(a.collaborator_token, 'POST', `/channels/${dm.id}/messages`, { client_message_id: randomUUID(), text: '', asset_ids: [asset.id] }, 409);
  const message = await api(a.owner_token, 'POST', `/channels/${dm.id}/messages`, { client_message_id: randomUUID(), text: '', asset_ids: [asset.id] }, 201);
  assert.equal(message.attachments[0].id,asset.id);
  assert.equal((await assets.download(a.collaborator_id,asset.id)).id,asset.id);
  await assert.rejects(assets.download(b.owner_id,asset.id), { status: 404 });
  assert.equal((await api(a.collaborator_token, 'GET', `/channels/${dm.id}/assets`)).items[0].id,asset.id);
  for (let i=0;i<19;i++) await assets.create(a.owner_id,dm.id,{name:'pending.txt',size:1});
  const competing = await Promise.allSettled([assets.create(a.owner_id,dm.id,{name:'one.txt',size:1}), assets.create(a.owner_id,a.channel_id,{name:'two.txt',size:1})]);
  assert.equal(competing.filter(result=>result.status==='fulfilled').length,1);
  const pending = await pool.query('SELECT count(*)::int AS n FROM assets WHERE workspace_id=$1 AND uploader_id=$2 AND message_id IS NULL',[a.workspace_id,a.owner_id]);
  assert.equal(pending.rows[0].n,20);
});
test('pagination keeps its original boundary when the anchor receives a new message', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')", [a.workspace_id,b.owner_id]);
  const newest = await open(a), anchor = await open(a,a.owner_id), older = await open(a,b.owner_id);
  for (const [id,at] of [[newest.id,'2025-01-01T00:00:00.123458Z'],[anchor.id,'2025-01-01T00:00:00.123457Z'],[older.id,'2025-01-01T00:00:00.123456Z']]) {
    await pool.query('UPDATE direct_message_views SET last_activity_at=$1 WHERE channel_id=$2',[at,id]);
  }
  const first = await inbox(a,a.owner_token,'?limit=2');
  assert.deepEqual(first.items.map((row: any)=>row.id),[newest.id,anchor.id]);
  await api(a.owner_token,'POST',`/channels/${anchor.id}/messages`,{client_message_id:randomUUID(),text:'Anchor moved to the top'},201);
  const second = await inbox(a,a.owner_token,`?limit=2&after=${first.next_cursor}`);
  assert.deepEqual(second.items.map((row: any)=>row.id),[older.id]);
  assert.equal(second.next_cursor,null);
  await api(b.owner_token,'GET',`/workspaces/${b.workspace_id}/direct-messages?after=${first.next_cursor}`,undefined,400);
  for (const value of ['not-a-cursor',Buffer.from(JSON.stringify({at:'2025-02-30T00:00:00.123456Z',id:anchor.id})).toString('base64url')]) {
    await api(a.owner_token,'GET',`/workspaces/${a.workspace_id}/direct-messages?after=${value}`,undefined,400);
  }
});

test('DM source messages use chat authorization while memory stays forbidden',async()=>{
 const a=await bootstrap(pool),b=await bootstrap(pool),dm=await open(a);
 const message=await api(a.owner_token,'POST',`/channels/${dm.id}/messages`,{client_message_id:randomUUID(),text:'Source from Activity'},201);
 for(const token of [a.owner_token,a.collaborator_token])assert.deepEqual(await api(token,'GET',`/channels/${dm.id}/messages/${message.id}`),message);
 await api(b.owner_token,'GET',`/channels/${dm.id}/messages/${message.id}`,undefined,404);
 await api(a.owner_token,'GET',`/channels/${a.channel_id}/messages/${message.id}`,undefined,404);
 await api(a.owner_token,'GET',`/channels/${dm.id}/messages/${randomUUID()}`,undefined,404);
 await api(a.owner_token,'GET',`/channels/${dm.id}/memory`,undefined,403);
 await api(a.owner_token,'POST',`/channels/${dm.id}/memory/settings`,{enabled:true},403);
 await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[a.workspace_id,a.collaborator_id]);
 await api(a.collaborator_token,'GET',`/channels/${dm.id}/messages/${message.id}`,undefined,404);
});
