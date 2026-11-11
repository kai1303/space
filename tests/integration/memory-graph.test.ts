import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';
import { readSessionMemoryForPerson } from '@space/postgres/layered-memory';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
const schema = `memory_graph_${randomBytes(6).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const directory = await mkdtemp(join(tmpdir(), 'space-memory-graph-'));
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, memory: { directory } });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); await app.ready(); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(directory, { recursive: true, force: true }); });

async function api(token: string, method: 'GET' | 'POST', path: string, payload?: object, expected = 200) {
  const response = await app.inject({ method, url: `/v1${path}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  assert.equal(response.statusCode, expected, response.body); return response.json();
}
async function post(token: string, channel: string, text: string, thread?: string) {
  return api(token, 'POST', `/channels/${channel}/messages`, { client_message_id: randomUUID(), text, ...(thread ? { thread_id: thread } : {}) }, 201);
}
async function addSession(a: { workspace_id: string; installation_id: string }, thread: string) {
  const id = randomUUID();
  await pool.query(`INSERT INTO agent_sessions(id,workspace_id,installation_id,origin_thread_id,title) VALUES($1,$2,$3,$4,'Fix fixture')`, [id, a.workspace_id, a.installation_id, thread]);
  return id;
}
const db = () => new PostgresStore(pool).db;

test('people read any session in a thread they can see, including ended ones', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Start');
  const session = await addSession(a, root.thread_id);
  const read = await readSessionMemoryForPerson(db(), a.channel_id, session);
  assert.equal(read.node.title, 'Fix fixture');
  await pool.query(`UPDATE agent_sessions SET state='ended' WHERE id=$1`, [session]);
  assert.equal((await readSessionMemoryForPerson(db(), a.channel_id, session)).node.state, 'ended');
});

test('routes: members read, nobody writes, and access is enforced', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Dedupe fix');
  const session = await addSession(a, root.thread_id);
  const base = `/channels/${a.channel_id}`;

  const page = await api(a.collaborator_token, 'GET', `${base}/memory/layers`);
  assert.equal(page.nodes[0].summary, 'Dedupe fix');
  const thread = await api(a.collaborator_token, 'GET', `${base}/threads/${root.thread_id}/memory?q=dedupe`);
  assert.equal(thread.sessions.length, 1);
  const read = await api(a.collaborator_token, 'GET', `${base}/agent-sessions/${session}/memory`);
  assert.equal(read.node.ref.id, session);

  for (const url of [`${base}/threads/${root.thread_id}/memory`, `${base}/agent-sessions/${session}/memory`]) {
    const write = await app.inject({ method: 'POST', url: `/v1${url}`, headers: { authorization: `Bearer ${a.owner_token}` }, payload: { revision: 0, summary: 'x', content: 'y' } });
    assert.ok([404, 405].includes(write.statusCode), `memory cannot be written: ${write.statusCode}`);
  }
  await api(b.owner_token, 'GET', `${base}/memory/layers`, undefined, 404);
  await api(a.owner_token, 'GET', `/channels/${b.channel_id}/agent-sessions/${session}/memory`, undefined, 404);
  await api(a.owner_token, 'GET', `${base}/memory/layers?after=bad!`, undefined, 400);
  await api(a.owner_token, 'GET', `${base}/memory/layers?unknown=1`, undefined, 400);
});
