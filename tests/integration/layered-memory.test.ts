import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';
import { readChannelMemory, readThreadMemory, readSessionMemory, writeSessionMemory, saveTurnMemory, readPendingMemory } from '@space/postgres/layered-memory';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
const schema = `layered_memory_${randomBytes(6).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const directory = await mkdtemp(join(tmpdir(), 'space-layered-memory-'));
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, memory: { directory } });
let address: string;
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); address = await app.listen({ host: '127.0.0.1', port: 0 }); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(directory, { recursive: true, force: true }); });

async function api(token: string, method: 'GET' | 'POST', path: string, payload?: object, expected = 200) {
  const response = await app.inject({ method, url: `/v1${path}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  assert.equal(response.statusCode, expected, response.body); return response.json();
}
async function post(token: string, channel: string, text: string, thread?: string) {
  return api(token, 'POST', `/channels/${channel}/messages`, { client_message_id: randomUUID(), text, ...(thread ? { thread_id: thread } : {}) }, 201);
}
async function connect(token: string) {
  const client = new Client({ name: 'layered-memory-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp/memory`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
function data(result: any) { assert.notEqual(result.isError, true, JSON.stringify(result)); return JSON.parse(result.content[0].text); }
function code(result: any) { assert.equal(result.isError, true, JSON.stringify(result)); return result.content[0].text as string; }

test('migration backfills summary and channel_id and allows session rows', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Start');
  const columns = (await pool.query(`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='memory_revisions'`, [schema])).rows;
  const byName = Object.fromEntries(columns.map(c => [c.column_name, c.is_nullable]));
  assert.equal(byName.summary, 'NO');
  assert.equal(byName.channel_id, 'NO');
  assert.equal(byName.session_id, 'YES');
  await pool.query(`INSERT INTO memory_revisions(thread_id,channel_id,revision,through_sequence,content,summary,source_message_ids,producer_id,producer_name)
    VALUES($1,$2,1,$3,'# A\nB','A',ARRAY[$4]::uuid[],$5,'x')`, [root.thread_id, a.channel_id, root.sequence, root.id, a.owner_id]);
  await assert.rejects(pool.query(`INSERT INTO memory_revisions(thread_id,channel_id,revision,through_sequence,content,summary,source_message_ids,producer_id,producer_name)
    VALUES($1,$2,1,$3,'dup','dup',ARRAY[$4]::uuid[],$5,'x')`, [root.thread_id, a.channel_id, root.sequence, root.id, a.owner_id]), /duplicate key/);
});

async function threadKey(token: string, channel: string, thread: string, access: 'read' | 'write' = 'write') {
  return (await api(token, 'POST', `/channels/${channel}/threads/${thread}/context/connections`, { name: `Agent ${randomUUID().slice(0, 8)}`, access }, 201)).token as string;
}

test('concurrent thread memories: one wins, the other gets 409, both revisions stay readable', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Start');
  const client = await connect(await threadKey(a.owner_token, a.channel_id, root.thread_id));
  try {
    const context = data(await client.callTool({ name: 'thread_context', arguments: {} }));
    const input = { revision: 0, through_sequence: context.through_sequence, content: '# Decisions\nA', summary: 'A', source_message_ids: [root.id] };
    const results = await Promise.all([
      client.callTool({ name: 'thread_memory_save', arguments: input }),
      client.callTool({ name: 'thread_memory_save', arguments: { ...input, content: '# Decisions\nB', summary: 'B' } }),
    ]);
    assert.equal(results.filter(r => !r.isError).length, 1);
    assert.equal(code(results.find(r => r.isError)), 'thread_memory_conflict');
    const second = data(await client.callTool({ name: 'thread_memory_save', arguments: { ...input, revision: 1, summary: 'C' } }));
    assert.equal(second.revision, 2);
    const stored = await pool.query('SELECT revision FROM memory_revisions WHERE thread_id=$1 AND session_id IS NULL ORDER BY revision', [root.thread_id]);
    assert.deepEqual(stored.rows.map(r => r.revision), [1, 2]);
  } finally { await client.close(); }
});

test('thread memory validates summary and size with stable codes', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Start');
  const client = await connect(await threadKey(a.owner_token, a.channel_id, root.thread_id));
  try {
    const context = data(await client.callTool({ name: 'thread_context', arguments: {} }));
    const input = { revision: 0, through_sequence: context.through_sequence, content: 'ok', summary: 'ok', source_message_ids: [root.id] };
    assert.equal(code(await client.callTool({ name: 'thread_memory_save', arguments: { ...input, content: 'x'.repeat(6001) } })), 'memory_content_too_large');
    assert.equal(code(await client.callTool({ name: 'thread_memory_save', arguments: { ...input, summary: 'x'.repeat(281) } })), 'invalid_summary');
    assert.equal(code(await client.callTool({ name: 'thread_memory_save', arguments: { ...input, revision: 5 } })), 'thread_memory_conflict');
  } finally { await client.close(); }
});

const db = () => new PostgresStore(pool).db;
async function seedMemory(channel: string, thread: string, message: { id: string; sequence: string }, owner: string, summary: string, at?: string) {
  await pool.query(`INSERT INTO memory_revisions(thread_id,channel_id,revision,through_sequence,content,summary,source_message_ids,producer_id,producer_name,created_at)
    VALUES($1,$2,coalesce((SELECT max(revision) FROM memory_revisions WHERE thread_id=$1 AND session_id IS NULL),0)+1,$3,$4,$4,ARRAY[$5]::uuid[],$6,'seed',coalesce($7::timestamptz,now()))`,
    [thread, channel, message.sequence, summary, message.id, owner, at ?? null]);
}
async function addSession(a: { workspace_id: string; installation_id: string }, thread: string, installation = a.installation_id, title = 'Run') {
  const id = randomUUID();
  await pool.query(`INSERT INTO agent_sessions(id,workspace_id,installation_id,origin_thread_id,title) VALUES($1,$2,$3,$4,$5)`, [id, a.workspace_id, installation, thread, title]);
  return id;
}

test('channel index: 7-day window, newest first, stable keyset paging under writes', async () => {
  const a = await bootstrap(pool);
  const roots = [];
  for (let i = 0; i < 60; i++) {
    const root = await post(a.owner_token, a.channel_id, `Thread ${i}`);
    await seedMemory(a.channel_id, root.thread_id, root, a.owner_id, `S${i}`, new Date(Date.now() - (60 - i) * 60_000).toISOString());
    roots.push(root);
  }
  const old = await post(a.owner_token, a.channel_id, 'Old');
  await seedMemory(a.channel_id, old.thread_id, old, a.owner_id, 'Old', new Date(Date.now() - 8 * 86_400_000).toISOString());
  const first = await readChannelMemory(db(), a.channel_id, undefined, 50);
  assert.equal(first.nodes.length, 50);
  assert.equal(first.nodes[0]!.summary, 'S59');
  assert.equal(first.nodes[0]!.parent?.kind, 'channel');
  assert.ok(first.next_cursor);
  await seedMemory(a.channel_id, roots[0]!.thread_id, roots[0]!, a.owner_id, 'S0 updated');
  const second = await readChannelMemory(db(), a.channel_id, first.next_cursor!, 50);
  const ids = [...first.nodes, ...second.nodes].map(n => n.ref.id);
  assert.equal(ids.length, 60);
  assert.equal(new Set(ids).size, 60);
  assert.ok(!ids.includes(old.thread_id));
  assert.equal(second.next_cursor, null);
  const thread = await readThreadMemory(db(), a.channel_id, old.thread_id);
  assert.equal(thread.node.summary, 'Old');
});

test('thread memory lists sessions without content; session memory checks the installation', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Start');
  const session = await addSession(a, root.thread_id, a.installation_id, 'Fix fixture');
  const task = randomUUID();
  await pool.query(`INSERT INTO tasks(id,workspace_id,thread_id,installation_id,goal,skill,requester_id,status,session_id,idempotency_key,request_hash)
    VALUES($1,$2,$3,$4,'Fix it','demo.echo',$5,'running',$6,$7,'h')`, [task, a.workspace_id, root.thread_id, a.installation_id, a.owner_id, session, task]);
  const turn = (await pool.query(`INSERT INTO messages(id,workspace_id,channel_id,thread_id,installation_id,task_id,author_type,text,agent_session_id)
    VALUES($1,$2,$3,$4,$5,$6,'agent','Step 3 failed',$7) RETURNING id, sequence::text`, [randomUUID(), a.workspace_id, a.channel_id, root.thread_id, a.installation_id, task, session])).rows[0];
  const thread = await readThreadMemory(db(), a.channel_id, root.thread_id);
  assert.equal(thread.sessions.length, 1);
  assert.equal(thread.sessions[0]!.title, 'Fix fixture');
  assert.equal(thread.sessions[0]!.state, 'active');
  assert.ok(!thread.context.messages.some(m => m.id === turn.id));
  const saved = await writeSessionMemory(db(), a.channel_id, session, a.installation_id, { revision: 0, through_sequence: turn.sequence, content: '# Progress\nStep 3 failed', summary: 'Step 3 failed', source_message_ids: [turn.id] }, { id: a.installation_id, name: 'Codex' });
  assert.equal(saved.revision, 1);
  const own = await readSessionMemory(db(), a.channel_id, session, a.installation_id);
  assert.equal(own.memory?.summary, 'Step 3 failed');
  assert.equal(own.messages[0]!.id, turn.id);
  assert.equal(own.node.parent?.id, root.thread_id);
  await assert.rejects(readSessionMemory(db(), a.channel_id, session, randomUUID()), (e: any) => e.code === 'session_private');
  await assert.rejects(readSessionMemory(db(), a.channel_id, session, null), (e: any) => e.code === 'session_private');
  const other = await bootstrap(pool);
  await assert.rejects(readSessionMemory(db(), other.channel_id, session, a.installation_id), (e: any) => e.status === 404);
  await pool.query(`UPDATE agent_sessions SET state='ended' WHERE id=$1`, [session]);
  await assert.rejects(readSessionMemory(db(), a.channel_id, session, a.installation_id), (e: any) => e.code === 'session_ended');
});

async function channelKey(token: string, channel: string, access: 'read' | 'contribute' | 'write', installation?: string) {
  const path = `/channels/${channel}/memory`;
  await api(token, 'POST', `${path}/settings`, { enabled: true });
  if (installation) await api(token, 'POST', `${path}/agents/${installation}`, { access: access === 'read' ? 'read' : 'contribute' });
  return (await api(token, 'POST', `${path}/connections`, { name: `Key ${randomUUID().slice(0, 8)}`, access, ...(installation ? { installation_id: installation } : {}) }, 201)).token as string;
}

test('agent walks channel → thread → session over MCP and is fenced at each step', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Dedupe fix');
  await seedMemory(a.channel_id, root.thread_id, root, a.owner_id, 'Dedupe fix · in progress');
  const secondInstallation = randomUUID();
  await pool.query(`INSERT INTO agent_installations(id,workspace_id,owner_id,definition_id,connector_id)
    SELECT $1,workspace_id,owner_id,definition_id,connector_id FROM agent_installations WHERE id=$2`, [secondInstallation, a.installation_id]);
  const mine = await addSession(a, root.thread_id);
  const theirs = await addSession(a, root.thread_id, secondInstallation);
  const foreign = await post(b.owner_token, b.channel_id, 'Other workspace');
  const client = await connect(await channelKey(a.owner_token, a.channel_id, 'contribute', a.installation_id));
  try {
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const name of ['channel_memory', 'thread_memory', 'session_memory', 'session_memory_save']) assert.ok(names.includes(name), name);
    const index = data(await client.callTool({ name: 'channel_memory', arguments: {} }));
    assert.equal(index.nodes[0].summary, 'Dedupe fix · in progress');
    const thread = data(await client.callTool({ name: 'thread_memory', arguments: { thread_id: index.nodes[0].ref.id } }));
    assert.equal(thread.sessions.length, 2);
    data(await client.callTool({ name: 'session_memory', arguments: { session_id: mine } }));
    assert.equal(code(await client.callTool({ name: 'session_memory', arguments: { session_id: theirs } })), 'session_private');
    // store.connected maps any 404 inside work to 401, so a foreign ref reveals nothing about existence.
    assert.equal(code(await client.callTool({ name: 'thread_memory', arguments: { thread_id: foreign.thread_id } })), 'unauthorized');
    assert.equal(code(await client.callTool({ name: 'session_memory', arguments: { session_id: randomUUID() } })), 'unauthorized');
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2', [a.channel_id, a.owner_id]);
    const removed = await client.callTool({ name: 'channel_memory', arguments: {} }).catch(error => ({ isError: true, content: [{ text: String(error) }] }));
    assert.equal(removed.isError, true);
  } finally { await client.close(); }
});

test('thread keys do not get the channel layer tools', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Start');
  const client = await connect(await threadKey(a.owner_token, a.channel_id, root.thread_id, 'read'));
  try {
    const names = (await client.listTools()).tools.map(t => t.name);
    assert.ok(!names.includes('channel_memory'));
    assert.ok(!names.includes('session_memory'));
  } finally { await client.close(); }
});

test('turn-end memory saves both layers, keeps a conflict as pending, and clears it on the next save', async () => {
  const a = await bootstrap(pool);
  await post(a.owner_token, a.channel_id, 'Start');
  const root = await post(a.owner_token, a.channel_id, 'Thread for memory');
  const session = await addSession(a, root.thread_id);
  const base = { channelId: a.channel_id, threadId: root.thread_id, sessionId: session, installationId: a.installation_id, producer: { id: a.installation_id, name: 'Codex' } };
  const first = await saveTurnMemory(db(), { ...base, memory: { session: { base_revision: 0, summary: 'S1', content: 'session one' }, thread: { base_revision: 0, summary: 'T1', content: 'thread one' } } });
  assert.deepEqual(first, [{ scope: 'session', outcome: 'saved' }, { scope: 'thread', outcome: 'saved' }]);
  const stale = await saveTurnMemory(db(), { ...base, memory: { thread: { base_revision: 0, summary: 'T-stale', content: 'stale' } } });
  assert.deepEqual(stale, [{ scope: 'thread', outcome: 'pending' }]);
  const pending = await readPendingMemory(db(), a.installation_id, root.thread_id, session);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.scope, 'thread');
  assert.equal(pending[0]!.current_revision, 1);
  assert.equal(pending[0]!.summary, 'T-stale');
  await saveTurnMemory(db(), { ...base, memory: { thread: { base_revision: 1, summary: 'T2', content: 'merged' } } });
  assert.equal((await readPendingMemory(db(), a.installation_id, root.thread_id, session)).length, 0);
  await saveTurnMemory(db(), { ...base, memory: { thread: { base_revision: 0, summary: 'T-stale-2', content: 'stale again' } } });
  const pendingNow = await readPendingMemory(db(), a.installation_id, root.thread_id, session);
  assert.equal(pendingNow[0]!.current_revision, 2);
  await pool.query(`UPDATE agent_sessions SET state='ended' WHERE id=$1`, [session]);
  assert.deepEqual(await saveTurnMemory(db(), { ...base, memory: { session: { base_revision: 1, summary: 'S2', content: 'late' } } }), [{ scope: 'session', outcome: 'skipped' }]);
  const channel = await readChannelMemory(db(), a.channel_id);
  assert.equal(channel.nodes.find(n => n.ref.id === root.thread_id)?.summary, 'T2');
});
