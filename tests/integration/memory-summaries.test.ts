import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
const schema = `memory_summaries_${randomBytes(6).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

async function post(token: string, channel: string, text: string) {
  const response = await app.inject({ method: 'POST', url: `/v1/channels/${channel}/messages`, headers: { authorization: `Bearer ${token}` }, payload: { client_message_id: randomUUID(), text } });
  assert.equal(response.statusCode, 201, response.body); return response.json();
}
const save = (thread: string, channel: string, message: { id: string; sequence: string }, owner: string, revision: number, summary: string) => pool.query(
  `INSERT INTO memory_revisions(thread_id,channel_id,revision,through_sequence,content,summary,source_message_ids,producer_id,producer_name)
   VALUES($1,$2,$3,$4,$5,$6,ARRAY[$7]::uuid[],$8,'x')`, [thread, channel, revision, message.sequence, '# ' + summary, summary, message.id, owner]);
const visible = async (w: string, requester: string, destination: string, ids: string[]) =>
  (await pool.query('SELECT * FROM memory_visible_summaries($1,$2,$3,$4::uuid[])', [w, requester, destination, ids])).rows;

test('memory summaries: latest revision, only for members, only with the switch on, only the destination channel', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Start');
  await save(root.thread_id, a.channel_id, root, a.owner_id, 1, 'first');
  await save(root.thread_id, a.channel_id, root, a.owner_id, 2, 'second');
  assert.deepEqual(await visible(a.workspace_id, a.owner_id, a.channel_id, [root.thread_id]), [], 'hidden while the channel memory switch is off');

  await pool.query('UPDATE channels SET memory_enabled=true WHERE id=$1', [a.channel_id]);
  const rows = await visible(a.workspace_id, a.owner_id, a.channel_id, [root.thread_id]);
  assert.deepEqual(rows.map(r => [r.thread_id, r.revision, r.summary]), [[root.thread_id, 2, 'second']], 'only the newest revision');

  assert.deepEqual(await visible(a.workspace_id, randomUUID(), a.channel_id, [root.thread_id]), [], 'a stranger sees nothing');
  assert.deepEqual(await visible(b.workspace_id, b.owner_id, b.channel_id, [root.thread_id]), [], 'another workspace never sees these threads');
  assert.deepEqual(await visible(a.workspace_id, a.owner_id, a.channel_id, [randomUUID()]), [], 'unknown thread');
});
