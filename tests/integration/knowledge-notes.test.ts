import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
const schema = `knowledge_notes_${randomBytes(6).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const directory = await mkdtemp(join(tmpdir(), 'space-knowledge-notes-'));
const store = new PostgresStore(pool);
const app = createApi(store, { allowDevelopmentTokens: true, memory: { directory } });
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
const db = () => store.db;
async function insertNote(a: { workspace_id: string; channel_id: string }, id: string, title: string, evidence: string) {
  return pool.query(`INSERT INTO knowledge_notes(id,workspace_id,channel_id,kind,title,content,evidence,producer_id,producer_name)
    VALUES($1,$2,$3,'decision',$4,'Dedupe charges.',ARRAY[$5]::uuid[],'p','Codex')`, [id, a.workspace_id, a.channel_id, title, evidence]);
}

test('migration: one live note per title, notify payloads, visibility follows the switch', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Dedupe on idempotency_key');
  const listener = await admin.connect();
  const payloads: string[] = [];
  listener.on('notification', n => payloads.push(n.payload ?? ''));
  await listener.query(`LISTEN space_kb_${a.workspace_id.replaceAll('-', '')}`);
  try {
    const first = randomUUID();
    await insertNote(a, first, 'Duplicate charge fix', root.id);
    await assert.rejects(insertNote(a, randomUUID(), '  duplicate   CHARGE fix ', root.id), /duplicate key/);
    const visible = (requester = a.owner_id) => pool.query('SELECT id FROM knowledge_visible_notes($1,$2,$3,$4::uuid[])', [a.workspace_id, requester, a.channel_id, [first]]);
    assert.equal((await visible()).rowCount, 0, 'hidden while the switch is off');
    await pool.query('UPDATE channels SET knowledge_enabled=true WHERE id=$1', [a.channel_id]);
    assert.equal((await visible()).rowCount, 1);
    assert.equal((await visible(randomUUID())).rowCount, 0, 'unknown requester sees nothing');
    await pool.query('UPDATE knowledge_notes SET removed_at=now() WHERE id=$1', [first]);
    assert.equal((await visible()).rowCount, 0, 'removed notes are hidden');
    await insertNote(a, randomUUID(), 'Duplicate charge fix', root.id);
    await delay(200);
    assert.ok(payloads.includes(`note/${a.channel_id}/${first}`), JSON.stringify(payloads));
    assert.ok(payloads.includes('reconcile'), 'switch change asks the worker to reconcile');
  } finally { listener.release(); }
});

import { addNote, listNoteTitles, removeNote, saveNoteByTitle, updateNote } from '@space/postgres/knowledge-notes';

const codex = { id: 'codex-installation', name: 'Codex' };
const draft = (message: string, title = 'Duplicate charge fix', content = 'Dedupe on idempotency_key.') => ({ kind: 'decision' as const, title, content, message_ids: [message] });

test('same-title saves make revisions, repeats change nothing, concurrent saves keep one note', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Dedupe on idempotency_key');
  const scope = { workspaceId: a.workspace_id, channelId: a.channel_id };
  assert.equal(await saveNoteByTitle(db(), scope, draft(root.id), codex), 'saved');
  assert.equal(await saveNoteByTitle(db(), scope, draft(root.id), codex), 'unchanged');
  assert.equal(await saveNoteByTitle(db(), scope, draft(root.id, 'duplicate CHARGE fix', 'Dedupe in Postgres.'), codex), 'saved');
  await Promise.all([
    saveNoteByTitle(db(), scope, draft(root.id, 'Duplicate charge fix', 'A'), codex),
    saveNoteByTitle(db(), scope, draft(root.id, 'Duplicate charge fix', 'B'), codex),
  ]);
  const notes = (await pool.query('SELECT id, revision FROM knowledge_notes WHERE channel_id=$1 AND removed_at IS NULL', [a.channel_id])).rows;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].revision, 4);
  const revisions = (await pool.query('SELECT revision FROM knowledge_note_revisions WHERE note_id=$1 ORDER BY revision', [notes[0].id])).rows;
  assert.deepEqual(revisions.map(r => r.revision), [1, 2, 3, 4]);
});

test('MCP-style add, update and remove use ids, fingerprints and revisions', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Evidence');
  const foreign = await post(b.owner_token, b.channel_id, 'Other channel');
  const scope = { workspaceId: a.workspace_id, channelId: a.channel_id };
  const id = randomUUID();
  const added = await addNote(db(), scope, id, draft(root.id), codex);
  assert.equal(added.revision, 1);
  assert.equal((await addNote(db(), scope, id, draft(root.id), codex)).id, id, 'same id and input is a retry');
  await assert.rejects(addNote(db(), scope, id, draft(root.id, 'Other'), codex), (e: any) => e.code === 'note_id_conflict');
  await assert.rejects(addNote(db(), scope, randomUUID(), draft(root.id), codex), (e: any) => e.code === 'title_taken');
  await assert.rejects(addNote(db(), scope, randomUUID(), draft(foreign.id, 'New'), codex), (e: any) => e.code === 'foreign_evidence');
  const second = await addNote(db(), scope, randomUUID(), draft(root.id, 'Retry budget'), codex);
  await assert.rejects(updateNote(db(), a.channel_id, id, 5, { content: 'x' }, codex), (e: any) => e.code === 'note_conflict');
  await assert.rejects(updateNote(db(), a.channel_id, id, 1, { title: 'retry BUDGET' }, codex), (e: any) => e.code === 'title_taken');
  await assert.rejects(updateNote(db(), a.channel_id, randomUUID(), 1, { content: 'x' }, codex), (e: any) => e.code === 'note_not_found');
  const updated = await updateNote(db(), a.channel_id, id, 1, { content: 'Dedupe in Postgres.' }, codex);
  assert.equal(updated.revision, 2);
  const removed = await removeNote(db(), a.channel_id, second.id, 1, codex);
  assert.equal(removed.revision, 2);
  const last = (await pool.query('SELECT removed FROM knowledge_note_revisions WHERE note_id=$1 ORDER BY revision DESC LIMIT 1', [second.id])).rows[0];
  assert.equal(last.removed, true);
  await assert.rejects(removeNote(db(), a.channel_id, second.id, 2, codex), (e: any) => e.code === 'note_not_found');
});

test('title list returns the newest 20 live notes', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Evidence');
  const scope = { workspaceId: a.workspace_id, channelId: a.channel_id };
  for (let i = 0; i < 25; i++) await saveNoteByTitle(db(), scope, draft(root.id, `Note ${i}`), codex);
  const list = await listNoteTitles(db(), a.channel_id);
  assert.equal(list.notes.length, 20);
  assert.equal(list.truncated, true);
  assert.equal(list.notes[0]!.title, 'Note 24');
});

test('managers turn knowledge notes on with their own route; grants and keys work with only Knowledge on', async () => {
  const a = await bootstrap(pool);
  const path = `/channels/${a.channel_id}/memory`;
  assert.equal((await api(a.owner_token, 'GET', path)).knowledge_enabled, false);
  await api(a.collaborator_token, 'POST', `${path}/knowledge`, { enabled: true }, 403);
  await api(a.owner_token, 'POST', `${path}/knowledge`, { enabled: 'yes' }, 400);
  const state = await api(a.owner_token, 'POST', `${path}/knowledge`, { enabled: true });
  assert.equal(state.knowledge_enabled, true);
  assert.equal(state.enabled, false, 'the memory switch is untouched');
  await api(a.owner_token, 'POST', `${path}/agents/${a.installation_id}`, { access: 'contribute' });
  await api(a.owner_token, 'POST', `${path}/connections`, { name: 'Notes key', access: 'contribute', installation_id: a.installation_id }, 201);
  await api(a.owner_token, 'POST', `${path}/knowledge`, { enabled: false });
  await api(a.owner_token, 'POST', `${path}/connections`, { name: 'Late key', access: 'read' }, 409);
});
