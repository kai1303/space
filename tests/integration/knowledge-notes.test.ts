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
