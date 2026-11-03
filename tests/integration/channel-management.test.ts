import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const schema = `channel_management_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 10 });
const store = new PostgresStore(pool), app = createApi(store, { allowDevelopmentTokens: true });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
async function api(token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: object, status = 200) {
  const response = await app.inject({ method, url: `/v1${path}`, headers: { authorization: `Bearer ${token}` }, ...(body ? { payload: body } : {}) });
  assert.equal(response.statusCode, status, `${method} ${path}: ${response.body}`);
  return status === 204 ? undefined : response.json();
}

test('details persist partial metadata updates and reject authority or malformed fields', async () => {
  const a = await bootstrap(pool);
  const path = `/channels/${a.channel_id}`;
  const initial = await api(a.owner_token, 'GET', path);
  assert.equal(initial.can_manage, true); assert.equal(initial.member_count, 2);
  assert.equal(initial.topic, ''); assert.equal(initial.description, ''); assert.equal(initial.archived_at, null);
  const updated = await api(a.owner_token, 'PATCH', path, { name: ' product ', topic: ' Next milestone ', description: ' Product conversations\nAnd plans ' });
  assert.equal(updated.name, 'product'); assert.equal(updated.topic, 'Next milestone');
  assert.equal(updated.description, 'Product conversations\nAnd plans');
  await api(a.owner_token, 'PATCH', path, { topic: '' });
  const saved = await api(a.owner_token, 'GET', path);
  assert.equal(saved.topic, ''); assert.equal(saved.description, updated.description);
  for (const input of [{}, { name: ' ' }, { topic: 'x'.repeat(251) }, { description: 'x'.repeat(2001) }, { topic: null }, { topic: 'x\0' }, { archived: 'yes' }, { private: true }, { created_by: a.collaborator_id }]) await api(a.owner_token, 'PATCH', path, input, 400);
  const summaries = await api(a.owner_token, 'GET', `/workspaces/${a.workspace_id}/channels`);
  assert.equal(summaries.items.find((c: any) => c.id === a.channel_id).description, updated.description);
  await migrate(pool);
  assert.equal((await api(a.owner_token, 'GET', path)).name, 'product');
});

test('private details and member lists require membership, management requires creator or admin', async () => {
  const a = await bootstrap(pool), outside = await bootstrap(pool);
  const privateChannel = await api(a.owner_token, 'POST', `/workspaces/${a.workspace_id}/channels`, { name: 'private', private: true }, 201);
  for (const token of [a.collaborator_token, outside.owner_token]) {
    await api(token, 'GET', `/channels/${privateChannel.id}`, undefined, 404);
    await api(token, 'GET', `/channels/${privateChannel.id}/members`, undefined, 404);
  }
  const detail = await api(a.collaborator_token, 'GET', `/channels/${a.channel_id}`);
  assert.equal(detail.can_manage, false);
  await api(a.collaborator_token, 'PATCH', `/channels/${a.channel_id}`, { topic: 'blocked' }, 403);
  await api(a.collaborator_token, 'PATCH', `/channels/${a.channel_id}`, { archived: true }, 403);
  await api(outside.owner_token, 'PATCH', `/channels/${a.channel_id}`, { name: 'blocked' }, 404);
});

test('member pages, adding, removal and public rejoin enforce workspace boundaries', async () => {
  const a = await bootstrap(pool), outside = await bootstrap(pool);
  const channel = await api(a.owner_token, 'POST', `/workspaces/${a.workspace_id}/channels`, { name: 'members', private: false }, 201);
  const path = `/channels/${channel.id}`;
  await api(a.owner_token, 'POST', `${path}/members`, { user_id: outside.owner_id }, 404);
  await api(a.owner_token, 'POST', `${path}/members`, { user_id: a.collaborator_id }, 201);
  await api(a.owner_token, 'POST', `${path}/members`, { user_id: a.collaborator_id }, 201);
  const one = await api(a.owner_token, 'GET', `${path}/members?limit=1`);
  assert.equal(one.items.length, 1); assert.ok(one.next_cursor);
  const two = await api(a.owner_token, 'GET', `${path}/members?limit=1&after=${one.next_cursor}`);
  assert.equal(two.items.length, 1); assert.notEqual(one.items[0].id, two.items[0].id);
  assert.equal((await api(a.owner_token, 'GET', path)).member_count, 2);
  await api(a.collaborator_token, 'DELETE', `${path}/members/${a.owner_id}`, undefined, 403);
  await api(a.collaborator_token, 'DELETE', `${path}/members/${a.collaborator_id}`, undefined, 204);
  await api(a.collaborator_token, 'GET', `${path}/history`, undefined, 404);
  await api(a.collaborator_token, 'POST', `${path}/join`, {});
  await api(a.owner_token, 'DELETE', `${path}/members/${a.collaborator_id}`, undefined, 204);
  await api(a.collaborator_token, 'GET', path, undefined, 404);
  const privateChannel = await api(a.owner_token, 'POST', `/workspaces/${a.workspace_id}/channels`, { name: 'private-leave', private: true }, 201);
  await api(a.owner_token, 'POST', `/channels/${privateChannel.id}/members`, { user_id: a.collaborator_id }, 201);
  await api(a.collaborator_token, 'DELETE', `/channels/${privateChannel.id}/members/${a.collaborator_id}`, undefined, 204);
  await api(a.collaborator_token, 'POST', `/channels/${privateChannel.id}/join`, {}, 404);
});

test('archive preserves history, prevents root messages and replies, and restore resumes writes', async () => {
  const a = await bootstrap(pool), path = `/channels/${a.channel_id}`;
  const message = { client_message_id: randomUUID(), text: 'Before archive' };
  const root = await api(a.owner_token, 'POST', `${path}/messages`, message, 201);
  const archived = await api(a.owner_token, 'PATCH', path, { archived: true });
  assert.ok(archived.archived_at);
  assert.equal((await api(a.owner_token, 'PATCH', path, { archived: true })).archived_at, archived.archived_at);
  await api(a.owner_token, 'PATCH', path, { topic: 'blocked' }, 409);
  assert.equal((await api(a.collaborator_token, 'GET', `${path}/messages`)).messages[0].id, root.id);
  assert.equal((await api(a.owner_token, 'POST', `${path}/messages`, message, 201)).id, root.id);
  for (const thread of [undefined, root.thread_id]) await api(a.collaborator_token, 'POST', `${path}/messages`, { client_message_id: randomUUID(), text: 'Blocked', ...(thread ? { thread_id: thread } : {}) }, 409);
  await assert.rejects(store.createTask(a.owner_id, { workspace_id: a.workspace_id, thread_id: a.thread_id, installation_id: a.installation_id, skill: 'demo.echo', goal: 'Blocked' }, randomUUID()), { status: 409, code: 'channel_archived' });
  assert.equal((await api(a.owner_token, 'PATCH', path, { archived: false })).archived_at, null);
  await api(a.collaborator_token, 'POST', `${path}/messages`, { client_message_id: randomUUID(), text: 'After restore' }, 201);
});

test('archiving waits until active agent work is resolved', async () => {
  const a = await bootstrap(pool);
  const task = await store.createTask(a.collaborator_id, { workspace_id: a.workspace_id, thread_id: a.thread_id, installation_id: a.installation_id, skill: 'demo.echo', goal: 'Pending work' }, randomUUID());
  const path = `/channels/${a.channel_id}`;
  const denied = await api(a.owner_token, 'PATCH', path, { archived: true }, 409);
  assert.equal(denied.error, 'channel_has_active_tasks');
  await store.rejectTask(a.owner_id, task.id);
  assert.ok((await api(a.owner_token, 'PATCH', path, { archived: true })).archived_at);
});

test('private channels retain a manager who can invite people and restore the channel', async () => {
  const a = await bootstrap(pool);
  const channel = await api(a.owner_token, 'POST', `/workspaces/${a.workspace_id}/channels`, { name: 'private-managers', private: true }, 201);
  const path = `/channels/${channel.id}`;
  await api(a.owner_token, 'POST', `${path}/members`, { user_id: a.collaborator_id }, 201);
  const denied = await api(a.owner_token, 'DELETE', `${path}/members/${a.owner_id}`, undefined, 409);
  assert.equal(denied.error, 'channel_needs_manager');
  await pool.query("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [a.workspace_id,a.collaborator_id]);
  await api(a.owner_token, 'DELETE', `${path}/members/${a.owner_id}`, undefined, 204);
  assert.equal((await api(a.collaborator_token, 'GET', path)).can_manage, true);
  await api(a.collaborator_token, 'POST', `${path}/members`, { user_id: a.owner_id }, 201);
  await api(a.collaborator_token, 'PATCH', path, { archived: true });
  await api(a.owner_token, 'PATCH', path, { archived: false });
});

test('task eligibility does not deadlock with a racing channel grant', async () => {
  const a = await bootstrap(pool);
  await pool.query('DELETE FROM agent_grants WHERE installation_id=$1', [a.installation_id]);
  const taskPool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 1 });
  const taskStore = new PostgresStore(taskPool);
  const { rows: [{ pid }] } = await taskPool.query('SELECT pg_backend_pid() AS pid');
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT id FROM agent_installations WHERE id=$1 FOR UPDATE', [a.installation_id]);
  const task = taskStore.createTask(a.collaborator_id, { workspace_id: a.workspace_id, thread_id: a.thread_id,
    installation_id: a.installation_id, skill: 'demo.echo', goal: 'Racing grant' }, randomUUID());
  void task.catch(() => {});
  try {
    let waiting = false;
    for (let i = 0; i < 300; i++) {
      const { rows: [state] } = await pool.query("SELECT wait_event_type='Lock' AND query LIKE '%agent_installations%' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid]);
      if (state?.waiting) { waiting = true; break; }
      await delay(10);
    }
    assert.ok(waiting, 'task reached installation lock after acquiring channel lock');
    await blocker.query('INSERT INTO agent_grants(workspace_id,installation_id,channel_id,skill) VALUES($1,$2,$3,$4)', [a.workspace_id,a.installation_id,a.channel_id,'demo.echo']);
    await blocker.query('COMMIT');
    assert.equal((await task).status, 'awaiting_approval');
  } finally {
    await blocker.query('ROLLBACK'); blocker.release();
    await task.catch(() => {}); await taskPool.end();
  }
});
