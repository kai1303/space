import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const schema = `security_mentions_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
async function api(token: string, method: 'GET' | 'POST', path: string, payload?: object, status = 200) {
  const response = await app.inject({ method, url: `/v1${path}`, headers: { authorization: `Bearer ${token}` }, payload });
  assert.equal(response.statusCode, status, `${path}: ${response.body}`);
  return response.json();
}

for (const kind of ['single', 'multi']) test(`${kind} guests cannot read public-channel mention previews outside their assignments`, async () => {
  const a = await bootstrap(pool);
  const channel = await api(a.owner_token, 'POST', `/workspaces/${a.workspace_id}/channels`, { name: 'Unassigned public channel', private: false }, 201);
  const mention = (id: string) => api(a.owner_token, 'POST', `/channels/${id}/messages`, {
    client_message_id: randomUUID(), text: '@Demo collaborator confidential discussion',
    document: { ops: [{ insert: '@Demo collaborator', attributes: { mention: { kind: 'user', id: a.collaborator_id, label: 'Demo collaborator' } } }, { insert: ' confidential discussion\n' }] },
  }, 201);
  const path = `/workspaces/${a.workspace_id}/mentions`;
  await mention(channel.id);
  const original = await api(a.collaborator_token, 'GET', path);
  assert.equal(original.items.length, 1, 'full members retain public-channel mention discovery');
  await pool.query('UPDATE workspace_members SET guest_type=$1 WHERE workspace_id=$2 AND user_id=$3', [kind, a.workspace_id, a.collaborator_id]);
  const hidden = await api(a.collaborator_token, 'GET', path);
  assert.deepEqual(hidden.items, []);
  assert.equal(hidden.unread_count, 0);
  await api(a.collaborator_token, 'POST', `${path}/${original.items[0].id}/read`, {}, 404);
  const message = await mention(channel.id);
  assert.equal((await pool.query('SELECT 1 FROM mention_notifications WHERE message_id=$1 AND user_id=$2', [message.id, a.collaborator_id])).rowCount, 0);
  await mention(a.channel_id);
  assert.equal((await api(a.collaborator_token, 'GET', path)).items.length, 1);
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2', [a.channel_id, a.collaborator_id]);
  assert.deepEqual((await api(a.collaborator_token, 'GET', path)).items, []);
});
