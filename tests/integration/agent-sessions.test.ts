import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { io, type Socket } from 'socket.io-client';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { AgentSessionStore } from '@space/postgres/agent-sessions';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const schema = `agent_sessions_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
const store = new PostgresStore(pool);
const app = createApi(store, { allowDevelopmentTokens: true });
let origin = '';
const sockets: Socket[] = [];
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); origin = await app.listen({ host: '127.0.0.1', port: 0 }); });
after(async () => { sockets.forEach(socket => socket.disconnect()); await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
async function api(token: string, method: 'GET' | 'POST', path: string, payload?: object, status = 200, key = randomUUID()) {
  const response = await app.inject({ method, url: `/v1${path}`, headers: { authorization: `Bearer ${token}`, 'idempotency-key': key }, ...(payload ? { payload } : {}) });
  assert.equal(response.statusCode, status, `${path}: ${response.body}`);
  return response.json();
}
async function fixture() {
  const seed = await bootstrap(pool);
  await pool.query("UPDATE agent_definitions SET capabilities=$2 WHERE id=$1", [seed.definition_id, { skills: ['codex.run'], controls: {}, persistent_sessions: true }]);
  await pool.query("UPDATE agent_installations SET connector_id='codex.local' WHERE id=$1", [seed.installation_id]);
  await pool.query("UPDATE agent_grants SET skill='codex.run' WHERE installation_id=$1", [seed.installation_id]);
  await pool.query("INSERT INTO agent_connections(installation_id,name) VALUES($1,'Local test agent')", [seed.installation_id]);
  return seed;
}
async function session(seed: { owner_token: string; thread_id: string; installation_id: string }, title = 'Research') {
  return api(seed.owner_token, 'POST', `/threads/${seed.thread_id}/agent-sessions`, { client_session_id: randomUUID(), installation_id: seed.installation_id, title }, 201);
}
function event(execution_id: string, sequence: number, type: string) {
  return { id: randomUUID(), schema_version: '1.0', execution_id, sequence, type, occurred_at: new Date().toISOString(), payload: { text: type === 'execution.completed' ? 'Answer' : 'Working', response: { messages: [{ id: 'reply', text: 'Answer', status: 'complete' }], tools: [], components: [] } } };
}

test('named sessions are independent, bounded, idempotent, scoped and validate their input', async () => {
  const a = await fixture(), foreign = await fixture();
  const input = { client_session_id: randomUUID(), installation_id: a.installation_id, title: 'First' };
  const one = await api(a.owner_token, 'POST', `/threads/${a.thread_id}/agent-sessions`, input, 201);
  assert.equal(one.title, 'First'); assert.equal(one.managed, true); assert.equal(one.turn_count, 0);
  assert.deepEqual(await api(a.owner_token, 'POST', `/threads/${a.thread_id}/agent-sessions`, input, 201), one);
  await api(a.owner_token, 'POST', `/threads/${a.thread_id}/agent-sessions`, { ...input, title: 'Changed' }, 409);
  const two = await session(a, 'Second'); assert.notEqual(one.id, two.id);
  assert.equal((await api(a.collaborator_token, 'GET', `/threads/${a.thread_id}/agent-sessions`)).items.length, 2);
  await api(foreign.owner_token, 'GET', `/agent-sessions/${one.id}`, undefined, 404);
  await api(foreign.owner_token, 'POST', `/threads/${a.thread_id}/agent-sessions`, input, 404);
  await api(a.owner_token, 'POST', `/threads/${a.thread_id}/agent-sessions`, { ...input, client_session_id: randomUUID(), title: '' }, 400);
  const revisions = await pool.query('SELECT revision FROM resource_update_revisions WHERE resource=$1', [`thread:${a.thread_id}`]);
  assert.ok(Number(revisions.rows[0]?.revision) >= 2);
});

test('turns preserve retry identity, serialize sends, reuse owner approval and stay out of human history', async () => {
  const a = await fixture(), one = await session(a), two = await session(a);
  const path = `/agent-sessions/${one.id}/messages`, key = randomUUID();
  const task = await api(a.owner_token, 'POST', path, { text: 'First prompt' }, 201, key);
  assert.equal(task.status, 'queued'); assert.equal(task.session_id, one.id);
  assert.equal((await api(a.owner_token, 'POST', path, { text: 'First prompt' }, 201, key)).id, task.id);
  await api(a.owner_token, 'POST', path, { text: 'Changed' }, 409, key);
  await api(a.owner_token, 'POST', path, { text: 'Overlap' }, 409);
  const competing = await Promise.all([api(a.owner_token, 'POST', `/agent-sessions/${two.id}/messages`, { text: 'Other session' }, 201)]);
  assert.equal(competing[0].session_id, two.id);
  const delivery = (await store.claimDelivery(a.installation_id))!;
  const prepared = (await store.prepareDelivery(delivery))!;
  assert.deepEqual(prepared.request.persistent_session, { resume: false });
  await store.acceptEvent(a.installation_id, event(task.active_execution_id, 1, 'execution.started'), delivery);
  await store.acceptEvent(a.installation_id, event(task.active_execution_id, 2, 'execution.completed'), delivery);
  await store.ackDelivery(delivery);
  assert.equal((await pool.query('SELECT 1 FROM messages WHERE task_id=$1', [task.id])).rowCount, 0);
  const detail = await api(a.owner_token, 'GET', `/agent-sessions/${one.id}`);
  assert.equal(detail.turns.length, 1); assert.match(detail.turns[0].created_at, /^\d{4}-\d\d-\d\dT/); assert.equal(detail.turns[0].task.goal, 'First prompt'); assert.equal(detail.turns[0].response.messages[0].text, 'Answer');
  const followup = await api(a.collaborator_token, 'POST', path, { text: 'Follow up' }, 201);
  assert.equal(followup.status, 'awaiting_approval');
  await api(a.collaborator_token, 'POST', `/tasks/${followup.id}/approve`, {}, 403);
  const approved = await api(a.owner_token, 'POST', `/tasks/${followup.id}/approve`, {});
  assert.equal(approved.session_id, one.id);
  const metadata = (await store.events(a.owner_id, task.id, 0)).every(e => e.payload.session_managed === true && e.payload.agent_session_id === one.id);
  assert.equal(metadata, true);
});

test('stop and end fence leases and approvals, retain history, and enforce creator or owner access', async () => {
  const a = await fixture(), one = await session(a);
  const task = await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/messages`, { text: 'Work' }, 201);
  const delivery = (await store.claimDelivery(a.installation_id))!;
  await store.acceptEvent(a.installation_id, event(task.active_execution_id, 1, 'execution.started'), delivery);
  await api(a.collaborator_token, 'POST', `/agent-sessions/${one.id}/stop`, {}, 403);
  await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/stop`, {});
  assert.equal((await store.readTask(a.owner_id, task.id)).status, 'failed');
  await assert.rejects(store.renewDelivery(delivery, randomUUID()), { status: 409 });
  await assert.rejects(store.acceptEvent(a.installation_id, event(task.active_execution_id, 2, 'execution.completed'), delivery), { status: 409 });
  const pending = await api(a.collaborator_token, 'POST', `/agent-sessions/${one.id}/messages`, { text: 'Needs approval' }, 201);
  await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/end`, {});
  await api(a.owner_token, 'POST', `/tasks/${pending.id}/approve`, {}, 409);
  await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/messages`, { text: 'After end' }, 409);
  const detail = await api(a.owner_token, 'GET', `/agent-sessions/${one.id}`);
  assert.equal(detail.session.state, 'ended'); assert.equal(detail.turns.length, 2);
});

test('concurrent distinct sends create only one turn and legacy sessions cannot receive persistent turns', async () => {
  const a = await fixture(), one = await session(a);
  const responses = await Promise.all(['One', 'Two'].map(text => app.inject({ method: 'POST', url: `/v1/agent-sessions/${one.id}/messages`, headers: { authorization: `Bearer ${a.owner_token}`, 'idempotency-key': randomUUID() }, payload: { text } })));
  assert.deepEqual(responses.map(r => r.statusCode).sort(), [201, 409]);
  const legacy = await store.createTask(a.owner_id, { workspace_id: a.workspace_id, thread_id: a.thread_id, installation_id: a.installation_id, skill: 'codex.run', goal: 'Legacy' }, randomUUID());
  const approved = await store.approveTask(a.owner_id, legacy.id);
  const detail = await api(a.owner_token, 'GET', `/agent-sessions/${approved.session_id}`);
  assert.equal(detail.session.managed, false);
  await api(a.owner_token, 'POST', `/agent-sessions/${approved.session_id}/messages`, { text: 'New turn' }, 409);
  await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/stop`, {});
  const legacyDelivery = (await store.claimDelivery(a.installation_id))!;
  assert.equal((await store.prepareDelivery(legacyDelivery))!.request.persistent_session, undefined);
});

test('resume requires an acknowledged saved local session and first invocation receives linked thread context', async () => {
  const a = await fixture(), one = await session(a), path = `/agent-sessions/${one.id}`;
  const root = await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), thread_id: a.thread_id, text: 'The linked thread context' }, 201);
  const rejected = await api(a.collaborator_token, 'POST', `${path}/messages`, { text: 'Rejected request' }, 201);
  await api(a.owner_token, 'POST', `/tasks/${rejected.id}/reject`, {});
  const stopped = await api(a.owner_token, 'POST', `${path}/messages`, { text: 'Stopped before execution' }, 201);
  await api(a.owner_token, 'POST', `${path}/stop`, {});
  assert.equal((await store.readTask(a.owner_id, stopped.id)).status, 'failed');
  const first = await api(a.owner_token, 'POST', `${path}/messages`, { text: 'First real execution' }, 201);
  const delivery = (await store.claimDelivery(a.installation_id))!;
  const prepared = (await store.prepareDelivery(delivery))!;
  assert.deepEqual(prepared.request.persistent_session, { resume: false });
  assert.equal(prepared.request.context!.working_memory!.root!.id, root.id);
  await store.acceptEvent(a.installation_id, event(first.active_execution_id, 1, 'execution.started'), delivery);
  await api(a.owner_token, 'POST', `${path}/stop`, {});
  const unready = await api(a.owner_token, 'POST', `${path}/messages`, { text: 'Start interrupted before saved session was ready' }, 201);
  const unreadyDelivery = (await store.claimDelivery(a.installation_id))!;
  assert.deepEqual((await store.prepareDelivery(unreadyDelivery))!.request.persistent_session, { resume: false });
  await store.acceptEvent(a.installation_id, event(unready.active_execution_id, 1, 'execution.started'), unreadyDelivery);
  const ready = event(unready.active_execution_id, 2, 'execution.progress');
  await store.acceptEvent(a.installation_id, { ...ready, payload: { ...ready.payload, session_ready: true } }, unreadyDelivery);
  await api(a.owner_token, 'POST', `${path}/stop`, {});
  await api(a.owner_token, 'POST', `${path}/messages`, { text: 'Resume after interrupted ready turn' }, 201);
  const followup = (await store.claimDelivery(a.installation_id))!;
  assert.deepEqual((await store.prepareDelivery(followup))!.request.persistent_session, { resume: true });
  const other = await session(a, 'Unrelated history');
  await api(a.owner_token, 'POST', `/agent-sessions/${other.id}/messages`, { text: 'Separate first turn' }, 201);
  const unrelated = (await store.claimDelivery(a.installation_id))!;
  assert.deepEqual((await store.prepareDelivery(unrelated))!.request.persistent_session, { resume: false });
});

test('history pages recent twenty turns chronologically with only their latest snapshots', async () => {
  const a = await fixture(), one = await session(a), ids: string[] = [];
  for (let i = 0; i < 25; i++) {
    const task = await api(a.collaborator_token, 'POST', `/agent-sessions/${one.id}/messages`, { text: `Prompt ${i}` }, 201);
    ids.push(task.id);
    await api(a.owner_token, 'POST', `/tasks/${task.id}/reject`, {});
  }
  const recent = await api(a.owner_token, 'GET', `/agent-sessions/${one.id}`);
  assert.deepEqual(recent.turns.map((t: any) => t.task.id), ids.slice(5));
  assert.equal(recent.session.turn_count, 25);
  assert.equal(recent.next_cursor, ids[5]);
  const older = await api(a.owner_token, 'GET', `/agent-sessions/${one.id}?before=${recent.next_cursor}`);
  assert.deepEqual(older.turns.map((t: any) => t.task.id), ids.slice(0, 5)); assert.equal(older.next_cursor, null);
  const another = await session(a), foreign = await api(a.collaborator_token, 'POST', `/agent-sessions/${another.id}/messages`, { text: 'Other cursor' }, 201);
  await api(a.owner_token, 'GET', `/agent-sessions/${one.id}?before=${foreign.id}`, undefined, 404);
});

test('revocation fences managed sends, approval and delivery; removed members lose session reads', async () => {
  const a = await fixture(), one = await session(a);
  const task = await api(a.collaborator_token, 'POST', `/agent-sessions/${one.id}/messages`, { text: 'Pending' }, 201);
  await pool.query('UPDATE agent_connections SET revoked_at=now() WHERE installation_id=$1', [a.installation_id]);
  await api(a.owner_token, 'POST', `/tasks/${task.id}/approve`, {}, 403);
  await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/messages`, { text: 'Revoked' }, 403);
  await pool.query('UPDATE agent_connections SET revoked_at=NULL WHERE installation_id=$1', [a.installation_id]);
  await api(a.owner_token, 'POST', `/tasks/${task.id}/approve`, {});
  const delivery = (await store.claimDelivery(a.installation_id))!;
  await pool.query('UPDATE agent_connections SET revoked_at=now() WHERE installation_id=$1', [a.installation_id]);
  await assert.rejects(store.prepareDelivery(delivery), { code: 'installation_not_authorized' });
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2', [a.channel_id, a.collaborator_id]);
  await api(a.collaborator_token, 'GET', `/agent-sessions/${one.id}`, undefined, 404);
  await api(a.collaborator_token, 'GET', `/threads/${a.thread_id}/agent-sessions`, undefined, 404);
});

test('session creator can stop and end; racing approval cannot leave work queued after end', async () => {
  const a = await fixture();
  const one = await api(a.collaborator_token, 'POST', `/threads/${a.thread_id}/agent-sessions`, { client_session_id: randomUUID(), installation_id: a.installation_id, title: 'Collaborator session' }, 201);
  assert.equal(one.created_by, a.collaborator_id);
  const task = await api(a.collaborator_token, 'POST', `/agent-sessions/${one.id}/messages`, { text: 'Pending approval' }, 201);
  const [approval, end] = await Promise.all([
    app.inject({ method: 'POST', url: `/v1/tasks/${task.id}/approve`, headers: { authorization: `Bearer ${a.owner_token}` }, payload: {} }),
    app.inject({ method: 'POST', url: `/v1/agent-sessions/${one.id}/end`, headers: { authorization: `Bearer ${a.collaborator_token}` }, payload: {} }),
  ]);
  assert.ok([200, 409].includes(approval.statusCode), approval.body);
  assert.equal(end.statusCode, 200, end.body);
  assert.equal((await store.readTask(a.owner_id, task.id)).status, 'failed');
  assert.equal((await pool.query("SELECT 1 FROM outbox WHERE task_id=$1 AND state IN ('pending','delivering')", [task.id])).rowCount, 0);
});

test('session sends reject goals beyond the connector invocation bound', async () => {
  const a = await fixture(), one = await session(a);
  await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/messages`, { text: 'x'.repeat(4001) }, 400);
  await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/messages`, { text: 'x'.repeat(4000) }, 201);
});

test('detail and stop retain the latest response snapshot across progress events without one', async () => {
  const a = await fixture(), one = await session(a);
  const task = await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/messages`, { text: 'Keep partial response' }, 201);
  const delivery = (await store.claimDelivery(a.installation_id))!;
  const base = event(task.active_execution_id, 1, 'execution.started');
  const started = { ...base, payload: { ...base.payload, response: { messages: [{ id: 'reply', text: 'Answer', status: 'streaming' }], tools: [{ id: 'read', name: 'read_text_file', arguments: '{}', status: 'running' }], components: [], items: [{ type: 'message', id: 'reply' }, { type: 'tool', id: 'read' }], activity: 'using_tools' } } };
  await store.acceptEvent(a.installation_id, started, delivery);
  const progress = { ...event(task.active_execution_id, 2, 'execution.progress'), payload: { text: 'Still working' } };
  await store.acceptEvent(a.installation_id, progress, delivery);
  const detail = await api(a.owner_token, 'GET', `/agent-sessions/${one.id}`);
  assert.equal(detail.turns[0].response?.messages[0].text, 'Answer');
  assert.equal(detail.turns[0].detail, 'Still working');
  await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/stop`, {});
  const stopped = await api(a.owner_token, 'GET', `/agent-sessions/${one.id}`);
  assert.equal(stopped.turns[0].response?.messages[0].text, 'Answer');
  assert.deepEqual(stopped.turns[0].response?.items, started.payload.response.items);
  assert.equal(stopped.turns[0].response?.tools[0].status, 'interrupted');
  assert.equal(stopped.turns[0].response?.activity, undefined);
});

test('session lists cap at one hundred and changes wake only their linked thread', async () => {
  const a = await fixture();
  const ids = Array.from({ length: 101 }, () => randomUUID());
  await pool.query(`INSERT INTO agent_sessions(id,workspace_id,installation_id,origin_thread_id,title,managed,created_by)
    SELECT session_id,$2,$3,$4,'Named session',true,$5 FROM unnest($1::uuid[]) session_id`, [ids, a.workspace_id, a.installation_id, a.thread_id, a.owner_id]);
  const page = await api(a.owner_token, 'GET', `/threads/${a.thread_id}/agent-sessions`);
  assert.equal(page.items.length, 100); assert.equal(page.next_cursor, null);
  const otherThread = randomUUID();
  await pool.query('INSERT INTO threads(id,workspace_id,channel_id) VALUES($1,$2,$3)', [otherThread, a.workspace_id, a.channel_id]);
  const revision = async (thread: string) => (await pool.query('SELECT revision FROM resource_update_revisions WHERE resource=$1', [`thread:${thread}`])).rows[0]?.revision;
  const before = await revision(a.thread_id);
  await api(a.owner_token, 'POST', `/agent-sessions/${ids[0]}/messages`, { text: 'Wake session conversation' }, 201);
  assert.ok(Number(await revision(a.thread_id)) > Number(before));
  assert.equal(await revision(otherThread), undefined);
});

test('stopping one session and sending to another preserve concurrent updates', async () => {
  const a = await fixture(), one = await session(a), two = await session(a);
  for (let i = 0; i < 6; i++) {
    await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/messages`, { text: `Run ${i}` }, 201);
    await Promise.all([
      api(a.owner_token, 'POST', `/agent-sessions/${one.id}/stop`, {}),
      api(a.owner_token, 'POST', `/agent-sessions/${two.id}/messages`, { text: `Parallel ${i}` }, 201),
    ]);
    await api(a.owner_token, 'POST', `/agent-sessions/${two.id}/stop`, {});
  }
});


async function pairedSession() {
  const a = await bootstrap(pool);
  const pairing = await api(a.owner_token, 'POST', `/workspaces/${a.workspace_id}/agent-pairings`, {}, 201);
  const credential = randomBytes(32).toString('base64url');
  const claim = await app.inject({ method: 'POST', url: '/v1/agent-pairings/claim', payload: { code: pairing.code, credential } });
  assert.equal(claim.statusCode, 201, claim.body);
  const installation_id: string = claim.json().installation_id;
  const seed = { ...a, installation_id };
  await api(a.owner_token, 'POST', `/agents/connections/${installation_id}/channels/${a.channel_id}`, { enabled: true });
  const socket = io(`${origin}/agents`, { transports: ['websocket'], auth: { token: credential }, autoConnect: false, reconnection: false });
  sockets.push(socket);
  let available = false;
  socket.on('agent.tasks.available', () => { available = true; });
  const connected = new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  socket.connect(); await connected;
  const command = (name: string, body: object = {}): Promise<any> => socket.timeout(2000).emitWithAck(name, body);
  assert.equal((await command('agent.heartbeat', { auth_status: 'ready' })).error, undefined);
  const claimReady = async () => {
    if (!available) await new Promise<void>((resolve, reject) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { socket.off('agent.tasks.available', done); reject(new Error('missing durable task notification')); }, 5000);
      socket.once('agent.tasks.available', done);
    });
    available = false;
    return command('agent.task.claim');
  };
  return { seed, one: await session(seed), command, claimReady };
}

test('explicit stop returns a deliberate cancellation and releases the socket for the next session turn', async () => {
  const { seed: a, one, command, claimReady } = await pairedSession();
  await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/messages`, { text: 'Stop this turn' }, 201);
  const { data: request } = await claimReady();
  assert.equal((await command('agent.task.event', { event: event(request.execution_id, 1, 'execution.started') })).data, true);
  const ready = event(request.execution_id, 2, 'execution.progress');
  assert.equal((await command('agent.task.event', { event: { ...ready, payload: { ...ready.payload, session_ready: true } } })).data, true);
  await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/stop`, {});
  const next = await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/messages`, { text: 'Continue after stop' }, 201);
  assert.equal((await command('agent.task.event', { event: event(randomUUID(), 2, 'execution.progress') })).error, 'stale_execution');
  assert.equal((await command('agent.task.renew')).error, 'agent_session_stopped');
  const followup = await claimReady();
  assert.equal(followup.data?.task_id, next.id);
  assert.deepEqual(followup.data?.persistent_session, { resume: true });
});

test('end returns deliberate cancellation for a current event while revocation retains its authority error', async () => {
  const { seed: a, one, command, claimReady } = await pairedSession();
  await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/messages`, { text: 'End this turn' }, 201);
  const { data: request } = await claimReady();
  await command('agent.task.event', { event: event(request.execution_id, 1, 'execution.started') });
  await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/end`, {});
  assert.equal((await command('agent.task.event', { event: event(request.execution_id, 2, 'execution.progress') })).error, 'agent_session_stopped');
  assert.equal((await command('agent.task.claim')).data, null);
  const other = await session(a);
  await api(a.owner_token, 'POST', `/agent-sessions/${other.id}/messages`, { text: 'Stop then revoke' }, 201);
  await claimReady();
  await api(a.owner_token, 'POST', `/agent-sessions/${other.id}/stop`, {});
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[a.channel_id,a.owner_id]);
  assert.equal((await command('agent.task.renew')).error, 'installation_not_authorized');
});

test('durable session outputs survive conversation pagination and merge latest file paths', async () => {
  const a = await fixture(), one = await session(a), path = `/agent-sessions/${one.id}`;
  const task = await api(a.owner_token, 'POST', `${path}/messages`, { text: 'Produce saved outputs' }, 201);
  const delivery = (await store.claimDelivery(a.installation_id))!;
  const started = event(task.active_execution_id, 1, 'execution.started');
  const firstOutputs = { files: [{ path: 'app.ts', content: 'v1' }, { path: 'keep.ts', content: 'unchanged' }], changes: [{ path: 'app.ts', patch: '+v1' }], preview: { state: 'ready', label: 'Preview', url: 'https://example.com/preview' } };
  await store.acceptEvent(a.installation_id, { ...started, payload: { ...started.payload, response: { ...started.payload.response, outputs: firstOutputs } } }, delivery);
  const completed = event(task.active_execution_id, 2, 'execution.completed');
  await store.acceptEvent(a.installation_id, { ...completed, payload: { ...completed.payload, response: { ...completed.payload.response, outputs: { files: [{ path: 'app.ts', content: 'v2' }], changes: [{ path: 'app.ts', patch: '+v2' }] } } } }, delivery);
  await store.ackDelivery(delivery);
  for (let i = 0; i < 21; i++) {
    const turn = await api(a.collaborator_token, 'POST', `${path}/messages`, { text: `Later text ${i}` }, 201);
    await api(a.owner_token, 'POST', `/tasks/${turn.id}/reject`, {});
  }
  const detail = await api(a.owner_token, 'GET', path);
  assert.equal(detail.turns.length, 20);
  assert.equal(detail.turns.some((turn: any) => turn.task.id === task.id), false);
  assert.deepEqual(detail.outputs?.preview, firstOutputs.preview);
  assert.deepEqual(detail.outputs?.files.find((file: any) => file.path === 'app.ts'), { path: 'app.ts', content: 'v2' });
  assert.deepEqual(detail.outputs?.files.find((file: any) => file.path === 'keep.ts'), firstOutputs.files[1]);
  assert.deepEqual(detail.outputs?.changes, [{ path: 'app.ts', patch: '+v2' }]);
});

test('durable output collections retain the twenty most recently updated paths', async () => {
  const a = await fixture(), one = await session(a);
  const task = await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/messages`, { text: 'Bound saved files' }, 201);
  const delivery = (await store.claimDelivery(a.installation_id))!;
  const files = Array.from({ length: 20 }, (_, i) => ({ path: `file-${i}.ts`, content: 'old' }));
  const changes = files.map(file => ({ path: file.path, patch: '+old' }));
  const started = event(task.active_execution_id, 1, 'execution.started');
  await store.acceptEvent(a.installation_id, { ...started, payload: { ...started.payload, response: { ...started.payload.response, outputs: { files, changes } } } }, delivery);
  const progress = event(task.active_execution_id, 2, 'execution.progress');
  await store.acceptEvent(a.installation_id, { ...progress, payload: { ...progress.payload, response: { ...progress.payload.response, outputs: { files: [{ path: 'file-0.ts', content: 'updated' }, { path: 'file-20.ts', content: 'new' }], changes: [{ path: 'file-0.ts', patch: '+updated' }, { path: 'file-20.ts', patch: '+new' }] } } } }, delivery);
  const detail = await api(a.owner_token, 'GET', `/agent-sessions/${one.id}`);
  assert.equal(detail.outputs.files.length, 20); assert.equal(detail.outputs.changes.length, 20);
  assert.deepEqual(detail.outputs.files.find((file: any) => file.path === 'file-0.ts'), { path: 'file-0.ts', content: 'updated' });
  assert.equal(detail.outputs.files.some((file: any) => file.path === 'file-1.ts'), false);
  assert.equal(detail.outputs.changes.some((file: any) => file.path === 'file-1.ts'), false);
});

test('legacy local tasks cannot assert persistent session readiness', async () => {
  const a = await fixture();
  const task = await store.createTask(a.owner_id, { workspace_id: a.workspace_id, thread_id: a.thread_id, installation_id: a.installation_id, skill: 'codex.run', goal: 'Legacy run' }, randomUUID());
  const approved = await store.approveTask(a.owner_id, task.id);
  const delivery = (await store.claimDelivery(a.installation_id))!;
  await store.acceptEvent(a.installation_id, event(approved.active_execution_id!, 1, 'execution.started'), delivery);
  const ready = event(approved.active_execution_id!, 2, 'execution.progress');
  await assert.rejects(store.acceptEvent(a.installation_id, { ...ready, payload: { ...ready.payload, session_ready: true } }, delivery), { code: 'invalid_session_ready' });
  assert.equal((await store.events(a.owner_id, task.id, 0)).some(e => e.payload.session_ready === true), false);
});

test('managed session code contains no explicit lock acquisition and uses revision checks', async () => {
  const { readFile } = await import('node:fs/promises');
  const sessionSource = await readFile(new URL('../../adapters/postgres/agent-sessions.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(sessionSource, /\.for\s*\(|FOR\s+(?:UPDATE|SHARE)|SKIP\s+LOCKED|pg_advisory/i);
  assert.match(sessionSource, /revision/);
});

test('identical concurrent create and send retries preserve one session and one task', async () => {
  const a = await fixture(), input = { client_session_id: randomUUID(), installation_id: a.installation_id, title: 'Concurrent creation' };
  const sessions = await Promise.all(Array.from({ length: 4 }, () => api(a.owner_token, 'POST', `/threads/${a.thread_id}/agent-sessions`, input, 201)));
  assert.equal(new Set(sessions.map(s => s.id)).size, 1);
  const key = randomUUID();
  const turns = await Promise.all(Array.from({ length: 4 }, () => api(a.owner_token, 'POST', `/agent-sessions/${sessions[0].id}/messages`, { text: 'Identical request' }, 201, key)));
  assert.equal(new Set(turns.map(turn => turn.id)).size, 1);
  assert.equal((await pool.query('SELECT count(*) FROM tasks WHERE session_id=$1', [sessions[0].id])).rows[0].count, '1');
});


test('managed session operations execute no explicit locking queries, including shared task helpers', async () => {
  const a = await fixture();
  const observed = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 1 });
  const statements: string[] = [];
  observed.on('connect', client => {
    const query = client.query;
    client.query = function (config: string | { text?: string }, ...args: unknown[]) {
      statements.push(typeof config === 'string' ? config : config.text ?? '');
      return Reflect.apply(query, client, [config, ...args]);
    } as typeof client.query;
  });
  const sessions = new AgentSessionStore(observed), tasks = new PostgresStore(observed);
  try {
    const one = await sessions.create(a.owner_id, a.thread_id, { client_session_id: randomUUID(), installation_id: a.installation_id, title: 'Observed session' });
    const pending = await sessions.send(a.collaborator_id, one.id, { text: 'Audit managed SQL' }, randomUUID());
    const task = await tasks.approveTask(a.owner_id, pending.id);
    const delivery = (await store.claimDelivery(a.installation_id))!;
    await tasks.prepareDelivery(delivery);
    await tasks.acceptEvent(a.installation_id, event(task.active_execution_id!, 1, 'execution.started'), delivery);
    await sessions.read(a.owner_id, one.id);
    await tasks.events(a.owner_id, task.id, 0);
    await assert.rejects(tasks.renewDelivery(delivery, randomUUID()), { code: 'unauthorized' });
    await sessions.control(a.owner_id, one.id, 'stop');
    await assert.rejects(tasks.wasSessionStopped(delivery, a.installation_id, randomUUID()), { code: 'unauthorized' });
    const next = await sessions.send(a.collaborator_id, one.id, { text: 'Reject this turn' }, randomUUID());
    await tasks.rejectTask(a.owner_id, next.id);
    await sessions.control(a.owner_id, one.id, 'end');
    assert.equal(statements.some(statement => /FOR\s+(?:UPDATE|SHARE|NO\s+KEY\s+UPDATE)|SKIP\s+LOCKED|pg_advisory/i.test(statement)), false);
    assert.ok(statements.some(statement => /serializable/i.test(statement)));
  } finally { await observed.end(); }
});

test('persistent database conflicts stop after five retries with an explicit conflict and no partial turn', async () => {
  const a = await fixture(), one = await session(a);
  await pool.query('CREATE SEQUENCE session_conflict_attempts');
  await pool.query(`CREATE FUNCTION force_session_conflict() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.goal='force_session_conflict' THEN PERFORM nextval('session_conflict_attempts'); RAISE EXCEPTION 'synthetic transaction conflict' USING ERRCODE='40001'; END IF;
    RETURN NEW; END; $$`);
  await pool.query('CREATE TRIGGER force_session_conflict BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION force_session_conflict()');
  try {
    const response = await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/messages`, { text: 'force_session_conflict' }, 409);
    assert.equal(response.error, 'session_conflict');
    assert.equal((await pool.query('SELECT last_value::integer FROM session_conflict_attempts')).rows[0].last_value, 5);
    assert.equal((await pool.query('SELECT count(*) FROM tasks WHERE session_id=$1', [one.id])).rows[0].count, '0');
  } finally {
    await pool.query('DROP TRIGGER force_session_conflict ON tasks');
    await pool.query('DROP FUNCTION force_session_conflict()');
    await pool.query('DROP SEQUENCE session_conflict_attempts');
  }
  await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/messages`, { text: 'After bounded failure' }, 201);
});

test('concurrent event receipts preserve sequence and a racing stop cannot resurrect a task', async () => {
  const a = await fixture(), one = await session(a);
  const task = await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/messages`, { text: 'Concurrent execution events' }, 201);
  const delivery = (await store.claimDelivery(a.installation_id))!;
  const started = event(task.active_execution_id, 1, 'execution.started');
  await Promise.all([store.acceptEvent(a.installation_id, started, delivery), store.acceptEvent(a.installation_id, started, delivery)]);
  assert.equal((await pool.query("SELECT count(*) FROM task_events WHERE correlation_id=$1 AND type='execution.started'", [task.id])).rows[0].count, '1');
  const raced = await Promise.allSettled([store.acceptEvent(a.installation_id, event(task.active_execution_id, 2, 'execution.progress'), delivery), store.acceptEvent(a.installation_id, event(task.active_execution_id, 2, 'execution.progress'), delivery)]);
  assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1);
  const failed = raced.find(result => result.status === 'rejected');
  assert.equal(failed?.status === 'rejected' && failed.reason.code, 'event_out_of_order');
  const completed = event(task.active_execution_id, 3, 'execution.completed');
  const terminal = await Promise.allSettled([
    store.acceptEvent(a.installation_id, completed, delivery),
    api(a.owner_token, 'POST', `/agent-sessions/${one.id}/stop`, {}),
  ]);
  assert.equal(terminal[1]!.status, 'fulfilled');
  const saved = await store.readTask(a.owner_id, task.id);
  assert.ok(['completed', 'failed'].includes(saved.status));
  assert.equal((await pool.query('SELECT count(*) FROM messages WHERE task_id=$1', [task.id])).rows[0].count, '0');
  if (saved.status === 'failed') await assert.rejects(store.acceptEvent(a.installation_id, completed, delivery), { status: 409 });
});
test('session turns retain the same rich document as thread messages and include formatting in retry identity',async()=>{
 const a=await fixture(),one=await session(a),path=`/agent-sessions/${one.id}/messages`,key=randomUUID();
 const document={ops:[{insert:'Formatted request',attributes:{bold:true}},{insert:'\n'}]};
 const task=await api(a.owner_token,'POST',path,{text:'Formatted request',document},201,key);
 assert.deepEqual((await api(a.owner_token,'GET',`/agent-sessions/${one.id}`)).turns[0].task.request_document,document);
 assert.equal((await api(a.owner_token,'POST',path,{text:'Formatted request',document},201,key)).id,task.id);
 await api(a.owner_token,'POST',path,{text:'Formatted request',document:{ops:[{insert:'Formatted request\n'}]}},409,key);
 await api(a.owner_token,'POST',path,{text:'Different text',document},400);
 await assert.rejects(pool.query('UPDATE tasks SET request_document=$2 WHERE id=$1',[task.id,{ops:[{insert:'Edited\n'}]}]),/immutable/);
});

test('session mention references retain their identity across reads without notifications or extra agent runs',async()=>{
 const a=await fixture(),one=await session(a);
 const mention={kind:'user',id:a.collaborator_id,label:'Demo collaborator'};
 const document={ops:[{insert:'@Demo collaborator',attributes:{mention}},{insert:' please review\n'}]};
 const key=randomUUID(),body={text:'@Demo collaborator please review',document};
 const task=await api(a.owner_token,'POST',`/agent-sessions/${one.id}/messages`,body,201,key);
 assert.equal(task.goal,'@Demo collaborator please review');
 assert.equal((await api(a.owner_token,'POST',`/agent-sessions/${one.id}/messages`,body,201,key)).id,task.id);
 const detail=await api(a.owner_token,'GET',`/agent-sessions/${one.id}`);
 assert.deepEqual(detail.turns[0].task.request_document.ops[0].attributes.mention,{...mention,label:'Demo collaborator'});
 assert.equal((await pool.query('SELECT 1 FROM mention_notifications WHERE workspace_id=$1',[a.workspace_id])).rowCount,0);
 assert.equal((await pool.query('SELECT 1 FROM tasks WHERE session_id=$1',[one.id])).rowCount,1);
});
