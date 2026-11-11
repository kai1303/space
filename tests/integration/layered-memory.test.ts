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

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
const schema = `layered_memory_${randomBytes(6).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const directory = await mkdtemp(join(tmpdir(), 'space-layered-memory-'));
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, memory: { directory } });
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
async function connect(token: string) {
  const client = new Client({ name: 'layered-memory-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp/memory`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
function data(result: any) { assert.notEqual(result.isError, true, JSON.stringify(result)); return JSON.parse(result.content[0].text); }
function code(result: any) { assert.equal(result.isError, true, JSON.stringify(result)); return result.content[0].text as string; }

test('migration backfills summary and channel_id and allows session rows', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Start');
  const columns = (await pool.query(`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='thread_checkpoints'`, [schema])).rows;
  const byName = Object.fromEntries(columns.map(c => [c.column_name, c.is_nullable]));
  assert.equal(byName.summary, 'NO');
  assert.equal(byName.channel_id, 'NO');
  assert.equal(byName.session_id, 'YES');
  await pool.query(`INSERT INTO thread_checkpoints(thread_id,channel_id,revision,through_sequence,content,summary,source_message_ids,producer_id,producer_name)
    VALUES($1,$2,1,$3,'# A\nB','A',ARRAY[$4]::uuid[],$5,'x')`, [root.thread_id, a.channel_id, root.sequence, root.id, a.owner_id]);
  await assert.rejects(pool.query(`INSERT INTO thread_checkpoints(thread_id,channel_id,revision,through_sequence,content,summary,source_message_ids,producer_id,producer_name)
    VALUES($1,$2,1,$3,'dup','dup',ARRAY[$4]::uuid[],$5,'x')`, [root.thread_id, a.channel_id, root.sequence, root.id, a.owner_id]), /duplicate key/);
});

async function threadKey(token: string, channel: string, thread: string, access: 'read' | 'write' = 'write') {
  return (await api(token, 'POST', `/channels/${channel}/threads/${thread}/context/connections`, { name: `Agent ${randomUUID().slice(0, 8)}`, access }, 201)).token as string;
}

test('concurrent thread checkpoints: one wins, the other gets 409, both revisions stay readable', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Start');
  const client = await connect(await threadKey(a.owner_token, a.channel_id, root.thread_id));
  try {
    const context = data(await client.callTool({ name: 'thread_context', arguments: {} }));
    const input = { revision: 0, through_sequence: context.through_sequence, content: '# Decisions\nA', summary: 'A', source_message_ids: [root.id] };
    const results = await Promise.all([
      client.callTool({ name: 'thread_checkpoint', arguments: input }),
      client.callTool({ name: 'thread_checkpoint', arguments: { ...input, content: '# Decisions\nB', summary: 'B' } }),
    ]);
    assert.equal(results.filter(r => !r.isError).length, 1);
    assert.equal(code(results.find(r => r.isError)), 'thread_checkpoint_conflict');
    const second = data(await client.callTool({ name: 'thread_checkpoint', arguments: { ...input, revision: 1, summary: 'C' } }));
    assert.equal(second.revision, 2);
    const stored = await pool.query('SELECT revision FROM thread_checkpoints WHERE thread_id=$1 AND session_id IS NULL ORDER BY revision', [root.thread_id]);
    assert.deepEqual(stored.rows.map(r => r.revision), [1, 2]);
  } finally { await client.close(); }
});

test('thread checkpoint validates summary and size with stable codes', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Start');
  const client = await connect(await threadKey(a.owner_token, a.channel_id, root.thread_id));
  try {
    const context = data(await client.callTool({ name: 'thread_context', arguments: {} }));
    const input = { revision: 0, through_sequence: context.through_sequence, content: 'ok', summary: 'ok', source_message_ids: [root.id] };
    assert.equal(code(await client.callTool({ name: 'thread_checkpoint', arguments: { ...input, content: 'x'.repeat(6001) } })), 'checkpoint_too_large');
    assert.equal(code(await client.callTool({ name: 'thread_checkpoint', arguments: { ...input, summary: 'x'.repeat(281) } })), 'invalid_summary');
    assert.equal(code(await client.callTool({ name: 'thread_checkpoint', arguments: { ...input, revision: 5 } })), 'thread_checkpoint_conflict');
  } finally { await client.close(); }
});
