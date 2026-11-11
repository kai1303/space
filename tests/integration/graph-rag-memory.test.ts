import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
const schema = `graph_rag_${randomBytes(6).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

const post = async (token: string, channel: string, text: string) => {
  const r = await app.inject({ method: 'POST', url: `/v1/channels/${channel}/messages`, headers: { authorization: `Bearer ${token}` }, payload: { client_message_id: randomUUID(), text } });
  assert.equal(r.statusCode, 201, r.body); return r.json();
};
const visible = async (w: string, requester: string, destination: string, ids: string[]) =>
  (await pool.query('SELECT id, body FROM memory_visible_messages($1,$2,$3,$4::uuid[])', [w, requester, destination, ids])).rows;
const inSource = async (id: string) => (await pool.query('SELECT 1 FROM memory_source_messages WHERE id=$1', [id])).rowCount;

test('memory_source_messages follows the memory switch, deletes and archive; memory_visible_messages checks membership', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const m = await post(a.owner_token, a.channel_id, 'Hello world');
  assert.equal(await inSource(m.id), 0, 'off by default');
  await pool.query('UPDATE channels SET memory_enabled=true WHERE id=$1', [a.channel_id]);
  assert.equal(await inSource(m.id), 1);
  assert.deepEqual((await visible(a.workspace_id, a.owner_id, a.channel_id, [m.id])).map(r => r.id), [m.id]);
  assert.deepEqual(await visible(a.workspace_id, randomUUID(), a.channel_id, [m.id]), [], 'a stranger sees nothing');
  assert.deepEqual(await visible(b.workspace_id, b.owner_id, b.channel_id, [m.id]), [], 'another workspace sees nothing');
  assert.deepEqual(await visible(a.workspace_id, a.owner_id, b.channel_id, [m.id]), [], 'only the message channel can be the destination');

  await pool.query('UPDATE channels SET archived_at=now() WHERE id=$1', [a.channel_id]);
  assert.equal(await inSource(m.id), 0, 'archived channels leave the view');
  await pool.query('UPDATE channels SET archived_at=NULL WHERE id=$1', [a.channel_id]);
  const removed = await app.inject({ method: 'DELETE', url: `/v1/channels/${a.channel_id}/messages/${m.id}`, headers: { authorization: `Bearer ${a.owner_token}` } });
  assert.ok(removed.statusCode < 300, removed.body);
  assert.equal(await inSource(m.id), 0, 'deleted messages leave the view');
  assert.deepEqual(await visible(a.workspace_id, a.owner_id, a.channel_id, [m.id]), []);
});

test('graph_source_messages carries memory and knowledge flags', async () => {
  const a = await bootstrap(pool);
  const m = await post(a.owner_token, a.channel_id, 'Flagged');
  assert.equal((await pool.query('SELECT 1 FROM graph_source_messages WHERE id=$1', [m.id])).rowCount, 0, 'neither switch is on');
  await pool.query('UPDATE channels SET memory_enabled=true WHERE id=$1', [a.channel_id]);
  const [memoryOnly] = (await pool.query('SELECT memory, knowledge FROM graph_source_messages WHERE id=$1', [m.id])).rows;
  assert.deepEqual([memoryOnly.memory, memoryOnly.knowledge], [true, false]);
  await pool.query('INSERT INTO knowledge_thread_channels(workspace_id,channel_id) VALUES($1,$2)', [a.workspace_id, a.channel_id]);
  const [both] = (await pool.query('SELECT memory, knowledge FROM graph_source_messages WHERE id=$1', [m.id])).rows;
  assert.deepEqual([both.memory, both.knowledge], [true, true]);
  await pool.query('UPDATE channels SET memory_enabled=false WHERE id=$1', [a.channel_id]);
  const [knowledgeOnly] = (await pool.query('SELECT memory, knowledge FROM graph_source_messages WHERE id=$1', [m.id])).rows;
  assert.deepEqual([knowledgeOnly.memory, knowledgeOnly.knowledge], [false, true]);
});
