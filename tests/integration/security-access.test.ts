import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const schema = `security_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
async function api(token: string, method: 'GET' | 'POST' | 'PATCH', path: string, payload?: object, status = 200) {
  const response = await app.inject({ method, url: `/v1${path}`, headers: { authorization: `Bearer ${token}` }, payload });
  assert.equal(response.statusCode, status, `${path}: ${response.body}`);
  return response.json();
}
async function pair(token: string, workspace: string) {
  const pairing = await api(token, 'POST', `/workspaces/${workspace}/agent-pairings`, {}, 201);
  return api('', 'POST', '/agent-pairings/claim', { code: pairing.code, credential: randomBytes(32).toString('base64url') }, 201);
}

for (const kind of ['single', 'multi']) test(`${kind} guests only enumerate participants in assigned channels, including paginated agents`, async () => {
  const a = await bootstrap(pool), outsider = await bootstrap(pool);
  await api(a.owner_token, 'POST', `/workspaces/${a.workspace_id}/members`, { user_id: outsider.owner_id, role: 'member' }, 201);
  const visible = await pair(a.owner_token, a.workspace_id);
  const hidden = await pair(outsider.owner_token, a.workspace_id);
  // A pre-existing DM must not expand the guest's discovery scope.
  await api(a.collaborator_token, 'POST', `/workspaces/${a.workspace_id}/direct-messages`, { user_id: outsider.owner_id });
  await pool.query('UPDATE workspace_members SET guest_type=$1 WHERE workspace_id=$2 AND user_id=$3', [kind, a.workspace_id, a.collaborator_id]);
  const path = `/workspaces/${a.workspace_id}/participants`;
  const items: { id: string }[] = [];
  let cursor: string | null = null;
  do {
    const page = await api(a.collaborator_token, 'GET', `${path}?limit=1${cursor ? `&after=${cursor}` : ''}`);
    items.push(...page.items); cursor = page.next_cursor;
    assert.ok(items.length <= 10, 'pagination must terminate');
  } while (cursor);
  assert.deepEqual(new Set(items.map(item => item.id)), new Set([a.owner_id, a.collaborator_id, visible.installation_id]));
  const full = await api(a.owner_token, 'GET', path);
  assert.ok(full.items.some((item: { id: string }) => item.id === hidden.installation_id));
  await api(a.owner_token, 'POST', `/channels/${a.channel_id}/members`, { user_id: outsider.owner_id }, 201);
  const shared = await api(a.collaborator_token, 'GET', path);
  assert.ok(shared.items.some((item: { id: string }) => item.id === hidden.installation_id));
});

for (const feature of ['memory', 'navigator']) test(`channel creators converted to guests cannot manage ${feature}`, async () => {
  const a = await bootstrap(pool);
  const channel = await api(a.collaborator_token, 'POST', `/workspaces/${a.workspace_id}/channels`, { name: 'Former creator', private: true }, 201);
  await pool.query("UPDATE workspace_members SET guest_type='multi' WHERE workspace_id=$1 AND user_id=$2", [a.workspace_id, a.collaborator_id]);
  const path = `/channels/${channel.id}/${feature}`;
  assert.equal((await api(a.collaborator_token, 'GET', path)).can_manage, false);
  if (feature === 'memory') {
    await api(a.collaborator_token, 'POST', `${path}/settings`, { enabled: true }, 403);
    await api(a.collaborator_token, 'POST', `${path}/connections`, { name: 'Forbidden', access: 'write' }, 403);
  } else {
    await api(a.collaborator_token, 'PATCH', path, { mode: 'semantic' }, 403);
  }
});
