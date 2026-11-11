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
import { readChannelMemory, readThreadMemory, readSessionMemory, useMemoryIndex } from '@space/postgres/layered-memory';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
const schema = `layered_memory_${randomBytes(6).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const directory = await mkdtemp(join(tmpdir(), 'space-layered-memory-'));
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, memory: { directory } });
let address: string;
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); address = await app.listen({ host: '127.0.0.1', port: 0 }); });
after(async () => { useMemoryIndex(undefined); await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(directory, { recursive: true, force: true }); });

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
const db = () => new PostgresStore(pool).db;
async function addSession(a: { workspace_id: string; installation_id: string }, thread: string, installation = a.installation_id, title = 'Fix fixture') {
  const id = randomUUID();
  await pool.query(`INSERT INTO agent_sessions(id,workspace_id,installation_id,origin_thread_id,title) VALUES($1,$2,$3,$4,$5)`, [id, a.workspace_id, installation, thread, title]);
  return id;
}
async function sessionTurn(a: { workspace_id: string; channel_id: string; installation_id: string }, thread: string, session: string, text: string) {
  const task = randomUUID();
  await pool.query(`INSERT INTO tasks(id,workspace_id,thread_id,installation_id,goal,skill,requester_id,status,session_id,idempotency_key,request_hash)
    SELECT $1,$2,$3,$4,'Fix it','demo.echo',owner_id,'running',$5,$6,'h' FROM agent_installations WHERE id=$4`, [task, a.workspace_id, thread, a.installation_id, session, task]);
  return (await pool.query(`INSERT INTO messages(id,workspace_id,channel_id,thread_id,installation_id,task_id,author_type,text,agent_session_id)
    VALUES($1,$2,$3,$4,$5,$6,'agent',$7,$8) RETURNING id, sequence::text`, [randomUUID(), a.workspace_id, a.channel_id, thread, a.installation_id, task, text, session])).rows[0] as { id: string; sequence: string };
}
async function threadKey(token: string, channel: string, thread: string, access: 'read' | 'write' = 'read') {
  return (await api(token, 'POST', `/channels/${channel}/threads/${thread}/context/connections`, { name: `Agent ${randomUUID().slice(0, 8)}`, access }, 201)).token as string;
}
async function channelKey(token: string, channel: string, access: 'read' | 'contribute' | 'write', installation?: string) {
  const path = `/channels/${channel}/memory`;
  await api(token, 'POST', `${path}/settings`, { enabled: true });
  if (installation) await api(token, 'POST', `${path}/agents/${installation}`, { access: access === 'read' ? 'read' : 'contribute' });
  return (await api(token, 'POST', `${path}/connections`, { name: `Key ${randomUUID().slice(0, 8)}`, access, ...(installation ? { installation_id: installation } : {}) }, 201)).token as string;
}

test('channel memory: titles come from the root message, 7-day window, newest first, stable keyset paging under writes', async () => {
  const a = await bootstrap(pool);
  const roots = [];
  for (let i = 0; i < 60; i++) {
    const root = await post(a.owner_token, a.channel_id, `Thread ${i}\nmore detail`);
    await pool.query('UPDATE messages SET created_at=$1 WHERE id=$2', [new Date(Date.now() - (60 - i) * 60_000).toISOString(), root.id]);
    roots.push(root);
  }
  const old = await post(a.owner_token, a.channel_id, 'Old');
  await pool.query('UPDATE messages SET created_at=$1 WHERE id=$2', [new Date(Date.now() - 8 * 86_400_000).toISOString(), old.id]);
  const first = await readChannelMemory(db(), a.channel_id, undefined, 50);
  assert.equal(first.nodes.length, 50);
  assert.equal(first.nodes[0]!.summary, 'Thread 59', 'only the first line of the root message');
  assert.equal(first.nodes[0]!.parent?.kind, 'channel');
  assert.ok(first.next_cursor);
  await post(a.owner_token, a.channel_id, 'A late reply', roots[0]!.thread_id);   // activity after the snapshot cannot move a thread across the cursor
  const second = await readChannelMemory(db(), a.channel_id, first.next_cursor!, 50);
  const ids = [...first.nodes, ...second.nodes].map(n => n.ref.id);
  assert.equal(ids.length, 60);
  assert.equal(new Set(ids).size, 60);
  assert.ok(!ids.includes(old.thread_id));
  assert.equal(second.next_cursor, null);
  const thread = await readThreadMemory(db(), a.channel_id, old.thread_id);
  assert.equal(thread.node.summary, 'Old');
});

test('thread memory lists sessions; session memory shows the agent turns and checks the installation', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Start');
  const session = await addSession(a, root.thread_id);
  const turn = await sessionTurn(a, root.thread_id, session, 'Step 3 failed');
  const thread = await readThreadMemory(db(), a.channel_id, root.thread_id);
  assert.equal(thread.sessions.length, 1);
  assert.equal(thread.sessions[0]!.title, 'Fix fixture');
  assert.equal(thread.sessions[0]!.state, 'active');
  assert.ok(!thread.context.messages.some(m => m.id === turn.id), 'session turns stay out of the thread');
  const own = await readSessionMemory(db(), a.channel_id, session, a.installation_id);
  assert.equal(own.messages[0]!.id, turn.id);
  assert.equal(own.node.parent?.id, root.thread_id);
  await assert.rejects(readSessionMemory(db(), a.channel_id, session, randomUUID()), (e: any) => e.code === 'session_private');
  await assert.rejects(readSessionMemory(db(), a.channel_id, session, null), (e: any) => e.code === 'session_private');
  const other = await bootstrap(pool);
  await assert.rejects(readSessionMemory(db(), other.channel_id, session, a.installation_id), (e: any) => e.status === 404);
  await pool.query(`UPDATE agent_sessions SET state='ended' WHERE id=$1`, [session]);
  await assert.rejects(readSessionMemory(db(), a.channel_id, session, a.installation_id), (e: any) => e.code === 'session_ended');
});

test('the Graph RAG store ranks by meaning but can only name messages of the scope that was asked for', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Start the incident review');
  const early = await post(a.owner_token, a.channel_id, 'Duplicate charges came from retries', root.thread_id);
  for (let i = 0; i < 20; i++) await post(a.owner_token, a.channel_id, `Chatter ${i}`, root.thread_id);
  const other = await post(a.owner_token, a.channel_id, 'Separate topic', undefined);
  const foreign = await post(b.owner_token, b.channel_id, 'Other workspace secret');
  const seen: unknown[] = [];
  useMemoryIndex({ related: async (scope, query, limit) => { seen.push({ scope, query, limit }); return [early.id, other.id, foreign.id, 'not-a-uuid']; } });
  try {
    const memory = await readThreadMemory(db(), a.channel_id, root.thread_id, 'why were customers charged twice');
    assert.deepEqual(memory.related.map(m => m.id), [early.id], 'only this thread, never another thread or workspace');
    assert.equal((seen[0] as any).scope.threadId, root.thread_id);
    const channel = await readChannelMemory(db(), a.channel_id, undefined, 20, 'charged twice');
    assert.equal(channel.nodes[0]!.ref.id, root.thread_id, 'ranked threads of this channel');
    assert.ok(!channel.nodes.some(n => n.ref.id === foreign.thread_id));
    await assert.rejects(readThreadMemory(db(), a.channel_id, root.thread_id, '   '), (e: any) => e.code === 'invalid_memory_query');
    useMemoryIndex({ related: async () => { throw new Error('store down'); } });
    const fallback = await readThreadMemory(db(), a.channel_id, root.thread_id, 'anything');
    assert.deepEqual(fallback.related, [], 'memory still reads when the store is down');
    assert.ok(fallback.context.root);
  } finally { useMemoryIndex(undefined); }
});

test('agent walks channel → thread → session over MCP and is fenced at each step', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Dedupe fix');
  const secondInstallation = randomUUID();
  await pool.query(`INSERT INTO agent_installations(id,workspace_id,owner_id,definition_id,connector_id)
    SELECT $1,workspace_id,owner_id,definition_id,connector_id FROM agent_installations WHERE id=$2`, [secondInstallation, a.installation_id]);
  const mine = await addSession(a, root.thread_id);
  const theirs = await addSession(a, root.thread_id, secondInstallation);
  const foreign = await post(b.owner_token, b.channel_id, 'Other workspace');
  const client = await connect(await channelKey(a.owner_token, a.channel_id, 'contribute', a.installation_id));
  try {
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const name of ['channel_memory', 'thread_memory', 'session_memory']) assert.ok(names.includes(name), name);
    for (const name of ['thread_memory_save', 'session_memory_save']) assert.ok(!names.includes(name), `${name} was removed`);
    const index = data(await client.callTool({ name: 'channel_memory', arguments: {} }));
    assert.equal(index.nodes[0].summary, 'Dedupe fix');
    const thread = data(await client.callTool({ name: 'thread_memory', arguments: { thread_id: index.nodes[0].ref.id, query: 'dedupe' } }));
    assert.equal(thread.sessions.length, 2);
    assert.deepEqual(thread.related, [], 'no store configured, so no ranked messages');
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
