import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { createApi } from '@space/server/api';
import { PostgresStore } from '@space/postgres/store';
import { FoundationStore } from '@space/postgres/foundation';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const schema = `independent_workspaces_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
const store = new PostgresStore(pool), app = createApi(store, { allowDevelopmentTokens: true });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

async function api(token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: object, status = 200) {
  const result = await app.inject({ method, url: `/v1${path}`, headers: { authorization: `Bearer ${token}` }, ...(body ? { payload: body } : {}) });
  assert.equal(result.statusCode, status, `${method} ${path}: ${result.body}`);
  return status === 204 ? undefined : result.json();
}

test('workspace creation assigns its creator as owner without an organization', async () => {
  const a = await bootstrap(pool);
  const workspace = await api(a.owner_token, 'POST', '/workspaces', { name: '  Engineering  ' }, 201);
  assert.equal(workspace.name, 'Engineering');
  assert.equal(workspace.role, 'owner');
  assert.equal('organization_id' in workspace, false);
  assert.equal((await api(a.owner_token, 'GET', `/workspaces/${workspace.id}`)).role, 'owner');
  assert.equal((await pool.query('SELECT * FROM workspace_members WHERE workspace_id=$1', [workspace.id])).rowCount, 1);
  await api(a.owner_token, 'POST', '/workspaces', { name: 'Legacy input', organization_id: a.workspace_id }, 400);
});

test('organization routes are removed', async () => {
  const a = await bootstrap(pool);
  for (const [method, path] of [
    ['GET', '/organizations'], ['POST', '/organizations'],
    ['GET', `/organizations/${a.workspace_id}`], ['PATCH', `/organizations/${a.workspace_id}`],
    ['GET', `/organizations/${a.workspace_id}/members`], ['POST', `/organizations/${a.workspace_id}/members`],
    ['PATCH', `/organizations/${a.workspace_id}/members/${a.owner_id}`], ['DELETE', `/organizations/${a.workspace_id}/members/${a.owner_id}`],
    ['GET', `/organizations/${a.workspace_id}/workspaces`], ['POST', `/organizations/${a.workspace_id}/workspaces`],
  ] as const) {
    await api(a.owner_token, method, path, method === 'POST' || method === 'PATCH' ? { name: 'Removed' } : undefined, 404);
  }
});

test('membership and authority in one workspace grant no access to another', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const second = await api(a.owner_token, 'POST', '/workspaces', { name: 'Second' }, 201);
  await api(a.owner_token, 'POST', `/workspaces/${second.id}/members`, { user_id: b.owner_id, role: 'admin' }, 201);
  await api(b.owner_token, 'PATCH', `/workspaces/${second.id}`, { name: 'Admin renamed' });
  await api(b.owner_token, 'GET', `/workspaces/${a.workspace_id}`, undefined, 404);
  await api(b.owner_token, 'GET', `/workspaces/${a.workspace_id}/members`, undefined, 404);
  await api(b.owner_token, 'GET', `/threads/${a.thread_id}/messages`, undefined, 404);
  await api(b.owner_token, 'POST', `/workspaces/${a.workspace_id}/members`, { user_id: b.owner_id, role: 'owner' }, 404);
  const visible = (await api(b.owner_token, 'GET', '/workspaces')).items.map((item: { id: string }) => item.id);
  assert.deepEqual(new Set(visible), new Set([b.workspace_id, second.id]));
  assert.equal((await api(b.owner_token, 'GET', `/workspaces/${b.workspace_id}`)).role, 'owner');
  assert.equal((await api(b.owner_token, 'GET', `/workspaces/${second.id}`)).role, 'admin');
});

test('removing membership affects only that workspace and preserves other memberships and agent access', async () => {
  const a = await bootstrap(pool);
  const second = await api(a.owner_token, 'POST', '/workspaces', { name: 'Second' }, 201);
  await api(a.owner_token, 'POST', `/workspaces/${second.id}/members`, { user_id: a.collaborator_id, role: 'owner' }, 201);
  const foundation = new FoundationStore(pool);
  const installation = await foundation.install(a.collaborator_id, { workspace_id: second.id, definition_id: a.definition_id, connector_id: 'mock' });
  await api(a.owner_token, 'DELETE', `/workspaces/${a.workspace_id}/members/${a.collaborator_id}`, undefined, 204);
  await api(a.collaborator_token, 'GET', `/workspaces/${a.workspace_id}`, undefined, 404);
  await api(a.collaborator_token, 'GET', `/threads/${a.thread_id}/messages`, undefined, 404);
  assert.equal((await api(a.collaborator_token, 'GET', `/workspaces/${second.id}`)).role, 'owner');
  assert.equal((await foundation.list(a.collaborator_id, second.id)).find(item => item.id === installation.id)?.enabled, true);
  await api(a.collaborator_token, 'PATCH', `/workspaces/${second.id}`, { name: 'Still independent' });
});
