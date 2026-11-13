// Run with TEST_DATABASE_URL (Space test DB), THREAD_INDEX_URL (index writer) and
// KNOWLEDGE_DATABASE_URL (index reader) for a disposable index with notes.sql installed.
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
import { removeNote, saveNoteByTitle, listNoteTitles } from '@space/postgres/knowledge-notes';
import { parseConversationPath } from '@space/contracts';
import { searchNotes } from './notes-search.mjs';
const schema = 'notes_test_' + randomUUID().replaceAll('-', '');
const admin = createPool(process.env.TEST_DATABASE_URL), index = createPool(process.env.THREAD_INDEX_URL), reader = createPool(process.env.KNOWLEDGE_DATABASE_URL);
const url = new URL(process.env.TEST_DATABASE_URL);
url.searchParams.set('options', '-c search_path=' + schema);
const source = createPool(url.href);
let worker;
async function stop() {
  if (worker && worker.exitCode === null && worker.signalCode === null) { const ended = once(worker, 'exit'); worker.kill(); await ended; }
}
async function until(fn) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await fn()) return; await delay(150); }
  throw Error('Timed out waiting for the index');
}
try {
  await admin.query('CREATE SCHEMA ' + schema);
  await migrate(source);
  const seed = await bootstrap(source), chat = new ChatStore(source), db = database(source);
  const root = await chat.send(seed.owner_id, seed.channel_id, { client_message_id: randomUUID(), text: 'Checkout retries cause duplicate charges.' });
  await source.query('UPDATE channels SET knowledge_enabled=true WHERE id=$1', [seed.channel_id]);
  const scope = { workspaceId: seed.workspace_id, channelId: seed.channel_id }, codex = { id: 'codex', name: 'Codex' };
  await saveNoteByTitle(db, scope, { kind: 'decision', title: 'Duplicate charge fix', content: 'Dedupe charges on the juniper idempotency key.', message_ids: [root.id] }, codex);
  const start = () => { worker = spawn(process.execPath, [fileURLToPath(new URL('./thread-worker.mjs', import.meta.url))], {
    env: { ...process.env, THREAD_SOURCE_URL: url.href, KNOWLEDGE_WORKSPACE_ID: seed.workspace_id }, stdio: ['ignore', 'ignore', 'inherit'] }); };
  start();
  const indexed = async () => (await index.query('SELECT id, revision FROM kb.notes WHERE workspace_id=$1', [seed.workspace_id])).rows;
  await until(async () => (await indexed()).length === 1);
  const context = { workspaceId: seed.workspace_id, requesterId: seed.owner_id, connectionId: randomUUID(), audience: { channelId: seed.channel_id } };
  const { embeddings: [vector] } = await (await fetch('http://127.0.0.1:11434/api/embed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'all-minilm:22m', input: 'juniper duplicate charges' }) })).json();
  const hits = async (requester = seed.owner_id) => searchNotes(reader, source, { ...context, requesterId: requester }, 'juniper duplicate charges', vector, 5);
  const [hit] = await hits();
  assert.equal(hit?.title, 'Duplicate charge fix');
  assert.equal(parseConversationPath(hit.citation.url).message, root.id, 'cites the first evidence message');
  assert.deepEqual(await hits(randomUUID()), [], 'unknown requester sees nothing');
  await saveNoteByTitle(db, scope, { kind: 'decision', title: 'Duplicate charge fix', content: 'Dedupe charges on the cedar idempotency key.', message_ids: [root.id] }, codex);
  await until(async () => (await indexed())[0]?.revision === 2);
  assert.match((await hits())[0].evidence, /cedar/);
  // Cross the worker's 32-note page boundary with several notes citing the same source.
  const titles = Array.from({ length: 32 }, (_, i) => 'Decision ' + i);
  for (const title of titles) {
    await saveNoteByTitle(db, scope, { kind: 'fact', title, content: 'Use cedar keys.', message_ids: [root.id] }, codex);
  }
  await until(async () => (await indexed()).length === 33);
  // No thread/file opt-in: changing a citation alone removes all affected index entries.
  const events = await source.connect();
  try {
    await events.query('LISTEN space_kb_' + seed.workspace_id.replaceAll('-', ''));
    const observed = [];
    events.on('notification', event => observed.push(event.payload));
    await chat.deleteMessage(seed.owner_id, seed.channel_id, root.id);
    await until(() => observed.length);
    assert.ok(!observed.includes('reconcile'), 'deleting a citation must not rebuild the workspace');
    assert.ok(observed.includes('evidence/' + seed.channel_id + '/' + root.id), 'only affected notes need resync');
  } finally { await events.query('UNLISTEN *'); events.release(); }
  assert.deepEqual(await hits(), [], 'source revocation hides the note immediately');
  await until(async () => !(await indexed()).length);
  const removedPoint = await index.query(`SELECT source_key FROM pgcontext.query('kb_notes',$1::pgcontext.vector,$2,'text',100)
    WHERE source_key=$3`, [JSON.stringify(vector), 'juniper duplicate charges', hit.ref.recordId.slice('note/'.length)]);
  assert.equal(removedPoint.rowCount, 0, 'the note vector was removed too');
  const next = await chat.send(seed.owner_id, seed.channel_id, { client_message_id: randomUUID(), text: 'Use cedar keys.' });
  await saveNoteByTitle(db, scope, { kind: 'decision', title: 'New decision', content: 'Use cedar keys.', message_ids: [next.id] }, codex);
  await until(async () => (await indexed()).length === 1);
  const final = await chat.send(seed.owner_id, seed.channel_id, { client_message_id: randomUUID(), text: 'Verify retention cleanup' });
  await saveNoteByTitle(db, scope, { kind: 'fact', title: 'Retention case', content: 'Retention case', message_ids: [final.id] }, codex);
  await until(async () => (await indexed()).length === 2);
  await stop();
  await source.query("UPDATE messages SET retained_at=now(), text='Message removed by workspace retention.', document=NULL WHERE channel_id=$1 AND id=$2", [seed.channel_id, final.id]);
  const note = (await listNoteTitles(db, seed.channel_id)).notes[0];
  await removeNote(db, seed.channel_id, note.id, note.revision, codex);
  assert.deepEqual(await hits(), [], 'removed notes are hidden even while the worker is offline');
  start();
  await until(async () => !(await indexed()).length);
  console.log('PASS: backfill, live update, citation, targeted citation removal on a partitioned message, offline retention and removal, restart recovery.');
} finally {
  await stop(); await source.end(); await index.end(); await reader.end();
  await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await admin.end();
}
