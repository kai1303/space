import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { database } from '@space/postgres/database';
import { FoundationStore } from '@space/postgres/foundation';
import { PostgresStore } from '@space/postgres/store';
import { hasChannelAccess, hasWorkspaceAccess, hasThreadAccess } from '@space/postgres/access';
import { deliverOne } from '@space/core/worker';
import { MockConnector } from '@space/mock/connector';
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const schema = `foundation_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: url });
const options = { connectionString: url, options: `-c search_path=${schema}` };
const pool = new Pool(options);
const foundation = new FoundationStore(pool);
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

test('access checks deny foreign workspaces, channels, threads and removed members', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const c = await pool.connect();
  try {
    assert.equal(await hasWorkspaceAccess(database(c), a.owner_id, a.workspace_id), true);
    assert.equal(await hasChannelAccess(database(c), a.owner_id, a.workspace_id, a.channel_id), true);
    assert.equal(await hasChannelAccess(database(c), a.owner_id, a.workspace_id, b.channel_id), false);
    assert.equal(await hasThreadAccess(database(c), a.owner_id, b.thread_id), false);
    await c.query('DELETE FROM channel_members WHERE user_id=$1', [a.collaborator_id]);
    assert.equal(await hasThreadAccess(database(c), a.collaborator_id, a.thread_id), false);
  } finally { c.release(); }
});
test('two owners share a definition but own isolated installations with zero default grants', async () => {
  const a = await bootstrap(pool);
  const definition = await foundation.publishDefinition({ name: 'Research agent', capabilities: { skills: ['research'], controls: {} } });
  const input = { workspace_id: a.workspace_id, definition_id: definition.id, connector_id: 'mock' };
  const one = await foundation.install(a.owner_id, input);
  const two = await foundation.install(a.collaborator_id, input);
  assert.notEqual(one.id, two.id);
  assert.equal(one.definition_id, two.definition_id);
  assert.equal(one.owner_id, a.owner_id);
  assert.equal(two.owner_id, a.collaborator_id);
  assert.equal((await foundation.list(a.collaborator_id, a.workspace_id)).some(i => i.id === one.id), false);
  await assert.rejects(foundation.install(a.owner_id, { ...input, owner_id: a.collaborator_id }), { status: 400 });
  const foreign = await bootstrap(pool);
  await assert.rejects(foundation.install(foreign.owner_id, input), { status: 404 });
  await assert.rejects(foundation.setEnabled(a.collaborator_id, one.id, false), { status: 403 });
  await assert.rejects(foundation.setEnabled(foreign.owner_id, one.id, false), { status: 404 });
  const reopened = new FoundationStore(new Pool(options));
  try { assert.ok((await reopened.list(a.owner_id, a.workspace_id)).some(i => i.id === one.id)); }
  finally { await reopened.pool.end(); }
});
test('grants require ownership, channel membership and declared capabilities', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const installation = await foundation.install(a.owner_id, { workspace_id: a.workspace_id, definition_id: a.definition_id, connector_id: 'mock' });
  const grant = { channel_id: a.channel_id, skill: 'demo.echo' };
  await assert.rejects(foundation.grant(a.collaborator_id, installation.id, grant), { status: 403 });
  await assert.rejects(foundation.grant(a.owner_id, installation.id, { ...grant, channel_id: b.channel_id }), { status: 404 });
  await assert.rejects(foundation.grant(a.owner_id, installation.id, { ...grant, skill: 'deploy.production' }), { code: 'skill_unsupported' });
  await Promise.all([foundation.grant(a.owner_id, installation.id, grant), foundation.grant(a.owner_id, installation.id, grant)]);
  assert.equal((await pool.query('SELECT * FROM agent_grants WHERE installation_id=$1', [installation.id])).rowCount, 1);
  assert.equal((await pool.query("SELECT * FROM foundation_events WHERE installation_id=$1 AND type='grant.created'", [installation.id])).rowCount, 1);
  assert.ok((await foundation.list(a.collaborator_id, a.workspace_id)).some(i => i.id === installation.id));
  await foundation.revoke(a.owner_id, installation.id, grant);
  await foundation.revoke(a.owner_id, installation.id, grant);
  assert.equal((await foundation.list(a.collaborator_id, a.workspace_id)).some(i => i.id === installation.id), false);
  assert.equal((await pool.query("SELECT * FROM foundation_events WHERE installation_id=$1 AND type='grant.revoked'", [installation.id])).rowCount, 1);
});
test('owner may revoke or disable after leaving a channel, but cannot grant into it', async () => {
  const a = await bootstrap(pool);
  await pool.query('DELETE FROM channel_members WHERE user_id=$1', [a.owner_id]);
  await assert.rejects(foundation.grant(a.owner_id, a.installation_id, { channel_id: a.channel_id, skill: 'demo.echo' }), { status: 404 });
  await foundation.revoke(a.owner_id, a.installation_id, { channel_id: a.channel_id, skill: 'demo.echo' });
  await foundation.setEnabled(a.owner_id, a.installation_id, false);
  assert.equal((await foundation.list(a.owner_id, a.workspace_id)).find(i => i.id === a.installation_id)?.enabled, false);
});
test('revoking a grant through the foundation blocks previously approved dispatch', async () => {
  const a = await bootstrap(pool);
  const tasks = new PostgresStore(pool);
  const input = { workspace_id: a.workspace_id, thread_id: a.thread_id, installation_id: a.installation_id, goal: 'Review', skill: 'demo.echo' };
  const task = await tasks.createTask(a.owner_id, input, randomUUID());
  await tasks.approveTask(a.owner_id, task.id);
  await foundation.revoke(a.owner_id, a.installation_id, { channel_id: a.channel_id, skill: 'demo.echo' });
  await deliverOne(tasks, [new MockConnector()]);
  assert.equal((await tasks.readTask(a.owner_id, task.id)).status, 'failed');
  await assert.rejects(tasks.createTask(a.owner_id, input, randomUUID()), { status: 403 });
});
test('disable prevents new proposals and enable restores only retained grants', async () => {
  const a = await bootstrap(pool);
  const tasks = new PostgresStore(pool);
  const input = { workspace_id: a.workspace_id, thread_id: a.thread_id, installation_id: a.installation_id, goal: 'Review', skill: 'demo.echo' };
  await foundation.setEnabled(a.owner_id, a.installation_id, false);
  await assert.rejects(tasks.createTask(a.owner_id, input, randomUUID()), { status: 403 });
  await foundation.setEnabled(a.owner_id, a.installation_id, true);
  assert.equal((await tasks.createTask(a.owner_id, input, randomUUID())).status, 'awaiting_approval');
  await assert.rejects(pool.query('DELETE FROM foundation_events WHERE installation_id=$1', [a.installation_id]), /append-only/);
});
