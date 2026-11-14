import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { bootstrap } from '@space/postgres/bootstrap';
import { ChatStore } from '@space/postgres/chat';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';
import { Pool } from 'pg';
import { parseResourceSubscription, resourceRevision } from '../../apps/server/dist/resource-updates.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const schema = `sidebar_api_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true });
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
after(async () => {
  await app.close();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

async function api(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, token?: string, payload?: object, status = 200) {
  const response = await app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
  assert.equal(response.statusCode, status, response.body);
  return response.json();
}

test('sections routes retain personal assignments, validate input and require workspace access', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const base = `/v1/workspaces/${a.workspace_id}`;
  const sections = `${base}/sidebar-sections`;
  const assignment = `${base}/sidebar-section-assignments/${a.channel_id}`;
  const id = randomUUID(), token = a.owner_token, empty = { sections: [], assignments: [] };
  await api('GET', sections, undefined, undefined, 401);
  await api('GET', sections, b.owner_token, undefined, 404);
  const staleActor = await app.inject({ method: 'POST', url: sections, headers: { authorization: `Bearer ${token}`, 'x-expected-actor': a.collaborator_id }, payload: { id, name: 'Stale tab' } });
  assert.equal(staleActor.statusCode, 409);
  for (const body of [{ id, name: ' ' }, { id, name: 'x'.repeat(81) }, { id, name: 'a', actor_id: b.owner_id }, { id, name: 'a', channel_id: 'invalid' }]) {
    await api('POST', sections, token, body, 400);
  }
  await api('POST', sections, token, { id, name: 'a', channel_id: b.channel_id }, 404);
  assert.deepEqual(await api('GET', sections, token), empty);
  const created = await api('POST', sections, token, { id, name: '  Releases  ', channel_id: a.channel_id }, 201);
  assert.deepEqual(created.sections, [{ id, name: 'Releases', collapsed: false }]);
  assert.deepEqual(created.assignments, [{ channel_id: a.channel_id, section_id: id, name: 'general', kind: 'channel', private: false }]);
  assert.deepEqual(await api('GET', sections, a.collaborator_token), empty);
  await api('PATCH', `${sections}/${id}`, a.collaborator_token, { name: 'Stolen' }, 404);
  for (const body of [{}, { collapsed: 1 }, { owner_id: b.owner_id }]) await api('PATCH', `${sections}/${id}`, token, body, 400);
  assert.deepEqual((await api('PATCH', `${sections}/${id}`, token, { name: 'Plans', collapsed: true })).sections,
    [{ id, name: 'Plans', collapsed: true }]);
  await api('PUT', assignment, token, {}, 400);
  assert.deepEqual((await api('PUT', assignment, token, { section_id: null })).assignments, []);
  assert.deepEqual((await api('PUT', assignment, token, { section_id: id })).assignments, created.assignments);
  assert.deepEqual(await api('DELETE', `${sections}/${id}`, token), empty);
  assert.deepEqual(await api('GET', sections, token), empty);
});

test('sidebar revisions follow private edits and access changes without subscribing to workspace messages', async () => {
  const a = await bootstrap(pool);
  const chat = new ChatStore(pool);
  const sub = parseResourceSubscription({ scope: 'sidebar-sections', id: a.workspace_id });
  const other = { ...sub };
  const initial = await resourceRevision(chat, a.owner_id, sub);
  const otherInitial = await resourceRevision(chat, a.collaborator_id, other);
  assert.deepEqual(sub.keys, ['global', `workspace:${a.workspace_id}`, `actor:${a.owner_id}`]);
  await pool.query("INSERT INTO chat_delivery_outbox(workspace_id,channel_id,resource_scope) VALUES($1,$2,'message')", [a.workspace_id, a.channel_id]);
  assert.equal(await resourceRevision(chat, a.owner_id, sub), initial);
  await api('POST', `/v1/workspaces/${a.workspace_id}/sidebar-sections`, a.owner_token, { id: randomUUID(), name: 'Today' }, 201);
  assert.notEqual(await resourceRevision(chat, a.owner_id, sub), initial);
  assert.equal(await resourceRevision(chat, a.collaborator_id, other), otherInitial);
  await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2', [a.workspace_id, a.collaborator_id]);
  await assert.rejects(resourceRevision(chat, a.collaborator_id, other), { status: 404 });
});
