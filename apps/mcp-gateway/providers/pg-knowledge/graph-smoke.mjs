// Run with TEST_DATABASE_URL (Space test DB with wal_level=logical, role with REPLICATION),
// THREAD_INDEX_URL (knowledge DB writer with schema.sql and memory-graph.sql applied) and
// KNOWLEDGE_DATABASE_URL (knowledge DB reader role). Needs the local Ollama all-minilm:22m model.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool, database } from '@space/postgres/database';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { ChatStore } from '@space/postgres/chat';
import { listNoteTitles, saveNoteByTitle } from '@space/postgres/knowledge-notes';
import { searchRelated } from './graph-related.mjs';
import { searchThreads } from './thread-search.mjs';
import { embed } from './graph-source.mjs';

const schema = 'graph_test_' + randomUUID().replaceAll('-', '');
const slot = ('space_graph_' + schema).slice(0, 63);
const admin = createPool(process.env.TEST_DATABASE_URL), index = createPool(process.env.THREAD_INDEX_URL), reader = createPool(process.env.KNOWLEDGE_DATABASE_URL);
const url = new URL(process.env.TEST_DATABASE_URL);
url.searchParams.set('options', '-c search_path=' + schema);
const source = createPool(url.href);
let worker;
async function stop() {
  if (worker && worker.exitCode === null && worker.signalCode === null) { const ended = once(worker, 'exit'); worker.kill(); await ended; }
}
const start = () => { worker = spawn(process.execPath, [fileURLToPath(new URL('./graph-reader.mjs', import.meta.url))], {
  env: { ...process.env, GRAPH_SOURCE_URL: url.href, GRAPH_REPLICATION_URL: process.env.TEST_DATABASE_URL,
    GRAPH_INDEX_URL: process.env.THREAD_INDEX_URL, GRAPH_SOURCE_SCHEMA: schema }, stdio: ['ignore', 'inherit', 'inherit'] }); };
async function until(fn) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await fn()) return; await delay(150); }
  throw Error('Timed out waiting for the graph');
}
const count = async (table, where = 'true') => Number((await index.query(`SELECT count(*) FROM kb.${table} WHERE ${where}`)).rows[0].count);
const thread = async id => (await index.query('SELECT reply_count, root_message_id FROM kb.m_threads WHERE id=$1', [id])).rows[0];
const ranked = async text => {
  const [vector] = await embed([text]);
  return (await index.query(`SELECT source_key FROM pgcontext.query('kb_memory',$1::pgcontext.vector,$2,'text',5)`, [JSON.stringify(vector), text])).rows.map(r => r.source_key);
};
try {
  await admin.query('CREATE SCHEMA ' + schema);
  await migrate(source);
  const seed = await bootstrap(source), chat = new ChatStore(source), db = database(source);
  const send = (text, thread_id) => chat.send(seed.owner_id, seed.channel_id, { client_message_id: randomUUID(), text, ...(thread_id ? { thread_id } : {}) });
  const rootA = await send('Customers are charged twice when checkout retries after a timeout.');
  const replyA = await send('The fix is to dedupe charges on the idempotency key.', rootA.thread_id);
  const rootB = await send('Rotate the API signing keys every quarter.');
  await source.query('UPDATE channels SET memory_enabled=true, knowledge_enabled=true WHERE id=$1', [seed.channel_id]);
  const scope = { workspaceId: seed.workspace_id, channelId: seed.channel_id }, codex = { id: 'codex', name: 'Codex' };
  const save = (title, id) => saveNoteByTitle(db, scope, { kind: 'fact', title, content: title + ' body.', message_ids: [id] }, codex);
  await save('A', rootA.id); await save('B', rootA.id); await save('C', rootB.id);

  start();
  await until(async () => (await count('m_messages')) === 3 && (await count('m_knowledge')) === 3);
  assert.equal(await count('m_messages', 'embedding IS NOT NULL'), 3, 'every message has a vector');
  assert.deepEqual(await thread(rootA.thread_id), { reply_count: 1, root_message_id: rootA.id }, 'thread counts and root');
  assert.equal(await count('m_knowledge_evidence', `message_id='${rootA.id}'`), 2, 'knowledge evidence is message level');
  assert.ok(await count('m_people') >= 1);
  const top = await ranked('why are customers charged twice on retry');
  assert.ok([rootA.id, replyA.id].includes(top[0]), 'meaning search finds the right thread first: ' + top.join());

  const ids = Object.fromEntries((await listNoteTitles(db, seed.channel_id)).notes.map(n => [n.title, n.id]));
  const ctx = requesterId => ({ workspaceId: seed.workspace_id, requesterId, connectionId: randomUUID(), audience: { channelId: seed.channel_id } });
  assert.deepEqual((await searchRelated(reader, source, ctx(seed.owner_id), 'note/' + ids.A, 5)).map(h => h.title), ['B'], 'A and B cite the same message');
  assert.deepEqual(await searchRelated(reader, source, ctx(randomUUID()), 'note/' + ids.A, 5), [], 'unknown requester sees nothing');
  await assert.rejects(() => searchRelated(reader, source, ctx(seed.owner_id), 'message/' + ids.A, 5), /Invalid related reference/);

  const replyB = await send('Also record the rollout date.', rootA.thread_id);   // live change through the slot
  await until(async () => (await count('m_messages')) === 4);
  assert.equal((await thread(rootA.thread_id)).reply_count, 2);

  await chat.deleteMessage(seed.owner_id, seed.channel_id, replyB.id);          // delete removes the row and its vector point
  await until(async () => (await count('m_messages')) === 3);
  assert.equal((await thread(rootA.thread_id)).reply_count, 1);
  assert.ok(!(await ranked('record the rollout date')).includes(replyB.id), 'the vector point is gone too');

  await stop();                                                                  // reader offline
  const replyC = await send('Offline message about invoices.', rootB.thread_id);
  start();                                                                       // restart: the slot replays what was missed
  await until(async () => (await count('m_messages')) === 4);
  assert.equal(await count('m_messages', `id='${replyC.id}'`), 1);
  await until(async () => (await index.query('SELECT lsn=published_lsn AS same FROM kb.graph_position WHERE slot=$1', [slot])).rows[0].same);

  await source.query('INSERT INTO knowledge_thread_channels(workspace_id,channel_id) VALUES($1,$2)', [seed.workspace_id, seed.channel_id]);   // thread search opt-in
  await until(async () => (await count('m_messages', 'knowledge')) === 4);
  const [question] = await embed(['why are customers charged twice on retry']);
  const found = await searchThreads(reader, source, ctx(seed.owner_id), 'why are customers charged twice on retry', question, 3);
  assert.ok(found.some(h => h.ref.recordId === 'message/' + rootA.id), 'knowledge thread search reads the merged store');
  assert.deepEqual(await searchThreads(reader, source, ctx(randomUUID()), 'charged twice', question, 3), [], 'and keeps its own access check');
  await source.query('DELETE FROM knowledge_thread_channels WHERE channel_id=$1', [seed.channel_id]);
  await until(async () => (await count('m_messages', 'knowledge')) === 0);

  await source.query('UPDATE channels SET memory_enabled=false WHERE id=$1', [seed.channel_id]);   // switch off: messages leave
  await until(async () => (await count('m_messages')) === 0);
  assert.equal(await count('m_knowledge'), 3, 'knowledge stays while the memory switch is off');
  await source.query('UPDATE channels SET memory_enabled=true WHERE id=$1', [seed.channel_id]);    // switch on: backfill
  await until(async () => (await count('m_messages')) === 4);

  await stop(); start();                                                         // restart with nothing new changes nothing
  await delay(2000);
  assert.equal(await count('m_messages'), 4);
  console.log('PASS: snapshot, vectors, meaning search, related knowledge, live change, delete, offline replay, switch off and on, idempotent restart.');
} finally {
  await stop();
  for (let i = 0; i < 20; i++) {
    try { await admin.query('SELECT pg_drop_replication_slot($1)', [slot]); break; } catch { await delay(250); }
  }
  await admin.query(`DROP PUBLICATION IF EXISTS "${slot}"`).catch(() => {});
  await index.query("SELECT pgcontext.delete_points('kb_memory', ARRAY(SELECT id FROM kb.m_messages))").catch(() => {});
  await index.query('DELETE FROM kb.m_channels').catch(() => {});
  await index.query('DELETE FROM kb.m_people').catch(() => {});
  await index.query('DELETE FROM kb.graph_position WHERE slot=$1', [slot]).catch(() => {});
  await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
  await Promise.all([admin.end(), index.end(), reader.end(), source.end()]);
}
