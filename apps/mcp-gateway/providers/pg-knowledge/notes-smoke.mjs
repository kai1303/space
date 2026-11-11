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
  await stop();
  const note = (await listNoteTitles(db, seed.channel_id)).notes[0];
  await removeNote(db, seed.channel_id, note.id, note.revision, codex);
  assert.deepEqual(await hits(), [], 'removed notes are hidden even while the worker is offline');
  start();
  await until(async () => !(await indexed()).length);
  console.log('PASS: backfill, live update, citation, unknown requester, removal while offline, restart recovery.');
} finally {
  await stop(); await source.end(); await index.end(); await reader.end();
  await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await admin.end();
}
