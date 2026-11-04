import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { io, type Socket } from 'socket.io-client';
import { RedisSocketAdapter } from '@space/redis';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate, migrationFiles } from '@space/postgres/migrate';
import { ChatStore } from '@space/postgres/chat';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';

const schema = `unread_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const adapters = [new RedisSocketAdapter(process.env.TEST_REDIS_URL, schema), new RedisSocketAdapter(process.env.TEST_REDIS_URL, schema)];
const apps = adapters.map(adapter => createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, realtime: { adapter, } }));
let addresses: string[];
before(async () => {
  if (!process.env.TEST_DATABASE_URL) throw Error('TEST_DATABASE_URL required');
  await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool);
  await Promise.all(adapters.map(adapter => adapter.connect()));
  addresses = await Promise.all(apps.map(app => app.listen({ host: '127.0.0.1', port: 0 })));
});
after(async () => { await Promise.all(apps.map(app => app.close())); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
async function api(token: string, method: 'GET' | 'POST', path: string, payload?: object, status = 200) {
  const response = await apps[0]!.inject({ method, url: `/v1${path}`, headers: { authorization: `Bearer ${token}` }, payload });
  assert.equal(response.statusCode, status, `${path}: ${response.body}`); return response.json();
}
const send = (token: string, channel: string, text = 'Hello') => api(token, 'POST', `/channels/${channel}/messages`, { client_message_id: randomUUID(), text }, 201);
const summary = (token: string, workspace: string) => api(token, 'GET', `/workspaces/${workspace}/unread`);
const read = (token: string, channel: string, sequence: string) => api(token, 'POST', `/channels/${channel}/read`, { sequence });

test('read positions belong to each authenticated user, exclude own messages, and never regress', async () => {
  const a = await bootstrap(pool);
  const one = await send(a.owner_token, a.channel_id), two = await send(a.owner_token, a.channel_id);
  const count = async (token: string) => (await summary(token, a.workspace_id)).channels.find((c: any) => c.channel_id === a.channel_id);
  assert.equal((await count(a.owner_token)).unread_count, 0);
  assert.equal((await count(a.collaborator_token)).unread_count, 2);
  await read(a.collaborator_token, a.channel_id, one.sequence);
  assert.equal((await count(a.collaborator_token)).unread_count, 1);
  const reply = await send(a.collaborator_token, a.channel_id);
  assert.equal((await count(a.owner_token)).unread_count, 1);
  await Promise.all([read(a.collaborator_token, a.channel_id, reply.sequence), read(a.collaborator_token, a.channel_id, two.sequence)]);
  await read(a.collaborator_token, a.channel_id, '0');
  assert.equal((await count(a.collaborator_token)).last_read_sequence, reply.sequence);
  assert.equal((await count(a.collaborator_token)).unread_count, 0);
  assert.equal((await count(a.collaborator_token)).latest_sequence, reply.sequence, 'latest message remains available after it is read');
  assert.equal((await count(a.owner_token)).unread_count, 1, 'another user reading must not clear the owner');
  await migrate(pool);
  assert.equal((await count(a.owner_token)).unread_count, 1, 'migration reruns preserve read state');
});

test('validates cursors and rejects spoofed actors, unjoined channels and other workspaces', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const m = await send(a.owner_token, a.channel_id);
  await api(b.owner_token, 'GET', `/workspaces/${a.workspace_id}/unread`, undefined, 404);
  await api(b.owner_token, 'POST', `/channels/${a.channel_id}/read`, { sequence: m.sequence }, 404);
  for (const payload of [{}, { sequence: '-1' }, { sequence: 1 }, { sequence: '9223372036854775808' }, { sequence: m.sequence, user_id: a.owner_id }, { sequence: '999999' }]) {
    await api(a.collaborator_token, 'POST', `/channels/${a.channel_id}/read`, payload, 400);
  }
  const ch = await api(a.owner_token, 'POST', `/workspaces/${a.workspace_id}/channels`, { name: 'Elsewhere', private: false }, 201);
  await api(a.collaborator_token, 'POST', `/channels/${ch.id}/read`, { sequence: '0' }, 404);
  assert.ok(!(await summary(a.collaborator_token, a.workspace_id)).channels.some((c: any) => c.channel_id === ch.id));
  await api(a.owner_token, 'POST', `/channels/${ch.id}/read`, { sequence: m.sequence }, 400);
});
test('channel unread counts follow the main timeline rather than replies hidden in thread panels', async () => {
  const a = await bootstrap(pool);
  const root = await send(a.owner_token, a.channel_id);
  await read(a.collaborator_token, a.channel_id, root.sequence);
  await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), thread_id: root.thread_id, text: 'Thread reply' }, 201);
  const state = (await summary(a.collaborator_token, a.workspace_id)).channels.find((c: any) => c.channel_id === a.channel_id);
  assert.equal(state.unread_count, 0);
  assert.equal(state.latest_sequence, root.sequence);
  await send(a.owner_token, a.channel_id, 'New main conversation');
  assert.equal((await summary(a.collaborator_token, a.workspace_id)).channels.find((c: any) => c.channel_id === a.channel_id).unread_count, 1);
});

test('joining starts at current history; revocation hides private state and rejoining resets the baseline', async () => {
  const a = await bootstrap(pool);
  const ch = await api(a.owner_token, 'POST', `/workspaces/${a.workspace_id}/channels`, { name: 'Private', private: true }, 201);
  await send(a.owner_token, ch.id, 'Before joining');
  const join = () => api(a.owner_token, 'POST', `/channels/${ch.id}/members`, { user_id: a.collaborator_id }, 201);
  const count = async () => (await summary(a.collaborator_token, a.workspace_id)).channels.find((c: any) => c.channel_id === ch.id);
  await join(); assert.equal((await count()).unread_count, 0);
  await send(a.owner_token, ch.id); assert.equal((await count()).unread_count, 1);
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2', [ch.id, a.collaborator_id]);
  assert.equal(await count(), undefined);
  await api(a.collaborator_token, 'POST', `/channels/${ch.id}/read`, { sequence: '0' }, 404);
  await join(); assert.equal((await count()).unread_count, 0);
});

test('migration baselines historical messages without losing future unread messages', async () => {
  const legacySchema = `unread_legacy_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${legacySchema}`);
  const legacy = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${legacySchema}` });
  try {
    const tx = await legacy.connect();
    try {
      await tx.query('BEGIN');
      for (const file of migrationFiles.slice(0, migrationFiles.indexOf('027_channel_reads.sql'))) await tx.query(await readFile(new URL(`../../adapters/postgres/migrations/${file}`, import.meta.url), 'utf8'));
      await tx.query('COMMIT');
    } finally { tx.release(); }
    // Seed only historical columns: current ORM metadata includes later workspace fields.
    const a = { workspace_id: randomUUID(), channel_id: randomUUID(), thread_id: randomUUID(), owner_id: randomUUID(), collaborator_id: randomUUID() };
    await legacy.query('INSERT INTO users(id,display_name) VALUES($1,$2),($3,$4)', [a.owner_id,'Migration owner',a.collaborator_id,'Migration reader']);
    await legacy.query("INSERT INTO workspaces(id,name) VALUES($1,'Historical')", [a.workspace_id]);
    await legacy.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [a.workspace_id,a.owner_id,a.collaborator_id]);
    await legacy.query("INSERT INTO channels(id,workspace_id,name,private,created_by) VALUES($1,$2,'general',false,$3)", [a.channel_id,a.workspace_id,a.owner_id]);
    await legacy.query('INSERT INTO channel_members(workspace_id,channel_id,user_id) VALUES($1,$2,$3),($1,$2,$4)', [a.workspace_id,a.channel_id,a.owner_id,a.collaborator_id]);
    await legacy.query('INSERT INTO threads(id,workspace_id,channel_id) VALUES($1,$2,$3)', [a.thread_id,a.workspace_id,a.channel_id]);
    await legacy.query(`INSERT INTO messages(id,workspace_id,channel_id,thread_id,author_type,user_id,client_message_id,request_hash,text)
      VALUES($1,$2,$3,$4,'human',$5,$6,'legacy','Historical')`, [randomUUID(),a.workspace_id,a.channel_id,a.thread_id,a.owner_id,randomUUID()]);
    await legacy.query(await readFile(new URL('../../adapters/postgres/migrations/027_channel_reads.sql', import.meta.url), 'utf8'));
    const baseline = (await legacy.query('SELECT cr.last_read_sequence,ch.event_sequence FROM channel_reads cr JOIN channels ch ON ch.id=cr.channel_id WHERE cr.channel_id=$1 AND cr.user_id=$2', [a.channel_id,a.collaborator_id])).rows[0];
    assert.ok(baseline);
    assert.equal(baseline.last_read_sequence, baseline.event_sequence);
    for (const file of migrationFiles.slice(migrationFiles.indexOf('027_channel_reads.sql') + 1)) await legacy.query(await readFile(new URL(`../../adapters/postgres/migrations/${file}`, import.meta.url), 'utf8'));
    const chat = new ChatStore(legacy);
    assert.equal((await chat.unread.summary(a.collaborator_id, a.workspace_id)).channels[0]!.unread_count, 0);
    const next = await chat.send(a.owner_id, a.channel_id, { client_message_id: randomUUID(), text: 'After migration' });
    await chat.react(a.collaborator_id, a.channel_id, next.id, { emoji: '👍', active: true });
    assert.equal((await chat.unread.summary(a.collaborator_id, a.workspace_id)).channels[0]!.unread_count, 1, 'reactions must not count as new messages');
  } finally { await legacy.end(); await admin.query(`DROP SCHEMA ${legacySchema} CASCADE`); }
});

async function subscriber(token: string, workspace: string, server = 0) {
  const socket: Socket = io(addresses[server], { transports: ['websocket'], auth: { token }, reconnection: false, autoConnect: false });
  const snapshots: any[] = [];
  socket.on('workspace.unread', (snapshot, ack) => { snapshots.push(snapshot); ack(); });
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
  const result = await socket.timeout(2000).emitWithAck('workspace.subscribe', { workspace_id: workspace });
  assert.ok(result.data, JSON.stringify(result));
  return { socket, snapshots, wait: async (predicate: (snapshot: any) => boolean) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { const index = snapshots.findIndex(predicate); if (index >= 0) return snapshots.splice(index, 1)[0]; await delay(10); }
    assert.fail('timed out waiting for authoritative unread snapshot');
  } };
}
test('workspace realtime covers unopened channels, syncs devices across servers, and recovers after reconnect', async () => {
  const a = await bootstrap(pool);
  const ch = await api(a.owner_token, 'POST', `/workspaces/${a.workspace_id}/channels`, { name: 'Other channel', private: false }, 201);
  await api(a.collaborator_token, 'POST', `/channels/${ch.id}/join`, {});
  const one = await subscriber(a.collaborator_token, a.workspace_id), two = await subscriber(a.collaborator_token, a.workspace_id, 1), owner = await subscriber(a.owner_token, a.workspace_id);
  const hasCount = (count: number) => (s: any) => s.workspace_id === a.workspace_id && s.channels.some((c: any) => c.channel_id === ch.id && c.unread_count === count);
  try {
    await Promise.all([one.wait(hasCount(0)), two.wait(hasCount(0)), owner.wait(hasCount(0))]);
    const message = await send(a.owner_token, ch.id);
    await Promise.all([one.wait(hasCount(1)), two.wait(hasCount(1))]);
    await read(a.collaborator_token, ch.id, message.sequence);
    await Promise.all([one.wait(hasCount(0)), two.wait(hasCount(0))]);
    assert.ok(owner.snapshots.every(hasCount(0)), 'one user must never receive another user’s count');
    two.socket.disconnect(); await send(a.owner_token, ch.id, 'While offline');
    const resumed = await subscriber(a.collaborator_token, a.workspace_id, 1);
    try { await resumed.wait(hasCount(1)); } finally { resumed.socket.disconnect(); }
    const revoked = new Promise<any>(resolve => one.socket.once('workspace.revoked', resolve));
    await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2', [a.workspace_id, a.collaborator_id]);
    const notification = await Promise.race([revoked, delay(5000).then(() => { throw Error('workspace subscription was not revoked'); })]);
    assert.deepEqual(notification, {workspace_id:a.workspace_id,error:'not_found'});
    assert.equal(one.socket.connected,true,'scoped revocation must preserve the shared connection');
  } finally { one.socket.disconnect(); two.socket.disconnect(); owner.socket.disconnect(); }
});

test('thread-only replies do not create channel unread badges that the channel cannot clear',async()=>{
  const a=await bootstrap(pool);
  const root=await send(a.owner_token,a.channel_id,'Root');
  await read(a.collaborator_token,a.channel_id,root.sequence);
  await api(a.owner_token,'POST',`/channels/${a.channel_id}/messages`,{client_message_id:randomUUID(),thread_id:root.thread_id,text:'Only in thread'},201);
  const state=(await summary(a.collaborator_token,a.workspace_id)).channels.find((c:any)=>c.channel_id===a.channel_id);
  assert.equal(state.unread_count,0);
  assert.equal(state.latest_sequence,root.sequence);
});
