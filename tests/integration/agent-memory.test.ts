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
import { parseInvocation } from '@space/contracts';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
const schema = `agent_memory_${randomBytes(6).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const directory = await mkdtemp(join(tmpdir(), 'space-agent-memory-'));
const store = new PostgresStore(pool);
const app = createApi(store, { allowDevelopmentTokens: true, memory: { directory } });
let address: string;
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); address = await app.listen({ host: '127.0.0.1', port: 0 }); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(directory, { recursive: true, force: true }); });
async function api(token: string, method: 'GET' | 'POST', path: string, payload?: object, expected = 200) {
  const response = await app.inject({ method, url: `/v1${path}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  assert.equal(response.statusCode, expected, response.body); return response.json();
}
async function fixture() {
  const seed = await bootstrap(pool), path = `/channels/${seed.channel_id}/memory`;
  await api(seed.owner_token, 'POST', `${path}/settings`, { enabled: true });
  await api(seed.owner_token, 'POST', `${path}/sources`, { source_id: randomUUID(), name: 'notes.md', content: 'Use PostgreSQL for durable state.' });
  return { ...seed, path };
}
async function grant(a: Awaited<ReturnType<typeof fixture>>, access: string, expected = 200, token = a.owner_token) {
  return api(token, 'POST', `${a.path}/agents/${a.installation_id}`, { access }, expected);
}
async function prepared(a: Awaited<ReturnType<typeof fixture>>) {
  const task = await store.createTask(a.owner_id, { workspace_id: a.workspace_id, thread_id: a.thread_id, installation_id: a.installation_id, goal: 'Read notes', skill: 'demo.echo' }, randomUUID());
  await store.approveTask(a.owner_id, task.id);
  const outbox = (await pool.query('SELECT id FROM outbox WHERE task_id=$1', [task.id])).rows[0];
  const delivery = await store.claimDelivery(undefined, outbox.id);
  assert.ok(delivery); return store.prepareDelivery(delivery);
}
async function connect(token: string) {
  const client = new Client({ name: 'agent-memory-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp/memory`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

test('memory is a separate manager opt-in and read context is bounded and withheld after disable/revoke', async () => {
  const a = await fixture(), foreign = await fixture();
  const listing = await api(a.owner_token, 'GET', `${a.path}/agents`);
  assert.equal(listing.items.find((item: any) => item.id === a.installation_id).access, 'none');
  assert.equal((await prepared(a))?.request.context?.channel_notes, undefined);
  await grant(a, 'read', 403, a.collaborator_token);
  await api(foreign.owner_token, 'POST', `${a.path}/agents/${a.installation_id}`, { access: 'read' }, 404);
  await api(a.owner_token, 'POST', `${a.path}/agents/${foreign.installation_id}`, { access: 'read' }, 404);
  await grant(a, 'write', 400);
  await grant(a, 'read');
  const result = await prepared(a); assert.ok(result);
  assert.match(result.request.context!.channel_notes!.content, /PostgreSQL/);
  assert.deepEqual(parseInvocation(result.request), result.request);
  const layered = result.request.context!;
  assert.ok(Array.isArray(layered.channel_memory!.nodes));
  assert.equal(layered.agent_session_memory?.node.ref.id, result.request.session_id);
  const document = (await api(a.owner_token, 'GET', a.path)).document;
  await api(a.owner_token, 'POST', `${a.path}/document`, { revision: document.revision, content: '😀'.repeat(10000) });
  const bounded = (await prepared(a))!.request.context!.channel_notes!;
  assert.ok(bounded.content.length <= 6000); assert.equal(bounded.truncated, true);
  assert.equal(Buffer.from(bounded.content).toString(), bounded.content);
  await api(a.owner_token, 'POST', `${a.path}/settings`, { enabled: false });
  assert.equal((await prepared(a))?.request.context?.channel_notes, undefined);
  await api(a.owner_token, 'POST', `${a.path}/settings`, { enabled: true });
  await grant(a, 'none');
  assert.equal((await prepared(a))?.request.context?.channel_notes, undefined);
});

test('installation-bound contribute keys can add evidence but cannot replace/delete, and live downgrade is enforced', async () => {
  const a = await fixture();
  await api(a.owner_token, 'POST', `${a.path}/connections`, { name: 'Agent', installation_id: a.installation_id, access: 'read' }, 403);
  await grant(a, 'contribute');
  await api(a.owner_token, 'POST', `${a.path}/connections`, { name: 'Agent', installation_id: a.installation_id, access: 'write' }, 403);
  const issued = await api(a.owner_token, 'POST', `${a.path}/connections`, { name: 'Agent', installation_id: a.installation_id, access: 'contribute' }, 201);
  const client = await connect(issued.token);
  try {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(names.includes('memory_remember')); assert.ok(!names.includes('memory_write')); assert.ok(!names.includes('memory_forget'));
    const source = (await api(a.owner_token, 'GET', a.path)).document.sources[0].id;
    const claim = { id: randomUUID(), kind: 'decision', title: 'Database', content: 'Use PostgreSQL', source_ids: [source] };
    assert.notEqual((await client.callTool({ name: 'memory_remember', arguments: claim })).isError, true);
    await grant(a, 'read');
    assert.equal((await client.callTool({ name: 'memory_remember', arguments: { ...claim, id: randomUUID() } })).isError, true);
    assert.notEqual((await client.callTool({ name: 'memory_read', arguments: {} })).isError, true);
    await grant(a, 'none');
    const response = await app.inject({ method: 'POST', url: '/mcp/memory', headers: { authorization: `Bearer ${issued.token}` }, payload: {} });
    assert.equal(response.statusCode, 403);
  } finally { await client.close(); }
});

test('dispatch rechecks permission after provider I/O and never reads disabled/ungranted memory', async () => {
  const { MemoryStore } = await import('@space/postgres/memory');
  const { createAgentMemoryReader } = await import('@space/server/memory');
  const { MarkdownMemoryProvider } = await import('@space/server/markdown-memory');
  const a = await fixture();
  const provider = new MarkdownMemoryProvider(directory);
  const original = provider.read.bind(provider);
  let entered!: () => void, release!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  provider.read = async scope => { calls++; entered(); await wait; return original(scope); };
  const reader = createAgentMemoryReader(new MemoryStore(pool), new Map([['markdown', provider]]));
  const task = { installation_id: a.installation_id, requester_id: a.owner_id, thread_id: a.thread_id };
  assert.equal(await reader(task), undefined); assert.equal(calls, 0);
  await grant(a, 'read');
  const pending = reader(task);
  await started;
  await grant(a, 'none');
  release();
  await assert.rejects(pending, /memory_settings_changed/);
  await grant(a, 'read');
  await pool.query('UPDATE agent_installations SET enabled=false WHERE id=$1', [a.installation_id]);
  assert.equal(await reader(task), undefined); assert.equal(calls, 1);
});

test('dispatch bounds outstanding provider reads and fails closed when a provider is missing', async () => {
  const { MemoryStore } = await import('@space/postgres/memory');
  const { createAgentMemoryReader } = await import('@space/server/memory');
  const { MarkdownMemoryProvider } = await import('@space/server/markdown-memory');
  const a = await fixture(); await grant(a, 'read');
  const task = { installation_id: a.installation_id, requester_id: a.owner_id, thread_id: a.thread_id };
  await assert.rejects(createAgentMemoryReader(new MemoryStore(pool), new Map())(task), /memory_provider_unavailable/);
  const provider = new MarkdownMemoryProvider(directory);
  const original = provider.read.bind(provider);
  let calls = 0, entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  provider.read = async scope => { if (++calls === 8) entered(); await wait; return original(scope); };
  const reader = createAgentMemoryReader(new MemoryStore(pool), new Map([['markdown', provider]]));
  const pending = Array.from({ length: 8 }, () => reader(task));
  // Observe rejections immediately, even if a failing implementation lets timeouts expire.
  const all = Promise.allSettled(pending);
  await started;
  try { await assert.rejects(reader(task), /memory_provider_busy/); assert.equal(calls, 8); }
  finally { release(); await all; }
});

test('revoking contribution during evidence retrieval prevents a subsequent provider mutation', async () => {
  const { MarkdownMemoryProvider } = await import('@space/server/markdown-memory');
  const a = await fixture(); await grant(a, 'contribute');
  const source = (await api(a.owner_token, 'GET', a.path)).document.sources[0].id;
  const key = await api(a.owner_token, 'POST', `${a.path}/connections`, { name: 'Race agent', installation_id: a.installation_id, access: 'contribute' }, 201);
  const base = new MarkdownMemoryProvider(directory);
  let entered!: () => void, release!: () => void, writes = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const provider = { id: 'paused', name: 'Paused',
    read: async (scope: Parameters<typeof base.read>[0]) => { entered(); await wait; return base.read(scope); },
    ingest: async (...args: Parameters<typeof base.ingest>) => { writes++; return base.ingest(...args); },
    write: base.write.bind(base), remove: base.remove.bind(base), search: base.search.bind(base), clear: base.clear.bind(base),
  };
  const isolated = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, memory: { directory, providers: [provider] } });
  const origin = await isolated.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'race', version: '1' });
  try {
    await pool.query("UPDATE channels SET memory_provider='paused' WHERE id=$1", [a.channel_id]);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp/memory`), { requestInit: { headers: { Authorization: `Bearer ${key.token}` } } }));
    const result = client.callTool({ name: 'memory_remember', arguments: { id: randomUUID(), kind: 'decision', title: 'Late claim', content: 'Must not save this', source_ids: [source] } });
    await started; await grant(a, 'none'); release();
    assert.equal((await result).isError, true); assert.equal(writes, 0);
  } finally { release(); await client.close(); await isolated.close(); }
});
