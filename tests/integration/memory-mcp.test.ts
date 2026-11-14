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
import { WorkspaceStore } from '@space/postgres/workspace';
import { createApi } from '@space/server/api';
import { messagePath, parseThreadContext } from '@space/contracts';
import type { MemoryProvider } from '@space/core/memory';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
const schema = `memory_mcp_${randomBytes(6).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const directory = await mkdtemp(join(tmpdir(), 'space-memory-mcp-'));
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, memory: { directory } });
let address: string;
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); address = await app.listen({ host: '127.0.0.1', port: 0 }); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(directory, { recursive: true, force: true }); });
async function api(token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: object, expected = 200) {
  const response = await app.inject({ method, url: `/v1${path}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  assert.equal(response.statusCode, expected, response.body); return response.json();
}
async function fixture() {
  const seed = await bootstrap(pool), path = `/channels/${seed.channel_id}/memory`;
  await api(seed.owner_token, 'POST', `${path}/settings`, { enabled: true });
  return { ...seed, path };
}
async function connect(token: string, modern = false) {
  const client = new Client({ name: 'memory-extraction-test-agent', version: '1.0.0' }, modern ? { versionNegotiation: { mode: 'auto' } } : undefined);
  try { await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp/memory`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })); return client; }
  catch (error) { await client.close(); throw error; }
}
function data(result: any) { assert.notEqual(result.isError, true, JSON.stringify(result)); return JSON.parse(result.content[0].text); }

test('a real MCP agent reads context, saves extracted knowledge, searches, updates and forgets using Markdown', async () => {
  const a = await fixture();
  const grant = await api(a.owner_token, 'POST', `${a.path}/connections`, { name: 'Navigator', access: 'write' }, 201);
  const listing = await api(a.owner_token, 'GET', `${a.path}/connections`);
  assert.equal(listing.items[0].name, 'Navigator');
  assert.ok(!JSON.stringify(listing).includes(grant.token));
  assert.ok(!JSON.stringify(listing).includes('token_hash'));
  const persisted = (await pool.query('SELECT token_hash FROM memory_connections WHERE id=$1', [grant.connection.id])).rows[0];
  assert.notEqual(persisted.token_hash, grant.token);
  const message = await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), text: 'We decided to use PostgreSQL because we need transactions.' }, 201);
  const client = await connect(grant.token);
  try {
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['channel_memory', 'memory_context', 'memory_forget', 'memory_read', 'memory_remember', 'memory_search', 'memory_write', 'session_memory', 'thread_memory']);
    const context = data(await client.callTool({ name: 'memory_context', arguments: {} }));
    assert.equal(context.messages[0].id, message.id);
    const entry = { id: randomUUID(), kind: 'decision', title: 'Database choice', content: 'Use PostgreSQL for transactional storage.', message_ids: [message.id] };
    const saved = data(await client.callTool({ name: 'memory_remember', arguments: entry }));
    assert.match(saved.content, /Use PostgreSQL for transactional storage/);
    assert.match(saved.content, /Navigator/);
    assert.ok(saved.content.includes(`[View original](${messagePath(a.channel_id, message.id)})`));
    assert.equal(data(await client.callTool({ name: 'memory_remember', arguments: entry })).sources.length, 1);
    assert.equal((await client.callTool({ name: 'memory_remember', arguments: { ...entry, content: 'Different claim' } })).isError, true);
    assert.ok(data(await client.callTool({ name: 'memory_search', arguments: { query: 'PostgreSQL' } })).items.length);
    const read = data(await client.callTool({ name: 'memory_read', arguments: {} }));
    assert.equal(read.revision, saved.revision);
    const updated = data(await client.callTool({ name: 'memory_write', arguments: { content: `${read.content}\n## Notes\nReviewed.`, revision: read.revision } }));
    assert.equal((await client.callTool({ name: 'memory_write', arguments: { content: 'stale', revision: read.revision } })).isError, true);
    assert.match(updated.content, /Reviewed/);
    const forgotten = data(await client.callTool({ name: 'memory_forget', arguments: { source_id: `knowledge:${entry.id}` } }));
    assert.equal(forgotten.sources.length, 0);
    assert.doesNotMatch(forgotten.content, /Use PostgreSQL for transactional storage/);
  } finally { await client.close(); }
});

test('changes to message evidence invalidate direct and dependent claims and allow a fresh citation', async () => {
  const a = await fixture();
  const messages = `/channels/${a.channel_id}/messages`;
  const source = await api(a.owner_token, 'POST', messages, {client_message_id:randomUUID(), text:'Ship Friday'}, 201);
  const grant = await api(a.owner_token, 'POST', `${a.path}/connections`, {name:'Planner', access:'write'}, 201);
  const client = await connect(grant.token);
  const remember = (args: object) => client.callTool({name:'memory_remember', arguments:{kind:'decision', ...args}});
  try {
    const id = randomUUID();
    data(await remember({id, title:'Date', content:'Friday', message_ids:[source.id]}));
    data(await remember({id:randomUUID(), title:'Announcement', content:'Announce Friday', source_ids:['knowledge:' + id]}));
    await api(a.owner_token, 'PATCH', messages + '/' + source.id, {revision:source.reaction_sequence, document:{ops:[{insert:'Ship Monday'}]}});
    assert.deepEqual(data(await client.callTool({name:'memory_read',arguments:{}})).sources, []);
    const fresh = data(await remember({id:randomUUID(), title:'New date', content:'Monday', message_ids:[source.id]}));
    assert.match(fresh.content, /Monday/);
    await api(a.owner_token, 'DELETE', messages + '/' + source.id);
    assert.deepEqual(data(await client.callTool({name:'memory_search',arguments:{query:'Monday'}})).items, []);
  } finally { await client.close(); }
});

test('read-only keys cannot write, cross-channel evidence is denied, and revocation applies to an open client', async () => {
  const a = await fixture(), b = await fixture();
  await api(a.collaborator_token, 'POST', `${a.path}/connections`, { name: 'Forbidden', access: 'write' }, 403);
  await api(b.owner_token, 'GET', `${a.path}/connections`, undefined, 404);
  const read = await api(a.owner_token, 'POST', `${a.path}/connections`, { name: 'Reader', access: 'read' }, 201);
  const client = await connect(read.token);
  try {
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['channel_memory', 'memory_context', 'memory_read', 'memory_search', 'session_memory', 'thread_memory']);
    await assert.rejects(client.callTool({ name: 'memory_write', arguments: { content: 'not allowed', revision: '0'.repeat(64) } }), /not found/);
    assert.equal((await client.callTool({ name: 'memory_read', arguments: { channel_id: b.channel_id } })).isError, true);
    await api(a.owner_token, 'POST', `${a.path}/connections/${read.connection.id}/revoke`, {});
    await assert.rejects(client.callTool({ name: 'memory_read', arguments: {} }));
  } finally { await client.close(); }
  const write = await api(a.owner_token, 'POST', `${a.path}/connections`, { name: 'Writer', access: 'write' }, 201);
  const writer = await connect(write.token);
  try {
    const foreign = await api(b.owner_token, 'POST', `/channels/${b.channel_id}/messages`, { client_message_id: randomUUID(), text: 'Private elsewhere' }, 201);
    assert.equal((await writer.callTool({ name: 'memory_remember', arguments: { id: randomUUID(), kind: 'fact', title: 'Forged evidence', content: 'Claim', message_ids: [foreign.id] } })).isError, true);
    await api(a.owner_token, 'POST', `${a.path}/settings`, { enabled: false });
    await assert.rejects(writer.callTool({ name: 'memory_read', arguments: {} }));
    await api(a.owner_token, 'POST', `${a.path}/settings`, { enabled: true });
    data(await writer.callTool({ name: 'memory_read', arguments: {} }));
  } finally { await writer.close(); }
});

test('MCP rejects ordinary user tokens, hostile hosts/origins and malformed keys', async () => {
  const a = await fixture();
  await assert.rejects(connect(a.owner_token));
  const grant = await api(a.owner_token, 'POST', `${a.path}/connections`, { name: 'Agent', access: 'read' }, 201);
  for (const headers of [{ origin: 'https://evil.example' }, { host: 'evil.example' }]) {
    const response = await app.inject({ method: 'POST', url: '/mcp/memory', headers: { authorization: `Bearer ${grant.token}`, ...headers }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.equal(response.statusCode, 403);
  }
  await api(a.owner_token, 'POST', `${a.path}/connections`, { name: 'Bad', access: 'admin' }, 400);
  await api(a.owner_token, 'POST', `${a.path}/connections`, { name: 'Bad', access: 'read', channel_id: a.channel_id }, 400);
});

test('modern MCP negotiation works and offboarding the key creator blocks a connected client', async () => {
  const a = await fixture();
  await pool.query("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [a.workspace_id, a.collaborator_id]);
  const grant = await api(a.collaborator_token, 'POST', `${a.path}/connections`, { name: 'Navigator', access: 'read' }, 201);
  const client = await connect(grant.token, true);
  try {
    assert.ok(client.getDiscoverResult());
    data(await client.callTool({ name: 'memory_read', arguments: {} }));
    await new WorkspaceStore(pool).removeMember(a.owner_id, a.workspace_id, a.collaborator_id);
    await assert.rejects(client.callTool({ name: 'memory_read', arguments: {} }));
  } finally { await client.close(); }
});

test('MCP uses the same selected custom provider as human memory routes', async () => {
  const a = await fixture();
  let reads = 0;
  const read = async () => { reads++; return { content: 'Knowledge in a user database', revision: 'a'.repeat(64), sources: [] }; };
  const provider: MemoryProvider = { id: 'custom', name: 'User database', onMessageChanged: async () => {}, read, write: read, ingest: read, remove: read, search: async () => [{ text: 'Custom search', line: 1 }], clear: async () => {} };
  const custom = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, memory: { directory, providers: [provider] } });
  const customAddress = await custom.listen({ host: '127.0.0.1', port: 0 });
  let client: Client | undefined;
  try {
    const selected = await custom.inject({ method: 'POST', url: `/v1${a.path}/settings`, headers: { authorization: `Bearer ${a.owner_token}` }, payload: { enabled: true, provider: 'custom' } });
    assert.equal(selected.statusCode, 200);
    const grant = await api(a.owner_token, 'POST', `${a.path}/connections`, { name: 'Custom provider agent', access: 'contribute' }, 201);
    client = new Client({ name: 'custom-provider-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${customAddress}/mcp/memory`), { requestInit: { headers: { Authorization: `Bearer ${grant.token}` } } }));
    assert.equal(data(await client.callTool({ name: 'memory_read', arguments: {} })).content, 'Knowledge in a user database');
    assert.equal(data(await client.callTool({ name: 'memory_search', arguments: { query: 'custom' } })).items[0].text, 'Custom search');
    assert.ok(reads >= 2);
    const message = await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, {client_message_id: randomUUID(), text: 'A cited message'}, 201);
    data(await client.callTool({ name: 'memory_remember', arguments: {id: randomUUID(), kind: 'fact',
      title: 'Saved claim', content: 'An extracted fact', message_ids: [message.id]} }));
    await api(a.owner_token, 'POST', `${a.path}/settings`, {enabled: false});
    await api(a.owner_token, 'DELETE', `/channels/${a.channel_id}/messages/${message.id}`);
    const {rows} = await pool.query(`SELECT aggregate_id,payload->>'type' AS type,has_quote
      FROM event_outbox JOIN memory_provider_message_refs r ON r.message_id=(payload->>'message_id')::uuid
      WHERE kind='memory.provider.changed' AND r.message_id=$1`, [message.id]);
    assert.deepEqual(rows, [{aggregate_id: 'custom', type: 'deleted', has_quote: false}]);
  } finally { await client?.close(); await custom.close(); }
});

test('agents can extract knowledge from imported documents with validated source references', async () => {
  const a = await fixture(), sourceId = randomUUID();
  await api(a.owner_token, 'POST', `${a.path}/sources`, { source_id: sourceId, name: 'runbook.md', content: 'Restart the worker and verify health.' });
  const grant = await api(a.owner_token, 'POST', `${a.path}/connections`, { name: 'Runbook agent', access: 'write' }, 201);
  const client = await connect(grant.token);
  try {
    const input = { id: randomUUID(), kind: 'procedure', title: 'Worker recovery', content: 'Restart the worker, then verify its health.', source_ids: [`document:${sourceId}`] };
    const saved = data(await client.callTool({ name: 'memory_remember', arguments: input }));
    assert.match(saved.content, /Worker recovery/);
    assert.match(saved.content, new RegExp(`document:${sourceId}`));
    assert.equal(saved.sources.length, 2);
    assert.equal((await client.callTool({ name: 'memory_remember', arguments: { ...input, id: randomUUID(), source_ids: [`document:${randomUUID()}`] } })).isError, true);
  } finally { await client.close(); }
});

test('thread-scoped MCP works with channel memory off and preserves source-backed working memory', async () => {
  const a = await bootstrap(pool);
  const root = await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), text: 'Build a guide. Keep the examples in TypeScript. ' + 'Details '.repeat(200) }, 201);
  const path = `/channels/${a.channel_id}/threads/${root.thread_id}/context`;
  const grant = await api(a.owner_token, 'POST', `${path}/connections`, { name: 'Thread agent', access: 'write' }, 201);
  const client = await connect(grant.token);
  try {
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['thread_context', 'thread_message', 'thread_messages']);
    const initial = data(await client.callTool({ name: 'thread_context', arguments: {} }));
    assert.equal(initial.root.id, root.id);
    assert.equal(initial.root.text_truncated, true);
    assert.equal(data(await client.callTool({ name: 'thread_message', arguments: { message_id: root.id } })).text, root.text);
    for (let i = 0; i < 18; i++) await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), thread_id: root.thread_id, text: `Feedback ${i}` }, 201);
    const current = data(await client.callTool({ name: 'thread_context', arguments: {} }));
    assert.equal(current.root.id, root.id);
    assert.equal(current.messages.length, 16);
    assert.equal(current.has_earlier_messages, true);
    const first = data(await client.callTool({ name: 'thread_messages', arguments: { limit: 2 } }));
    assert.equal(first.messages[0].id, root.id);
    assert.equal(first.has_more, true);
    const second = data(await client.callTool({ name: 'thread_messages', arguments: { after: first.cursor, limit: 2 } }));
    assert.notEqual(second.messages[0].id, root.id);
    await assert.rejects(client.callTool({ name: 'memory_read', arguments: {} }), /not found/);
    assert.equal((await client.callTool({ name: 'thread_context', arguments: { thread_id: randomUUID() } })).isError, true);
    const foreign = await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), text: 'Other thread' }, 201);
    assert.equal((await client.callTool({ name: 'thread_message', arguments: { message_id: foreign.id } })).isError, true);
    const human = await api(a.owner_token, 'GET', path);
    assert.equal(human.root.id, root.id);
    await api(a.owner_token, 'POST', `/channels/${a.channel_id}/memory/connections/${grant.connection.id}/revoke`, {});
    await assert.rejects(client.callTool({ name: 'thread_context', arguments: {} }));
  } finally { await client.close(); }
});

test('thread MCP read grants cannot save memory and inaccessible threads cannot be granted', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const root = await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), text: 'Request' }, 201);
  const path = `/channels/${a.channel_id}/threads/${root.thread_id}/context`;
  await api(b.owner_token, 'POST', `${path}/connections`, { name: 'Foreign', access: 'read' }, 404);
  await api(a.collaborator_token, 'POST', `${path}/connections`, { name: 'Unmanaged', access: 'write' }, 403);
  const grant = await api(a.owner_token, 'POST', `${path}/connections`, { name: 'Read agent', access: 'read' }, 201);
  const client = await connect(grant.token);
  try {
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['thread_context', 'thread_message', 'thread_messages']);
    await assert.rejects(client.callTool({ name: 'thread_memory_save', arguments: {} }), /not found/);
    data(await client.callTool({ name: 'thread_context', arguments: {} }));
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2', [a.channel_id, a.owner_id]);
    await assert.rejects(client.callTool({ name: 'thread_context', arguments: {} }));
  } finally { await client.close(); }
});

test('earlier context excludes later messages', async () => {
  const a = await bootstrap(pool);
  const root = await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), text: 'Start' }, 201);
  const grant = await api(a.owner_token, 'POST', `/channels/${a.channel_id}/threads/${root.thread_id}/context/connections`, { name: 'Context agent', access: 'read' }, 201);
  const client = await connect(grant.token);
  try {
    const initial = data(await client.callTool({ name: 'thread_context', arguments: {} }));
    await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), thread_id: root.thread_id, text: 'Later decision' }, 201);
    const { readThreadContext } = await import('@space/postgres/thread-context');
    const earlier = await readThreadContext(new PostgresStore(pool).db, a.channel_id, root.thread_id, initial.through_sequence);
    assert.equal(earlier.messages.length, 1);
    assert.equal(earlier.messages[0]!.id, root.id);
  } finally { await client.close(); }
});

test('Unicode excerpts remain valid at invocation boundaries and full message text is recoverable', async () => {
  const a = await bootstrap(pool);
  const root = await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), text: 'a'.repeat(999) + '😀' }, 201);
  const grant = await api(a.owner_token, 'POST', `/channels/${a.channel_id}/threads/${root.thread_id}/context/connections`, { name: 'Unicode agent', access: 'read' }, 201);
  const client = await connect(grant.token);
  try {
    const context = data(await client.callTool({ name: 'thread_context', arguments: {} }));
    assert.doesNotThrow(() => parseThreadContext(context));
    assert.equal(context.root.text_truncated, true);
    assert.equal(context.root.text, 'a'.repeat(999));
    assert.equal(data(await client.callTool({ name: 'thread_message', arguments: { message_id: root.id } })).text, root.text);
  } finally { await client.close(); }
});
