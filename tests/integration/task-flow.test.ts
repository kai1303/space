import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { bootstrap } from '@space/postgres/bootstrap';
import { MockConnector } from '@space/mock/connector';
import { deliverOne } from '@space/core/worker';
import { createApi } from '@space/server/api';
import type { AgentEvent, TaskInput } from '@space/contracts';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required; integration tests never silently skip.');
const schema = `test_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: databaseUrl });
const options = { connectionString: databaseUrl, options: `-c search_path=${schema}` };
let store: PostgresStore;
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  store = new PostgresStore(new Pool(options));
  await migrate(store.pool);
});
beforeEach(async () => { await store.pool.query('DELETE FROM outbox'); });
after(async () => { await store?.pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
async function fixture() {
  const seed = await bootstrap(store.pool);
  const input: TaskInput = { workspace_id: seed.workspace_id, thread_id: seed.thread_id, installation_id: seed.installation_id, goal: 'Review paid-customer churn', skill: 'demo.echo' };
  return { seed, input, owner: seed.owner_id, collaborator: seed.collaborator_id };
}
function agentEvent(executionId: string, sequence: number, type: AgentEvent['type'], value = 'Working'): AgentEvent {
  return { id: randomUUID(), schema_version: '1.0', execution_id: executionId, sequence, type, occurred_at: new Date().toISOString(), payload: { text: value } };
}

test('approval gates execution; completion persists an ordered audit and origin reply', async () => {
  const { input, seed, owner, collaborator } = await fixture();
  const task = await store.createTask(collaborator, input, randomUUID());
  assert.equal(task.status, 'awaiting_approval');
  assert.equal(await deliverOne(store, [new MockConnector()]), false);
  await assert.rejects(store.approveTask(collaborator, task.id), { code: 'approval_not_authorized' });
  const approvals = await Promise.all([store.approveTask(owner, task.id), store.approveTask(owner, task.id)]);
  assert.equal(approvals[0]?.active_execution_id, approvals[1]?.active_execution_id);
  assert.notEqual(approvals[0]?.session_id, approvals[0]?.active_execution_id);
  assert.equal(await deliverOne(store, [new MockConnector()]), true);
  const done = await store.readTask(owner, task.id);
  assert.equal(done.status, 'completed');
  assert.match(done.result!, /paid-customer churn/);
  const events = await store.events(owner, task.id, 0);
  assert.deepEqual(events.map(e => e.type), ['task.proposed', 'task.approved', 'execution.started', 'execution.progress', 'execution.completed', 'task.completed']);
  assert.deepEqual(events.map(e => e.sequence), [1, 2, 3, 4, 5, 6]);
  assert.equal((await store.messages(owner, seed.thread_id)).length, 1);
});

test('idempotency keys replay the original task and reject a changed request', async () => {
  const { input, owner } = await fixture();
  const key = randomUUID();
  const tasks = await Promise.all([store.createTask(owner, input, key), store.createTask(owner, input, key)]);
  assert.equal(tasks[0]?.id, tasks[1]?.id);
  await assert.rejects(store.createTask(owner, { ...input, goal: 'Different' }, key), { code: 'idempotency_conflict' });
});

test('workspace and private-channel reads, writes, and approvals deny access', async () => {
  const { input, seed, owner } = await fixture();
  const other = await fixture();
  const task = await store.createTask(owner, input, randomUUID());
  for (const action of [() => store.readTask(other.owner, task.id), () => store.events(other.owner, task.id, 0), () => store.messages(other.owner, seed.thread_id), () => store.approveTask(other.owner, task.id), () => store.createTask(other.owner, input, randomUUID())]) {
    await assert.rejects(action(), { status: 404 });
  }
  await store.pool.query('DELETE FROM channel_members WHERE user_id=$1', [seed.collaborator_id]);
  await assert.rejects(store.readTask(seed.collaborator_id, task.id), { status: 404 });
});

test('a new process pool recovers an expired outbox lease after completion without duplicate work', async () => {
  const { input, owner, seed } = await fixture();
  const task = await store.createTask(owner, input, randomUUID());
  const approved = await store.approveTask(owner, task.id);
  const lease = await store.claimDelivery();
  assert.ok(lease);
  const started = agentEvent(approved.active_execution_id!, 1, 'execution.started');
  const completed = agentEvent(approved.active_execution_id!, 2, 'execution.completed', 'Recovered result');
  await store.acceptEvent(seed.installation_id, started);
  await store.acceptEvent(seed.installation_id, completed);
  // Simulate death after the terminal event commits but before the lease is acknowledged.
  await store.pool.query("UPDATE outbox SET lease_until=now()-interval '1 second' WHERE id=$1", [lease.id]);
  const recovered = new PostgresStore(new Pool(options));
  let invocations = 0;
  const connector = new MockConnector();
  connector.invoke = async () => { invocations++; throw new Error('must not reinvoke'); };
  try {
    assert.equal(await deliverOne(recovered, [connector]), true);
    assert.equal(invocations, 0);
    assert.equal((await recovered.readTask(owner, task.id)).result, 'Recovered result');
    assert.equal((await recovered.messages(owner, seed.thread_id)).length, 1);
    assert.equal(await store.ackDelivery(lease), false, 'old lease cannot acknowledge a newer lease');
  } finally { await recovered.pool.end(); }
});

test('queued work and in-flight started work survive new store instances', async () => {
  const { input, owner, seed } = await fixture();
  const task = await store.createTask(owner, input, randomUUID());
  const approved = await store.approveTask(owner, task.id);
  const lease = await store.claimDelivery();
  assert.ok(lease);
  const prepared = await store.prepareDelivery(lease);
  assert.ok(prepared);
  await assert.rejects(new MockConnector().invoke(prepared.request, async event => {
    await store.acceptEvent(seed.installation_id, event);
    throw new Error('simulated process death');
  }, new AbortController().signal));
  await store.pool.query("UPDATE outbox SET lease_until=now()-interval '1 second' WHERE id=$1", [lease.id]);
  const recovered = new PostgresStore(new Pool(options));
  try {
    await deliverOne(recovered, [new MockConnector()]);
    assert.equal((await recovered.readTask(owner, task.id)).status, 'completed');
  } finally { await recovered.pool.end(); }
});

test('agent identity, event replay, ordering and terminal transitions are enforced', async () => {
  const { input, owner, seed } = await fixture();
  const other = await fixture();
  const task = await store.createTask(owner, input, randomUUID());
  const approved = await store.approveTask(owner, task.id);
  const event = agentEvent(approved.active_execution_id!, 1, 'execution.started');
  await assert.rejects(store.acceptEvent(other.seed.installation_id, event), { status: 404 });
  await store.acceptEvent(seed.installation_id, event);
  await store.acceptEvent(seed.installation_id, event);
  await assert.rejects(store.acceptEvent(seed.installation_id, { ...event, payload: { text: 'Changed' } }), { code: 'event_id_conflict' });
  await assert.rejects(store.acceptEvent(seed.installation_id, agentEvent(event.execution_id, 3, 'execution.completed')), { code: 'event_out_of_order' });
  await store.acceptEvent(seed.installation_id, agentEvent(event.execution_id, 2, 'execution.completed'));
  await assert.rejects(store.acceptEvent(seed.installation_id, agentEvent(event.execution_id, 3, 'execution.progress')), { code: 'stale_execution' });
});

test('revoked access blocks dispatch even after approval', async () => {
  const { input, owner, seed } = await fixture();
  const task = await store.createTask(owner, input, randomUUID());
  await store.approveTask(owner, task.id);
  await store.pool.query('UPDATE agent_installations SET enabled=false WHERE id=$1', [seed.installation_id]);
  let invoked = false;
  const connector = new MockConnector();
  connector.invoke = async () => { invoked = true; throw new Error('must not execute'); };
  await deliverOne(store, [connector]);
  assert.equal(invoked, false);
  assert.equal((await store.readTask(owner, task.id)).status, 'failed');
});

test('bounded retries dead-letter deliveries and fail the task', async () => {
  const { input, owner } = await fixture();
  const task = await store.createTask(owner, input, randomUUID());
  await store.approveTask(owner, task.id);
  const connector = new MockConnector();
  connector.invoke = async () => { throw new Error('secret must not be persisted'); };
  for (let i = 0; i < 3; i++) {
    assert.equal(await deliverOne(store, [connector]), true);
    await store.pool.query("UPDATE outbox SET available_at=now() WHERE state='pending'");
  }
  assert.equal((await store.readTask(owner, task.id)).status, 'failed');
  const row = await store.pool.query('SELECT state,last_error FROM outbox WHERE task_id=$1', [task.id]);
  assert.deepEqual(row.rows[0], { state: 'dead', last_error: 'connector_failed' });
});

test('HTTP boundary authenticates, validates requests and returns unsupported controls honestly', async () => {
  const { seed, input } = await fixture();
  const server = createApi(store, { allowDevelopmentTokens: true });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const address = server.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Bearer ${seed.owner_token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() };
  try {
    assert.equal((await fetch(`${base}/v1/tasks`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: '{' })).status, 400);
    assert.equal((await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ ...input, approved_by: seed.owner_id }) })).status, 400);
    const response = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(response.status, 201);
    const task = await response.json() as { id: string };
    assert.equal((await fetch(`${base}/v1/tasks/${task.id}/control`, { method: 'POST', headers, body: '{}' })).status, 409);
    assert.equal((await fetch(`${base}/v1/tasks/${task.id}/approve`, { method: 'POST', headers, body: '{}' })).status, 200);
    await deliverOne(store, [new MockConnector()]);
    assert.equal((await fetch(`${base}/v1/tasks/${task.id}/events?after=bad`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/v1/tasks/${task.id}`, { headers: { authorization: 'Bearer forged' } })).status, 401);
  } finally { await server.close(); }
});


test('connector discovery is bounded by the invocation timeout', { timeout: 5000 }, async t => {
  const { input, owner } = await fixture();
  const task = await store.createTask(owner, input, randomUUID());
  await store.approveTask(owner, task.id);
  const connector = new MockConnector();
  let releaseDiscovery!: () => void;
  const discovery = new Promise<void>(resolve => { releaseDiscovery = resolve; });
  t.after(() => releaseDiscovery());
  connector.discover = async () => { await discovery; return { skills: ['demo.echo'], controls: { progress_stream: true, active_steer: false, queued_followup: false, cancel: false } }; };
  let invoked = false;
  connector.invoke = async () => { invoked = true; throw new Error('must not invoke after timeout'); };
  // Completion must not depend on discovery finishing, regardless of database latency.
  assert.equal(await deliverOne(store, [connector], 10), true);
  releaseDiscovery();
  await nextTurn();
  assert.equal(invoked, false);
  const row = await store.pool.query('SELECT last_error FROM outbox WHERE task_id=$1', [task.id]);
  assert.equal(row.rows[0].last_error, 'connector_timeout');
});


test('framework HTTP handling keeps limits, media types and security headers', async () => {
  const { seed, input } = await fixture();
  const app = createApi(store, { allowDevelopmentTokens: true });
  const headers = { authorization: `Bearer ${seed.owner_token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() };
  try {
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: 'ok' });
    assert.equal(health.headers['cache-control'], 'no-store');
    assert.equal(health.headers['x-content-type-options'], 'nosniff');
    const malformed = await app.inject({ method: 'POST', url: '/v1/tasks', headers, payload: '{' });
    assert.equal(malformed.statusCode, 400);
    assert.deepEqual(malformed.json(), { error: 'invalid_json' });
    const large = await app.inject({ method: 'POST', url: '/v1/tasks', headers, payload: JSON.stringify({ ...input, goal: 'x'.repeat(40000) }) });
    assert.equal(large.statusCode, 413);
    assert.deepEqual(large.json(), { error: 'body_too_large' });
    const media = await app.inject({ method: 'POST', url: '/v1/tasks', headers: { ...headers, 'content-type': 'text/plain' }, payload: '{}' });
    assert.equal(media.statusCode, 415);
    assert.deepEqual(media.json(), { error: 'json_required' });
    const unauth = await app.inject({ method: 'POST', url: '/v1/tasks', headers: { 'content-type': 'application/json' }, payload: '{' });
    assert.equal(unauth.statusCode, 401, 'authentication runs before JSON parsing');
    assert.equal((await app.inject({ method: 'GET', url: '/not-a-route', headers })).statusCode, 404);
  } finally { await app.close(); }
});

test('Fastify routes retain approval ownership and scoped reads', async () => {
  const { seed, input } = await fixture();
  const other = await fixture();
  const app = createApi(store, { allowDevelopmentTokens: true });
  const headers = { authorization: `Bearer ${seed.owner_token}`, 'idempotency-key': randomUUID() };
  try {
    const created = await app.inject({ method: 'POST', url: '/v1/tasks', headers, payload: input });
    assert.equal(created.statusCode, 201);
    const task = created.json();
    assert.equal((await app.inject({ method: 'GET', url: `/v1/tasks/${task.id}`, headers })).json().status, 'awaiting_approval');
    assert.equal((await app.inject({ method: 'GET', url: `/v1/tasks/${task.id}/events?after=0`, headers })).json().length, 1);
    assert.equal((await app.inject({ method: 'GET', url: `/v1/threads/${seed.thread_id}/messages`, headers })).statusCode, 200);
    const agents = await app.inject({ method: 'GET', url: `/v1/agents/installations?workspace_id=${seed.workspace_id}`, headers });
    assert.equal(agents.json()[0].id, seed.installation_id);
    const collaborator = { authorization: `Bearer ${seed.collaborator_token}` };
    assert.equal((await app.inject({ method: 'POST', url: `/v1/tasks/${task.id}/approve`, headers: collaborator, payload: {} })).statusCode, 403);
    const foreign = { authorization: `Bearer ${other.seed.owner_token}` };
    for (const url of [`/v1/tasks/${task.id}`, `/v1/tasks/${task.id}/events`, `/v1/threads/${seed.thread_id}/messages`, `/v1/agents/installations?workspace_id=${seed.workspace_id}`]) {
      assert.equal((await app.inject({ method: 'GET', url, headers: foreign })).statusCode, 404);
    }
    assert.equal((await app.inject({ method: 'POST', url: `/v1/tasks/${task.id}/reject`, headers, payload: {} })).json().status, 'rejected');
    assert.equal((await app.inject({ method: 'GET', url: `/v1/tasks/${task.id}/events?after=1&after=2`, headers })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/tasks/invalid', headers })).statusCode, 400);
  } finally { await app.close(); }
});

test('unexpected backend errors never expose exception contents', async () => {
  const { seed } = await fixture();
  const original = store.readTask;
  store.readTask = async () => { throw new Error('database-password-secret'); };
  const app = createApi(store, { allowDevelopmentTokens: true });
  try {
    const response = await app.inject({ method: 'GET', url: `/v1/tasks/${randomUUID()}`, headers: { authorization: `Bearer ${seed.owner_token}` } });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { error: 'internal_error' });
  } finally { store.readTask = original; await app.close(); }
});

test('concurrent Drizzle workers claim different deliveries and respect live leases', async () => {
  const { input, owner } = await fixture();
  const one = await store.createTask(owner, input, randomUUID());
  const two = await store.createTask(owner, input, randomUUID());
  await store.approveTask(owner, one.id);
  await store.approveTask(owner, two.id);
  const [a, b] = await Promise.all([store.claimDelivery(), store.claimDelivery()]);
  assert.ok(a && b);
  assert.notEqual(a.id, b.id);
  assert.deepEqual(new Set([a.task_id, b.task_id]), new Set([one.id, two.id]));
  assert.equal(await store.claimDelivery(), null);
});
