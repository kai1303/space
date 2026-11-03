import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { WorkspaceStore } from '@space/postgres/workspace';
import { createApi } from '@space/server/api';
import type { MemoryProvider } from '@space/core/memory';
import type { MemoryDocument } from '@space/contracts';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
const schema = `memory_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const directory = await mkdtemp(join(tmpdir(), 'space-memory-api-'));
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, memory: { directory } });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); await app.ready(); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(directory, { recursive: true, force: true }); });
async function api(token: string, method: 'GET' | 'POST' | 'DELETE', path: string, body?: object, status = 200) {
  const response = await app.inject({ method, url: `/v1${path}`, headers: { authorization: `Bearer ${token}` }, ...(body ? { payload: body } : {}) });
  assert.equal(response.statusCode, status, `${path}: ${response.body}`);
  return response.json();
}
const base = (channel: string) => `/channels/${channel}/memory`;

test('memory is opt-in; only managers configure it; disabling retains private Markdown and blocks use', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool), path = base(a.channel_id);
  const initial = await api(a.owner_token, 'GET', path);
  assert.equal(initial.enabled, false);
  assert.equal(initial.provider, 'markdown');
  assert.equal(initial.document, null);
  assert.equal(initial.can_manage, true);
  await assert.rejects(readFile(join(directory, a.workspace_id, a.channel_id, 'memory.md')));
  assert.equal((await api(a.collaborator_token, 'GET', path)).can_manage, false);
  await api(a.collaborator_token, 'POST', `${path}/settings`, { enabled: true }, 403);
  await api(b.owner_token, 'GET', path, undefined, 404);
  await api(a.owner_token, 'POST', `${path}/document`, { content: 'secret', revision: '0'.repeat(64) }, 409);
  await api(a.owner_token, 'POST', `${path}/settings`, { enabled: 'yes' }, 400);
  await api(a.owner_token, 'POST', `${path}/settings`, { enabled: true, provider: 'missing' }, 400);
  const enabled = await api(a.owner_token, 'POST', `${path}/settings`, { enabled: true });
  const saved = await api(a.collaborator_token, 'POST', `${path}/document`, { content: '# Decisions\nUse PostgreSQL.', revision: enabled.document.revision });
  assert.match(await readFile(join(directory, a.workspace_id, a.channel_id, 'memory.md'), 'utf8'), /PostgreSQL/);
  assert.equal((await api(a.owner_token, 'GET', `${path}/search?q=postgresql`)).items.length, 1);
  await api(a.owner_token, 'POST', `${path}/document`, { content: 'Stale replacement', revision: enabled.document.revision }, 409);
  await api(a.owner_token, 'POST', `${path}/settings`, { enabled: false });
  assert.equal((await api(a.owner_token, 'GET', path)).document, null);
  await api(a.owner_token, 'GET', `${path}/search?q=postgresql`, undefined, 409);
  await api(a.owner_token, 'POST', `${path}/document`, { content: 'No', revision: saved.revision }, 409);
  assert.equal((await api(a.owner_token, 'POST', `${path}/settings`, { enabled: true })).document.content, saved.content);
  await new WorkspaceStore(pool).removeMember(a.owner_id, a.workspace_id, a.collaborator_id);
  await api(a.collaborator_token, 'GET', path, undefined, 404);
  await api(a.collaborator_token, 'GET', `${path}/search?q=postgresql`, undefined, 404);
});

test('message/document ingestion preserves sources, rejects foreign sources and serializes concurrent saves', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool), path = base(a.channel_id);
  await api(a.owner_token, 'POST', `${path}/settings`, { enabled: true });
  const send = (text: string, channel = a.channel_id, token = a.owner_token) => api(token, 'POST', `/channels/${channel}/messages`, { text, client_message_id: randomUUID() }, 201);
  const [one, two, foreign] = await Promise.all([send('Use PostgreSQL.'), send('Deploy on Friday.'), send('Private elsewhere.', b.channel_id, b.owner_token)]);
  await api(a.owner_token, 'POST', `${path}/sources`, { message_id: foreign.id }, 404);
  await Promise.all([one, one, two].map(m => api(a.owner_token, 'POST', `${path}/sources`, { message_id: m.id })));
  let doc = (await api(a.owner_token, 'GET', path)).document;
  assert.equal(doc.sources.length, 2);
  assert.equal(doc.content.split('Use PostgreSQL.').length, 2);
  assert.match(doc.content, new RegExp(one.id));
  assert.match(doc.content, /Demo owner/);
  const source = { source_id: randomUUID(), name: 'runbook.md', content: '# Recovery\nRestart the worker.' };
  await api(a.collaborator_token, 'POST', `${path}/sources`, source);
  await api(a.collaborator_token, 'POST', `${path}/sources`, source);
  doc = (await api(a.owner_token, 'GET', path)).document;
  assert.equal(doc.sources.length, 3);
  assert.match(doc.content, /runbook.md/);
  await api(a.owner_token, 'POST', `${path}/sources`, { ...source, name: 'script.exe' }, 400);
  await api(a.owner_token, 'POST', `${path}/sources`, { message_id: one.id, content: 'forged' }, 400);
  await api(a.owner_token, 'GET', `/channels/${a.channel_id}/messages/${one.id}`);
  await api(b.owner_token, 'GET', `/channels/${a.channel_id}/messages/${one.id}`, undefined, 404);
  await api(a.owner_token, 'DELETE', `${path}/sources/message:${one.id}`);
  doc = (await api(a.owner_token, 'GET', path)).document;
  assert.doesNotMatch(doc.content, /Use PostgreSQL/);
  assert.match(doc.content, /Friday/);
  await api(a.owner_token, 'POST', `${path}/settings`, { enabled: false });
  await api(a.collaborator_token, 'DELETE', path, undefined, 403);
  await api(a.owner_token, 'DELETE', path);
  await assert.rejects(readFile(join(directory, a.workspace_id, a.channel_id, 'memory.md')));
  assert.equal((await api(a.owner_token, 'POST', `${path}/settings`, { enabled: true })).document.content, '');
  await migrate(pool);
});

test('trusted custom providers can replace Markdown; disabled and unauthorized requests never reach them', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool), path = base(a.channel_id);
  let calls = 0;
  let stored: MemoryDocument = { content: '', revision: '0'.repeat(64), sources: [] };
  const provider: MemoryProvider = {
    id: 'custom', name: 'User database',
    async read(scope) { assert.equal(scope.channel_id, a.channel_id); calls++; return stored; },
    async write(_scope, content) { calls++; stored = { ...stored, content, revision: '1'.repeat(64) }; return stored; },
    async ingest() { calls++; return stored; }, async remove() { calls++; return stored; },
    async search() { calls++; return [{ text: stored.content, line: 1 }]; },
    async clear() { calls++; stored = { ...stored, content: '' }; },
  };
  const custom = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, memory: { directory, providers: [provider] } });
  const call = (token: string, method: 'GET' | 'POST' | 'DELETE', suffix = '', payload?: object) => custom.inject({ method, url: `/v1${path}${suffix}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  try {
    assert.equal((await call(a.owner_token, 'POST', '/settings', { enabled: false, provider: 'custom' })).statusCode, 200);
    await call(a.owner_token, 'GET');
    assert.equal((await call(a.owner_token, 'GET', '/search?q=secret')).statusCode, 409);
    assert.equal((await call(a.owner_token, 'POST', '/sources', { source_id: randomUUID(), name: 'note.md', content: 'secret' })).statusCode, 409);
    assert.equal(calls, 0);
    assert.equal((await call(a.owner_token, 'POST', '/settings', { enabled: true })).statusCode, 200);
    assert.equal(calls, 1);
    const saved = await call(a.owner_token, 'POST', '/document', { content: 'Custom database memory', revision: stored.revision });
    assert.equal(saved.json().content, 'Custom database memory');
    const count = calls;
    assert.equal((await call(b.owner_token, 'GET')).statusCode, 404);
    assert.equal((await call(a.collaborator_token, 'POST', '/settings', { enabled: false })).statusCode, 403);
    assert.equal(calls, count);
    await assert.rejects(readFile(join(directory, a.workspace_id, a.channel_id, 'memory.md')));
    await call(a.owner_token, 'POST', '/settings', { enabled: false });
    await call(a.owner_token, 'DELETE');
    assert.equal(stored.content, '');
  } finally { await custom.close(); }
});
