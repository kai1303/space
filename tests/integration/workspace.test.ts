import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { PostgresStore } from '@space/postgres/store';
import { FoundationStore } from '@space/postgres/foundation';
import { WorkspaceStore } from '@space/postgres/workspace';
import { createApi } from '@space/server/api';
import { deliverOne } from '@space/core/worker';
import { MockConnector } from '@space/mock/connector';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const schema = `workspaces_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
const store = new PostgresStore(pool);
const app = createApi(store, { allowDevelopmentTokens: true });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

async function api(token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: object, status = 200) {
  const result = await app.inject({ method, url: `/v1${path}`, headers: { authorization: `Bearer ${token}` }, ...(body ? { payload: body } : {}) });
  assert.equal(result.statusCode, status, `${method} ${path}: ${result.body}`);
  return status === 204 ? undefined : result.json();
}
async function fixture() {
  const seed = await bootstrap(pool);
  return { ...seed, path: `/workspaces/${seed.workspace_id}`, token: seed.owner_token };
}

test('self profile persists, rejects authority fields and requires authentication', async () => {
  const a = await fixture();
  assert.equal((await api(a.token, 'GET', '/me')).id, a.owner_id);
  await api(a.token, 'PATCH', '/me', { display_name: '  Kai  ' });
  assert.equal((await api(a.token, 'GET', '/me')).display_name, 'Kai');
  await api(a.token, 'PATCH', '/me', { display_name: 'Name', id: a.collaborator_id }, 400);
  await api(a.token, 'PATCH', '/me', { display_name: '   ' }, 400);
  await api(a.token, 'PATCH', '/me', { display_name: 'x'.repeat(101) }, 400);
  await api('invalid', 'GET', '/me', undefined, 401);
  const invalidJson = await app.inject({ method: 'PATCH', url: '/v1/me', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'text/plain' }, payload: 'name' });
  assert.equal(invalidJson.statusCode, 415);
});

test('profile details, photo and status persist independently and expired statuses disappear', async () => {
  const a = await fixture();
  const photo = 'data:image/jpeg;base64,/9j/AA==';
  const details = { full_name: 'Kai Nguyen', title: 'Engineer', name_pronunciation: 'K-eye', phone: '+84 123456', time_zone: 'Asia/Ho_Chi_Minh', image: photo };
  await api(a.token, 'PATCH', '/me', details);
  const status = { text: 'Reviewing', emoji: '👀', expires_at: new Date(Date.now() + 3600_000).toISOString() };
  await api(a.token, 'PATCH', '/me', { status, presence: 'away' });
  const saved = await api(a.token, 'GET', '/me');
  for (const [key, value] of Object.entries(details)) assert.equal(saved[key], value);
  assert.deepEqual(saved.status, status); assert.equal(saved.presence, 'away');
  assert.equal((await api(a.collaborator_token, 'GET', '/me')).status, null);
  await api(a.token, 'PATCH', '/me', { status, email_verified: true }, 400);
  await api(a.token, 'PATCH', '/me', { image: 'https://tracker.invalid/photo.jpg' }, 400);
  await pool.query('UPDATE users SET status=$1 WHERE id=$2', [JSON.stringify({ ...status, expires_at: '2020-01-01T00:00:00.000Z' }), a.owner_id]);
  assert.equal((await api(a.token, 'GET', '/me')).status, null);
  await api(a.token, 'PATCH', '/me', { image: null, status: null, presence: 'active' });
  assert.equal((await api(a.token, 'GET', '/me')).image, null);
});

test('create/list/read/rename workspaces with cursor pagination and tenant isolation', async () => {
  const a = await fixture(), b = await fixture();
  const org = await api(a.token, 'POST', '/workspaces', { name: '  Engineering  ' }, 201);
  assert.equal(org.name, 'Engineering');
  assert.equal(org.role, 'owner');
  assert.equal((await api(a.token, 'GET', `/workspaces/${org.id}`)).id, org.id);
  await api(b.token, 'GET', `/workspaces/${org.id}`, undefined, 404);
  await api(a.token, 'POST', '/workspaces', { name: 'Bad', owner_id: b.owner_id }, 400);
  await api(a.token, 'PATCH', `/workspaces/${org.id}`, { name: 'Platform' });
  assert.equal((await api(a.token, 'GET', `/workspaces/${org.id}`)).name, 'Platform');
  const first = await api(a.token, 'GET', '/workspaces?limit=1');
  assert.equal(first.items.length, 1);
  assert.ok(first.next_cursor);
  const second = await api(a.token, 'GET', `/workspaces?limit=1&after=${first.next_cursor}`);
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0].id, second.items[0].id);
  assert.equal(second.next_cursor, null);
  await api(a.token, 'GET', '/workspaces?limit=101', undefined, 400);
  await api(a.token, 'GET', '/workspaces?after=bad', undefined, 400);
});

test('roles restrict member management; outsiders cannot read directory or add themselves', async () => {
  const a = await fixture(), b = await fixture(), c = await fixture();
  const memberPath = `${a.path}/members`;
  await api(a.collaborator_token, 'PATCH', a.path, { name: 'No' }, 403);
  await api(b.token, 'GET', memberPath, undefined, 404);
  await api(b.token, 'POST', memberPath, { user_id: b.owner_id, role: 'owner' }, 404);
  await api(a.token, 'POST', memberPath, { user_id: randomUUID(), role: 'member' }, 404);
  await api(a.token, 'PATCH', `${memberPath}/${a.collaborator_id}`, { role: 'admin' });
  await api(a.collaborator_token, 'POST', memberPath, { user_id: b.owner_id, role: 'member' }, 201);
  await api(a.collaborator_token, 'POST', memberPath, { user_id: c.owner_id, role: 'admin' }, 403);
  await api(a.collaborator_token, 'PATCH', `${memberPath}/${b.owner_id}`, { role: 'owner' }, 403);
  await api(a.collaborator_token, 'DELETE', `${memberPath}/${a.owner_id}`, undefined, 403);
  await api(b.token, 'POST', memberPath, { user_id: c.owner_id, role: 'member' }, 403);
  await api(a.collaborator_token, 'PATCH', a.path, { name: 'Renamed by admin' });
  const first = await api(a.token, 'GET', `${memberPath}?limit=2`);
  const second = await api(a.token, 'GET', `${memberPath}?limit=2&after=${first.next_cursor}`);
  assert.equal(new Set([...first.items, ...second.items].map(m => m.user_id)).size, 3);
  assert.ok(first.items.every((m: Record<string, unknown>) => typeof m.display_name === 'string' && !('token_hash' in m)));
  await api(a.collaborator_token, 'DELETE', `${memberPath}/${b.owner_id}`, undefined, 204);
  await api(b.token, 'GET', a.path, undefined, 404);
});

test('last owner cannot leave or demote themselves, including concurrent owner changes', async () => {
  const a = await fixture();
  const members = `${a.path}/members`;
  await api(a.token, 'DELETE', `${members}/${a.owner_id}`, undefined, 409);
  await api(a.token, 'PATCH', `${members}/${a.owner_id}`, { role: 'member' }, 409);
  await api(a.token, 'PATCH', `${members}/${a.collaborator_id}`, { role: 'owner' });
  const results = await Promise.all([
    app.inject({ method: 'DELETE', url: `/v1${members}/${a.owner_id}`, headers: { authorization: `Bearer ${a.token}` } }),
    app.inject({ method: 'PATCH', url: `/v1${members}/${a.collaborator_id}`, headers: { authorization: `Bearer ${a.collaborator_token}` }, payload: { role: 'member' } }),
  ]);
  assert.equal(results.filter(r => r.statusCode === 409).length, 1);
  assert.equal(results.filter(r => r.statusCode === 200 || r.statusCode === 204).length, 1);
  assert.equal((await pool.query("SELECT * FROM workspace_members WHERE workspace_id=$1 AND role='owner' AND active", [a.workspace_id])).rowCount, 1);
});

test('removal preserves task history, revokes access and dispatch, and rejoining restores no grants', async () => {
  const a = await fixture();
  const input = { workspace_id: a.workspace_id, thread_id: a.thread_id, installation_id: a.installation_id, goal: 'Review', skill: 'demo.echo' };
  const task = await store.createTask(a.collaborator_id, input, randomUUID());
  await store.approveTask(a.owner_id, task.id);
  const foundation = new FoundationStore(pool);
  const owned = await foundation.install(a.collaborator_id, { workspace_id: a.workspace_id, definition_id: a.definition_id, connector_id: 'mock' });
  await api(a.token, 'DELETE', `${a.path}/members/${a.collaborator_id}`, undefined, 204);
  await api(a.collaborator_token, 'GET', `/tasks/${task.id}`, undefined, 404);
  await api(a.collaborator_token, 'GET', `/agents/installations?workspace_id=${a.workspace_id}`, undefined, 404);
  await assert.rejects(foundation.install(a.collaborator_id, { workspace_id: a.workspace_id, definition_id: a.definition_id, connector_id: 'mock' }), { status: 404 });
  await deliverOne(store, [new MockConnector()]);
  assert.equal((await store.readTask(a.owner_id, task.id)).status, 'failed');
  assert.equal((await pool.query('SELECT active FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [a.workspace_id, a.collaborator_id])).rows[0].active, false);
  assert.equal((await pool.query('SELECT enabled FROM agent_installations WHERE id=$1', [owned.id])).rows[0].enabled, false);
  await api(a.token, 'POST', `${a.path}/members`, { user_id: a.collaborator_id, role: 'member' }, 201);
  await api(a.collaborator_token, 'GET', a.path);
  await api(a.collaborator_token, 'GET', `/threads/${a.thread_id}/messages`, undefined, 404);
  assert.equal((await foundation.list(a.collaborator_id, a.workspace_id)).find(i => i.id === owned.id)?.enabled, false);
  // A regular member can leave without an admin.
  await api(a.collaborator_token, 'DELETE', `${a.path}/members/${a.collaborator_id}`, undefined, 204);
});

test('membership mutations are idempotent and audit is immutable and transactional', async () => {
  const a = await fixture(), b = await fixture();
  const members = `${a.path}/members`;
  await Promise.all([1, 2].map(() => api(a.token, 'POST', members, { user_id: b.owner_id, role: 'member' }, 201)));
  await api(a.token, 'POST', members, { user_id: b.owner_id, role: 'owner' }, 409);
  const events = await pool.query("SELECT * FROM workspace_events WHERE workspace_id=$1 AND type='member.added'", [a.workspace_id]);
  assert.equal(events.rowCount, 1);
  const eventCount = (await pool.query('SELECT * FROM workspace_events WHERE workspace_id=$1', [a.workspace_id])).rowCount;
  await api(a.token, 'PATCH', `${members}/${a.owner_id}`, { role: 'member' }, 409);
  assert.equal((await pool.query('SELECT * FROM workspace_events WHERE workspace_id=$1', [a.workspace_id])).rowCount, eventCount);
  await assert.rejects(pool.query('DELETE FROM workspace_events WHERE workspace_id=$1', [a.workspace_id]), /append-only/);
  await migrate(pool);
  assert.equal((await api(a.token, 'GET', members)).items.length, 3);
});

test('installation creation cannot escape a concurrent workspace member removal', async () => {
  const a = await fixture();
  const options = { connectionString: url, options: `-c search_path=${schema}`, max: 1 };
  const installPool = new Pool(options), removePool = new Pool(options);
  const control = await pool.connect();
  const key = `${schema}:installation-race`;
  const pending: Promise<unknown>[] = [];
  async function waitFor(check: () => Promise<boolean>) {
    const deadline = Date.now() + 5000;
    while (!await check()) {
      assert.ok(Date.now() < deadline, 'concurrent operation did not reach its expected lock');
      await delay(5);
    }
  }
  try {
    await control.query(`CREATE FUNCTION block_installation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_SCHEMA || ':installation-race')); RETURN NEW; END; $$;
      CREATE TRIGGER block_installation BEFORE INSERT ON agent_installations FOR EACH ROW EXECUTE FUNCTION block_installation()`);
    await control.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
    const installPid = (await installPool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const removePid = (await removePool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const installation = new FoundationStore(installPool).install(a.collaborator_id, {
      workspace_id: a.workspace_id, definition_id: a.definition_id, connector_id: 'mock',
    }).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    pending.push(installation);
    await waitFor(async () => (await control.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted", [installPid])).rowCount === 1);
    let removalFinished = false;
    const removal = new WorkspaceStore(removePool).removeMember(a.owner_id, a.workspace_id, a.collaborator_id)
      .then(() => { removalFinished = true; });
    pending.push(removal);
    // Removal may finish while insertion is paused. Serializable installation
    // then retries against revoked membership instead of creating an enabled agent.
    await waitFor(async () => removalFinished || (await control.query('SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted', [removePid])).rowCount! > 0);
    await control.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
    const created = await installation;
    await removal;
    if(created.error)assert.equal(created.error.code,'not_found');
    else assert.equal((await pool.query('SELECT enabled FROM agent_installations WHERE id=$1', [created.value!.id])).rows[0].enabled, false);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_installations WHERE owner_id=$1 AND workspace_id=$2 AND enabled',[a.collaborator_id,a.workspace_id])).rows[0].n,0);
    await api(a.token, 'POST', `${a.path}/members`, { user_id: a.collaborator_id, role: 'member' }, 201);
    assert.ok((await new FoundationStore(pool).list(a.collaborator_id, a.workspace_id)).filter(i=>i.owner_id===a.collaborator_id).every(i=>!i.enabled));
  } finally {
    await control.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
    await Promise.allSettled(pending);
    await control.query('DROP TRIGGER IF EXISTS block_installation ON agent_installations; DROP FUNCTION IF EXISTS block_installation()');
    control.release();
    await installPool.end();
    await removePool.end();
  }
});

test('admin directory filters, paginates and protects inactive members and email addresses', async () => {
  const a = await fixture(), b = await fixture();
  await pool.query('UPDATE users SET display_name=$1,email=$2,email_verified=true WHERE id=$3', ['Ada Unique', 'ada-directory@example.test', a.collaborator_id]);
  const result = await api(a.token, 'GET', `${a.path}/directory?q=Ada&role=member&status=active&limit=1`);
  assert.equal(result.items.length, 1); assert.equal(result.items[0].email, 'ada-directory@example.test');
  assert.equal(result.role, 'owner');
  const peer = await api(a.collaborator_token, 'GET', `${a.path}/directory`);
  assert.ok(peer.items.every((item: Record<string,unknown>) => !('email' in item)));
  await api(a.collaborator_token, 'GET', `${a.path}/directory?status=deactivated`, undefined, 403);
  await api(b.token, 'GET', `${a.path}/directory`, undefined, 404);
  await api(a.token, 'GET', `${a.path}/directory?limit=101`, undefined, 400);
  await api(a.token, 'DELETE', `${a.path}/members/${a.collaborator_id}`, undefined, 204);
  assert.equal((await api(a.token,'GET',`${a.path}/directory?status=deactivated`)).items[0].user_id,a.collaborator_id);
  await api(a.token, 'POST', `${a.path}/members`, {email:'ADA-DIRECTORY@example.test',role:'member'}, 201);
  assert.equal((await api(a.collaborator_token,'GET',a.path)).role,'member');
});

test('directory cursors cover all matching members without duplicates and escape search wildcards',async()=>{
 const a=await fixture();
 const first=await api(a.token,'GET',`${a.path}/directory?limit=1`);
 const second=await api(a.token,'GET',`${a.path}/directory?limit=1&after=${first.next_cursor}`);
 assert.equal(first.items.length,1);assert.equal(second.items.length,1);assert.notEqual(first.items[0].user_id,second.items[0].user_id);assert.equal(second.next_cursor,null);
 assert.equal((await api(a.token,'GET',`${a.path}/directory?q=%25`)).items.length,0);
 await api(a.collaborator_token,'POST',`${a.path}/members`,{email:'missing@example.test',role:'member'},403);
});
