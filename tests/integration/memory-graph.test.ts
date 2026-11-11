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
import { saveTurnMemory } from '@space/postgres/layered-memory';

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
async function agentSave(a: { channel_id: string; installation_id: string }, thread: string, session: string | null, part: 'thread' | 'session', revision: number, summary: string) {
  return saveTurnMemory(db(), { channelId: a.channel_id, threadId: thread, sessionId: session, installationId: a.installation_id, producer: { id: a.installation_id, name: 'Codex' },
    memory: { [part]: { base_revision: revision, summary, content: `# ${summary}` } } });
}

test('a memory insert enqueues one channel metadata delivery', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Start');
  const count = async () => (await pool.query(`SELECT count(*)::int AS n FROM chat_delivery_outbox WHERE channel_id=$1 AND resource_scope='metadata'`, [a.channel_id])).rows[0].n as number;
  const before = await count();
  await agentSave(a, root.thread_id, null, 'thread', 0, 'First');
  assert.equal(await count() - before, 1);
});

import { readSessionMemoryForPerson, writeThreadMemoryForPerson, writeSessionMemoryForPerson } from '@space/postgres/layered-memory';

test('person variants read any session and write with the person as producer', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Start');
  const session = await addSession(a, root.thread_id);
  const person = { id: a.owner_id, name: 'Demo owner' };
  const thread = await writeThreadMemoryForPerson(db(), a.channel_id, root.thread_id, { revision: 0, summary: 'Edited', content: '# Fixed by a person' }, person);
  assert.equal(thread.revision, 1);
  assert.equal(thread.producer_name, 'Demo owner');
  const own = await writeSessionMemoryForPerson(db(), a.channel_id, session, { revision: 0, summary: 'Session edit', content: 'x' }, person);
  assert.equal(own.revision, 1);
  const read = await readSessionMemoryForPerson(db(), a.channel_id, session);
  assert.equal(read.memory?.summary, 'Session edit');
  await assert.rejects(writeThreadMemoryForPerson(db(), a.channel_id, root.thread_id, { revision: 0, summary: 'Stale', content: 'y' }, person), (e: any) => e.code === 'thread_memory_conflict');
  await pool.query(`UPDATE agent_sessions SET state='ended' WHERE id=$1`, [session]);
  assert.equal((await readSessionMemoryForPerson(db(), a.channel_id, session)).node.state, 'ended');
  await assert.rejects(writeSessionMemoryForPerson(db(), a.channel_id, session, { revision: 1, summary: 'Late', content: 'z' }, person), (e: any) => e.code === 'session_ended');
});

test('routes: members read, managers edit, conflicts and access are enforced', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Dedupe fix');
  const session = await addSession(a, root.thread_id);
  await agentSave(a, root.thread_id, session, 'thread', 0, 'Dedupe fix · in progress');
  const base = `/channels/${a.channel_id}`;

  const page = await api(a.collaborator_token, 'GET', `${base}/memory/layers`);
  assert.equal(page.nodes[0].summary, 'Dedupe fix · in progress');
  const thread = await api(a.collaborator_token, 'GET', `${base}/threads/${root.thread_id}/memory`);
  assert.equal(thread.sessions.length, 1);
  const read = await api(a.collaborator_token, 'GET', `${base}/agent-sessions/${session}/memory`);
  assert.equal(read.node.ref.id, session);

  await api(a.collaborator_token, 'POST', `${base}/threads/${root.thread_id}/memory`, { revision: 1, summary: 'Nope', content: 'x' }, 403);
  const saved = await api(a.owner_token, 'POST', `${base}/threads/${root.thread_id}/memory`, { revision: 1, summary: 'Edited by owner', content: '# Edited' });
  assert.equal(saved.revision, 2);
  assert.equal(saved.producer_name, 'Demo owner');
  const stale = await app.inject({ method: 'POST', url: `/v1${base}/threads/${root.thread_id}/memory`, headers: { authorization: `Bearer ${a.owner_token}` }, payload: { revision: 1, summary: 'Old', content: 'y' } });
  assert.equal(stale.statusCode, 409);
  assert.match(stale.body, /thread_memory_conflict/);
  await api(a.owner_token, 'POST', `${base}/threads/${root.thread_id}/memory`, { revision: 2, summary: 'x'.repeat(281), content: 'y' }, 400);
  await api(a.owner_token, 'POST', `${base}/agent-sessions/${session}/memory`, { revision: 0, summary: 'Session fixed', content: 'ok' });

  const outcome = await agentSave(a, root.thread_id, session, 'thread', 1, 'Agent on old revision');
  assert.deepEqual(outcome, [{ scope: 'thread', outcome: 'pending' }]);

  await api(b.owner_token, 'GET', `${base}/memory/layers`, undefined, 404);
  await api(a.owner_token, 'GET', `/channels/${b.channel_id}/agent-sessions/${session}/memory`, undefined, 404);
  await api(a.owner_token, 'GET', `${base}/memory/layers?after=bad!`, undefined, 400);
});
