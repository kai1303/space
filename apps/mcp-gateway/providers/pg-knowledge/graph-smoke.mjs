// Run with TEST_DATABASE_URL (Space test DB with wal_level=logical, role with REPLICATION),
// THREAD_INDEX_URL (knowledge DB writer with schema.sql, threads.sql and graph.sql applied) and
// KNOWLEDGE_DATABASE_URL (knowledge DB reader role).
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
import { listNoteTitles, removeNote, saveNoteByTitle } from '@space/postgres/knowledge-notes';
import { searchRelated } from './graph-related.mjs';

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
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await fn()) return; await delay(150); }
  throw Error('Timed out waiting for the graph');
}
const count = async table => Number((await index.query(`SELECT count(*) FROM kb.${table}`)).rows[0].count);
const titles = async () => (await index.query('SELECT title FROM kb.g_knowledge ORDER BY title')).rows.map(r => r.title);
try {
  await admin.query('CREATE SCHEMA ' + schema);
  await migrate(source);
  const seed = await bootstrap(source), chat = new ChatStore(source), db = database(source);
  const one = await chat.send(seed.owner_id, seed.channel_id, { client_message_id: randomUUID(), text: 'Retries double charge.' });
  const two = await chat.send(seed.owner_id, seed.channel_id, { client_message_id: randomUUID(), text: 'Rotate keys quarterly.' });
  await source.query('UPDATE channels SET knowledge_enabled=true WHERE id=$1', [seed.channel_id]);
  const scope = { workspaceId: seed.workspace_id, channelId: seed.channel_id }, codex = { id: 'codex', name: 'Codex' };
  const save = (title, id) => saveNoteByTitle(db, scope, { kind: 'fact', title, content: title + ' body.', message_ids: [id] }, codex);
  await save('A', one.id); await save('B', one.id); await save('C', two.id);

  start();
  await until(async () => (await count('g_knowledge')) === 3);
  assert.deepEqual(await titles(), ['A', 'B', 'C'], 'first start rebuilds from the snapshot');
  assert.equal(await count('g_evidence'), 3);
  assert.equal(await count('g_channels'), 1);

  const ids = Object.fromEntries((await listNoteTitles(db, seed.channel_id)).notes.map(n => [n.title, n.id]));
  const ctx = requesterId => ({ workspaceId: seed.workspace_id, requesterId, connectionId: randomUUID(), audience: { channelId: seed.channel_id } });
  assert.deepEqual((await searchRelated(reader, source, ctx(seed.owner_id), 'note/' + ids.A, 5)).map(h => h.title), ['B'], 'A and B cite the same thread');
  assert.deepEqual(await searchRelated(reader, source, ctx(randomUUID()), 'note/' + ids.A, 5), [], 'unknown requester sees nothing');
  await assert.rejects(() => searchRelated(reader, source, ctx(seed.owner_id), 'message/' + ids.A, 5), /Invalid related reference/);

  await save('D', two.id);                       // live change through the slot
  await until(async () => (await count('g_knowledge')) === 4);
  const evidenceOfB = async thread => (await index.query(`SELECT 1 FROM kb.g_evidence e JOIN kb.g_knowledge k ON k.id=e.knowledge_id WHERE k.title='B' AND e.thread_id=$1`, [thread])).rowCount;
  await save('B', two.id);                       // same title, new evidence: B moves to the other thread
  await until(async () => (await evidenceOfB(two.thread_id)) === 1);
  assert.equal(await evidenceOfB(one.thread_id), 0, 'old evidence edge is gone');

  await stop();                                   // reader offline
  const a = (await listNoteTitles(db, seed.channel_id)).notes.find(n => n.title === 'A');
  await removeNote(db, seed.channel_id, a.id, a.revision, codex);
  await save('E', one.id);
  start();                                        // restart: the slot replays what was missed
  await until(async () => (await titles()).join() === 'B,C,D,E');
  await until(async () => (await index.query('SELECT lsn=published_lsn AS same FROM kb.graph_position WHERE slot=$1', [slot])).rows[0].same);

  await stop(); start();                          // restart with nothing new changes nothing
  await delay(1500);
  assert.deepEqual(await titles(), ['B', 'C', 'D', 'E']);

  const before = await count('g_evidence');
  await source.query('UPDATE channels SET knowledge_enabled=false WHERE id=$1', [seed.channel_id]);
  await until(async () => (await index.query('SELECT enabled FROM kb.g_channels')).rows[0].enabled === false);
  assert.equal(await count('g_evidence'), before, 'switching off hides knowledge on read; the graph keeps it');
  console.log('PASS: snapshot start, live change, evidence move, removal while offline, replay, idempotent restart, switch.');
} finally {
  await stop();
  for (let i = 0; i < 20; i++) {
    try { await admin.query('SELECT pg_drop_replication_slot($1)', [slot]); break; } catch { await delay(250); }
  }
  await admin.query(`DROP PUBLICATION IF EXISTS "${slot}"`).catch(() => {});
  await index.query('DELETE FROM kb.g_channels').catch(() => {});
  await index.query('DELETE FROM kb.graph_position WHERE slot=$1', [slot]).catch(() => {});
  await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
  await Promise.all([admin.end(), index.end(), reader.end(), source.end()]);
}
