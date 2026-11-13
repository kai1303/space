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
import { readThreadContext, readThreadMessages } from '@space/postgres/thread-context';
import { MemoryStore } from '@space/postgres/memory';
import { addNote, listNoteTitles, removeNote, saveNoteByTitle, updateNote } from '@space/postgres/knowledge-notes';
import { createApi } from '@space/server/api';
import { parseChannelMemoryPage } from '@space/contracts';
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
  assert.ok(first.channel, 'the first page carries the channel header');
  assert.equal(second.channel, undefined, 'later pages leave it out');
  const thread = await readThreadMemory(db(), a.channel_id, old.thread_id);
  assert.equal(thread.node.summary, 'Old');
});

test('channel memory header: what people typed, and counted thread topics only when the topic is empty', async () => {
  const a = await bootstrap(pool);
  await pool.query("UPDATE channels SET memory_enabled=true, topic='', description='Plans for the launch' WHERE id=$1", [a.channel_id]);
  const name = (await pool.query('SELECT name FROM channels WHERE id=$1', [a.channel_id])).rows[0].name as string;
  const first = await post(a.owner_token, a.channel_id, 'Deploy and billing');
  const second = await post(a.owner_token, a.channel_id, 'Another deploy');
  const topic = (name: string, id: string) => ({ name, evidence: { [id]: '1' } });
  for (const [message, labels] of [[first, ['deploy', 'billing']], [second, ['deploy']]] as const) {
    await pool.query(`INSERT INTO memory_extract_threads(thread_id,workspace_id,channel_id,available_at,topics)
      VALUES($1,$2,$3,'infinity',$4) ON CONFLICT(thread_id) DO UPDATE SET topics=excluded.topics`,
      [message.thread_id, a.workspace_id, a.channel_id, JSON.stringify(labels.map(label => topic(label, message.id)))]);
  }
  const readHeader = async () => (await readChannelMemory(db(), a.channel_id)).channel;
  const page = await readChannelMemory(db(), a.channel_id);
  assert.deepEqual(page.channel, { name, topic: '', description: 'Plans for the launch', top_topics: ['deploy', 'billing'] });
  assert.deepEqual(parseChannelMemoryPage(page), page);
  await pool.query("UPDATE channels SET topic='Launch week' WHERE id=$1", [a.channel_id]);
  assert.deepEqual((await readHeader())?.top_topics, [], 'a typed topic wins');
  await pool.query("UPDATE channels SET topic='' WHERE id=$1", [a.channel_id]);
  assert.deepEqual((await readChannelMemory(db(), a.channel_id, undefined, undefined, undefined, { countTopics: false })).channel?.top_topics, [], 'task preparation skips aggregation');
  const removal = await app.inject({ method: 'DELETE', url: `/v1/channels/${a.channel_id}/messages/${first.id}`, headers: { authorization: `Bearer ${a.owner_token}` } });
  assert.equal(removal.statusCode, 200, removal.body);
  assert.deepEqual((await readHeader())?.top_topics, ['deploy'], 'deleting one source immediately removes only its contributions');
  assert.deepEqual((await readThreadMemory(db(), a.channel_id, first.thread_id)).topics, []);
  assert.deepEqual((await pool.query('SELECT topics FROM memory_extract_threads WHERE thread_id=$1', [first.thread_id])).rows[0].topics, [], 'deleted evidence removes the local copy of its labels');
  await pool.query("UPDATE messages SET retained_at=now(), text='Message removed by workspace retention.', document=NULL WHERE channel_id=$1 AND id=$2", [a.channel_id, second.id]);
  assert.deepEqual((await readHeader())?.top_topics, [], 'retained messages cannot contribute topics');

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

test('shared memory uses only channel messages for summaries, paging, lookups and task delivery', async () => {
  const a = await bootstrap(pool);
  const other = { ...a, installation_id: randomUUID() };
  await pool.query(`INSERT INTO agent_installations(id,workspace_id,owner_id,definition_id,connector_id)
    SELECT $1,workspace_id,owner_id,definition_id,connector_id FROM agent_installations WHERE id=$2`, [other.installation_id, a.installation_id]);
  const session = await addSession(other, a.thread_id);
  const first = await sessionTurn(other, a.thread_id, session, 'Session entry');
  const shared = await post(a.owner_token, a.channel_id, 'Shared update', a.thread_id);
  await sessionTurn(other, a.thread_id, session, 'Session follow-up');
  const deleted = await post(a.owner_token, a.channel_id, 'Removed', a.thread_id);
  const retained = await post(a.owner_token, a.channel_id, 'Expired', a.thread_id);
  const removal = await app.inject({ method: 'DELETE', url: `/v1/channels/${a.channel_id}/messages/${deleted.id}`,
    headers: { authorization: `Bearer ${a.owner_token}` } });
  assert.ok(removal.statusCode < 300, removal.body);
  await pool.query("UPDATE messages SET retained_at=now(), text='Message removed by workspace retention.', document=NULL WHERE channel_id=$1 AND id=$2", [a.channel_id, retained.id]);
  const memory = new MemoryStore(pool);
  const context = await readThreadContext(db(), a.channel_id, a.thread_id);
  assert.equal(context.root?.id, shared.id);
  assert.equal(context.through_sequence, shared.sequence);
  assert.deepEqual(context.messages.map(m => m.id), [shared.id]);
  const page = await readThreadMessages(db(), a.channel_id, a.thread_id, '0', 1);
  assert.deepEqual(page.messages.map(m => m.id), [shared.id]);
  assert.equal(page.has_more, false);
  assert.deepEqual((await memory.context(db(), a, '0', 1)).messages.map(m => m.id), [shared.id]);
  assert.equal((await memory.message(db(), a, shared.id)).text, 'Shared update');
  await assert.rejects(memory.message(db(), a, first.id), { status: 404 });

  assert.equal((await readChannelMemory(db(), a.channel_id)).nodes[0]?.summary, 'Shared update');
  useMemoryIndex({ related: async () => [first.id] });
  try {
    assert.deepEqual((await readChannelMemory(db(), a.channel_id, undefined, 1, 'entry')).nodes, []);
  } finally { useMemoryIndex(undefined); }

  await pool.query('UPDATE channels SET memory_enabled=true WHERE id=$1', [a.channel_id]);
  const visible = await pool.query('SELECT id FROM memory_visible_messages($1,$2,$3,$4::uuid[])', [a.workspace_id, a.owner_id, a.channel_id, [first.id, shared.id]]);
  assert.deepEqual(visible.rows.map(m => m.id), [shared.id]);

  const store = new PostgresStore(pool);
  const task = await store.createTask(a.owner_id, { workspace_id: a.workspace_id, thread_id: a.thread_id, installation_id: a.installation_id, goal: 'Read thread', skill: 'demo.echo' }, randomUUID());
  await store.approveTask(a.owner_id, task.id);
  const { rows: [outbox] } = await pool.query('SELECT id FROM outbox WHERE task_id=$1', [task.id]);
  const delivery = await store.claimDelivery(undefined, outbox.id);
  assert.ok(delivery);
  const prepared = (await store.prepareDelivery(delivery))?.request.context;
  assert.deepEqual(prepared?.messages.map(m => m.id), [shared.id]);
  assert.deepEqual(prepared?.working_memory?.messages.map(m => m.id), [shared.id]);
});

test('channel knowledge requires live shared evidence on writes and when showing existing notes', async () => {
  const a = await bootstrap(pool);
  const shared = await post(a.owner_token, a.channel_id, 'Shared update', a.thread_id);
  const session = await addSession(a, a.thread_id);
  const turn = await sessionTurn(a, a.thread_id, session, 'Session entry');
  const draft = { kind: 'fact' as const, title: 'A note', content: 'Summary', message_ids: [shared.id, turn.id] };
  const producer = { id: a.installation_id, name: 'Agent' };
  const scope = { workspaceId: a.workspace_id, channelId: a.channel_id };
  await assert.rejects(addNote(db(), scope, randomUUID(), draft, producer), { code: 'foreign_evidence' });
  await assert.rejects(saveNoteByTitle(db(), scope, draft, producer), { code: 'foreign_evidence' });
  const id = randomUUID();
  await pool.query('UPDATE channels SET knowledge_enabled=true WHERE id=$1', [a.channel_id]);
  await pool.query(`INSERT INTO knowledge_notes(id,workspace_id,channel_id,kind,title,content,evidence,producer_id,producer_name)
    VALUES($1,$2,$3,'fact','Imported note','Summary',$4::uuid[],'p','Agent')`, [id, a.workspace_id, a.channel_id, draft.message_ids]);
  assert.deepEqual((await listNoteTitles(db(), a.channel_id)).notes, []);
  assert.equal((await pool.query('SELECT id FROM knowledge_note_sources WHERE id=$1', [id])).rowCount, 0);
  assert.equal((await pool.query('SELECT id FROM knowledge_visible_notes($1,$2,$3,$4::uuid[])', [a.workspace_id, a.owner_id, a.channel_id, [id]])).rowCount, 0);
  await assert.rejects(updateNote(db(), a.channel_id, id, 1, { title: 'Edited' }, producer), { code: 'note_not_found' });
  await assert.rejects(removeNote(db(), a.channel_id, id, 1, producer), { code: 'note_not_found' });
});

test('the Graph RAG store ranks by meaning but can only name messages of the scope that was asked for', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  await pool.query('UPDATE channels SET memory_enabled=true WHERE id=$1', [a.channel_id]);
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

    const fact = (id: string, ids: string[]) => ({ id, kind: 'decision' as const, text: `Fact ${id}`, topic: 'billing', message_ids: ids, evidence_revisions: Object.fromEntries(ids.map(id => [id, '1'])) });
    useMemoryIndex({ related: async () => [], threadFacts: async () => [fact('ok', [early.id]), fact('mixed', [early.id, foreign.id]), fact('empty', [])] });
    const knowing = await readThreadMemory(db(), a.channel_id, root.thread_id);
    assert.deepEqual(knowing.topics, []);
    assert.deepEqual(knowing.facts.map(f => f.id), ['ok'], 'a fact with any evidence outside this thread is hidden');
    await pool.query('UPDATE channels SET archived_at=now() WHERE id=$1', [a.channel_id]);
    assert.deepEqual((await readThreadMemory(db(), a.channel_id, root.thread_id)).facts, [], 'archive hides facts before graph cleanup');
    await pool.query('UPDATE channels SET archived_at=NULL WHERE id=$1', [a.channel_id]);
    await pool.query("UPDATE messages SET text='Corrected decision' WHERE channel_id=$1 AND id=$2", [a.channel_id, early.id]);
    assert.deepEqual((await readThreadMemory(db(), a.channel_id, root.thread_id)).facts, [], 'an edit hides the prior fact before CDC runs');
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
