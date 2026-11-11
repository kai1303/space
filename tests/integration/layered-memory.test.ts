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
