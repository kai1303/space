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
import { AppError } from '@space/contracts';

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
async function api(token: string, method: 'GET' | 'POST' | 'PATCH', path: string, payload?: object, status = 200, key = randomUUID()) {
  const response = await app.inject({ method, url: `/v1${path}`, headers: { authorization: `Bearer ${token}`, 'idempotency-key': key }, ...(payload ? { payload } : {}) });
  assert.equal(response.statusCode, status, `${path}: ${response.body}`);
  return response.json();
}
async function fixture() {
  const seed = await bootstrap(pool);
  await pool.query("UPDATE agent_definitions SET capabilities=$2 WHERE id=$1", [seed.definition_id, { skills: ['codex.run'], controls: {}, persistent_sessions: true }]);
  // Exercise the legacy durable delivery protocol here; immediate Codex admission has its own suite.
  await pool.query("UPDATE agent_installations SET connector_id='codex.legacy-test' WHERE id=$1", [seed.installation_id]);
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
  const location = await api(a.collaborator_token, 'GET', `/agent-sessions/${one.id}/location`);
  assert.deepEqual(location, {id:one.id, workspace_id:a.workspace_id, origin_thread_id:a.thread_id, channel_id:a.channel_id, channel_archived:false, agent_name:one.agent_name});
  await api(foreign.owner_token, 'GET', `/agent-sessions/${one.id}/location`, undefined, 404);
  await api(foreign.owner_token, 'GET', `/agent-sessions/${one.id}`, undefined, 404);
  await api(foreign.owner_token, 'POST', `/threads/${a.thread_id}/agent-sessions`, input, 404);
  await api(a.owner_token, 'POST', `/threads/${a.thread_id}/agent-sessions`, { ...input, client_session_id: randomUUID(), title: '' }, 400);
  const revisions = await pool.query('SELECT revision FROM resource_update_revisions WHERE resource=$1', [`thread:${a.thread_id}`]);
  assert.ok(Number(revisions.rows[0]?.revision) >= 2);
});

test('renaming a session preserves creation retries and rejects unauthorized or stale edits', async () => {
  const a = await fixture(), foreign = await fixture();
  const input = { client_session_id: randomUUID(), installation_id: a.installation_id, title: 'First' };
  const createPath = `/threads/${a.thread_id}/agent-sessions`;
  const one = await api(a.owner_token, 'POST', createPath, input, 201);
  const path = `/agent-sessions/${one.id}`;
  const stars = `/workspaces/${a.workspace_id}/hub/starred-sessions`;
  await api(a.collaborator_token, 'POST', `${stars}/${one.id}`, {active:true});
  const edit = { previous_title: 'First', title: ' Roadmap ' };
  await api(a.collaborator_token, 'PATCH', path, edit, 403);
  await api(foreign.owner_token, 'PATCH', path, edit, 404);
  await api(a.owner_token, 'PATCH', path, { ...edit, title: ' ' }, 400);
  assert.equal((await api(a.owner_token, 'PATCH', path, edit)).title, 'Roadmap');
  assert.equal((await api(a.owner_token, 'PATCH', path, edit)).title, 'Roadmap');
  await api(a.owner_token, 'PATCH', path, { ...edit, title: 'Stale edit' }, 409);
  const starred = (await api(a.collaborator_token, 'GET', stars)).items[0];
  assert.equal(starred.name, 'Roadmap');
  assert.equal(starred.can_rename, false);
  assert.equal((await api(a.collaborator_token, 'GET', path)).session.title, 'Roadmap');
  assert.equal((await api(a.owner_token, 'POST', createPath, input, 201)).title, 'Roadmap');
  await api(a.owner_token, 'POST', createPath, { ...input, title: 'Roadmap' }, 409);
  const race = await Promise.all(['April', 'May'].map(title => app.inject({
    method:'PATCH', url:`/v1${path}`, headers:{authorization:`Bearer ${a.owner_token}`},
    payload:{title,previous_title:'Roadmap'},
  })));
  assert.deepEqual(race.map(result=>result.statusCode).sort(), [200,409]);
  assert.equal((await api(a.owner_token, 'GET', path)).session.title,
    race.find(result=>result.statusCode===200)!.json().title);
});

test('turns preserve retry identity, serialize sends, reuse owner approval and stay out of human history', async () => {
  const a = await fixture(), one = await session(a), two = await session(a);
  const path = `/agent-sessions/${one.id}/messages`, key = randomUUID();
  const selected={model:'gpt-6-astra',effort:'xhigh'};
  await api(a.owner_token,'POST',path,{text:'Invalid effort',codex_settings:{...selected,effort:'bogus'}},409);
  const task = await api(a.owner_token, 'POST', path, { text: 'First prompt',codex_settings:selected }, 201, key);
  assert.equal(task.status, 'queued'); assert.equal(task.session_id, one.id);
  assert.equal((await api(a.owner_token, 'POST', path, { text: 'First prompt',codex_settings:selected }, 201, key)).id, task.id);
  await api(a.owner_token,'POST',path,{text:'First prompt',codex_settings:{...selected,effort:'low'}},409,key);
  await api(a.owner_token, 'POST', path, { text: 'Changed' }, 409, key);
  await api(a.owner_token, 'POST', path, { text: 'Overlap' }, 409);
  const competing = await Promise.all([api(a.owner_token, 'POST', `/agent-sessions/${two.id}/messages`, { text: 'Other session' }, 201)]);
  assert.equal(competing[0].session_id, two.id);
  const delivery = (await store.claimDelivery(a.installation_id))!;
  const prepared = (await store.prepareDelivery(delivery))!;
  assert.deepEqual(prepared.request.codex_settings,selected);
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

test('workspace and starred session rows follow running turns through completion and stop', async () => {
  const a = await fixture(), one = await session(a);
  const workspace = `/workspaces/${a.workspace_id}`;
  await api(a.owner_token, 'POST', `${workspace}/hub/starred-sessions/${one.id}`, {active:true});
  const read = async () => Promise.all(['agent-sessions','hub/starred-sessions'].map(async resource =>
    (await api(a.owner_token, 'GET', `${workspace}/${resource}`)).items[0].working));
  const revision = async () => Number((await pool.query('SELECT revision FROM resource_update_revisions WHERE resource=$1',
    [`workspace:${a.workspace_id}`])).rows[0].revision);
  for (const finish of ['complete','stop']) {
    const task = await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/messages`, {text:'Work'}, 201);
    const delivery = (await store.claimDelivery(a.installation_id))!;
    assert.deepEqual(await read(), [false,false]);
    const idle = await revision();
    await store.acceptEvent(a.installation_id, event(task.active_execution_id, 1, 'execution.started'), delivery);
    assert.deepEqual(await read(), [true,true]);
    const working = await revision();
    assert.ok(working > idle);
    await store.acceptEvent(a.installation_id, event(task.active_execution_id, 2, 'execution.progress'), delivery);
    assert.equal(await revision(), working);
    if (finish === 'stop') await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/stop`, {});
    else {
      await store.acceptEvent(a.installation_id, event(task.active_execution_id, 3, 'execution.completed'), delivery);
      await store.ackDelivery(delivery);
    }
    assert.deepEqual(await read(), [false,false]);
    assert.ok(await revision() > working);
  }
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

test('finished sessions retain a reviewable result and managers can reopen them without replaying work', async () => {
  const a = await fixture(), foreign = await fixture(), one = await session(a);
  const path = `/agent-sessions/${one.id}`;
  const task = await api(a.owner_token, 'POST', path+'/messages', {text:'Fix the login flow'}, 201);
  const delivery = (await store.claimDelivery(a.installation_id))!;
  await store.acceptEvent(a.installation_id, event(task.active_execution_id, 1, 'execution.started'), delivery);
  await store.acceptEvent(a.installation_id, event(task.active_execution_id, 2, 'execution.completed'), delivery);
  await store.ackDelivery(delivery);
  await api(a.owner_token, 'POST', path+'/end', {});
  const ended = await api(a.collaborator_token, 'GET', path);
  assert.deepEqual(ended.final_summary, {task_id:task.id, excerpt:'Answer'});
  await api(a.collaborator_token, 'POST', path+'/reopen', {}, 403);
  await api(foreign.owner_token, 'POST', path+'/reopen', {}, 404);
  await pool.query('UPDATE channels SET archived_at=now() WHERE id=$1',[a.channel_id]);
  await api(a.owner_token, 'POST', path+'/reopen', {}, 409);
  await pool.query('UPDATE channels SET archived_at=NULL WHERE id=$1',[a.channel_id]);
  const revision = async () => (await pool.query('SELECT revision FROM agent_sessions WHERE id=$1',[one.id])).rows[0].revision;
  const oldRevision = await revision();
  const reopened = await Promise.all([1,2].map(() => api(a.owner_token, 'POST', path+'/reopen', {})));
  assert.ok(reopened.every(session => session.state === 'active' && session.turn_count === 1));
  assert.equal(await revision(), oldRevision + 1);
  assert.equal((await api(a.owner_token, 'GET', path)).final_summary, undefined);
  assert.equal(await store.claimDelivery(a.installation_id), null);
  const next = await api(a.owner_token, 'POST', path+'/messages', {text:'Review feedback'}, 201);
  assert.equal(next.session_id, one.id);
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
  assert.equal(recent.has_newer, false); assert.equal(older.has_newer, true);
  const newer = await api(a.owner_token, 'GET', `/agent-sessions/${one.id}?after=${ids[4]}`);
  assert.deepEqual(newer.turns.map((t: any) => t.task.id), ids.slice(5)); assert.equal(newer.has_newer, false);
  const middle = await api(a.owner_token, 'GET', `/agent-sessions/${one.id}?after=${ids[0]}`);
  assert.deepEqual(middle.turns.map((t: any) => t.task.id), ids.slice(1,21)); assert.equal(middle.has_newer, true);
  await api(a.owner_token, 'GET', `/agent-sessions/${one.id}?before=${ids[1]}&after=${ids[0]}`, undefined, 400);
  const another = await session(a), foreign = await api(a.collaborator_token, 'POST', `/agent-sessions/${another.id}/messages`, { text: 'Other cursor' }, 201);
  await api(a.owner_token, 'GET', `/agent-sessions/${one.id}?after=${foreign.id}`, undefined, 404);
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

test('thread session lists cap at one hundred and turns leave unrelated threads untouched', async () => {
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


async function pairedSession(provider:'codex'|'claude'='codex') {
  const a = await bootstrap(pool);
  const pairing = await api(a.owner_token, 'POST', `/workspaces/${a.workspace_id}/agent-pairings`, {provider}, 201);
  const credential = randomBytes(32).toString('base64url');
  const claim = await app.inject({ method: 'POST', url: '/v1/agent-pairings/claim', payload: { code: pairing.code, credential, provider } });
  assert.equal(claim.statusCode, 201, claim.body);
  const installation_id: string = claim.json().installation_id;
  const seed = { ...a, installation_id };
  await api(a.owner_token, 'POST', `/agents/connections/${installation_id}/channels/${a.channel_id}`, { enabled: true });
  if (provider === 'codex') await pool.query("UPDATE agent_installations SET connector_id='codex.legacy-test' WHERE id=$1",[seed.installation_id]);
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

test('the paired Claude catalog controls per-model settings at admission and dispatch', async () => {
  const {seed,one,command,claimReady} = await pairedSession('claude');
  const path = `/agent-sessions/${one.id}`;
  const models = [{id:'claude-from-sdk',label:'Connected Claude',efforts:['high','max']},{id:'plain',label:'Plain',efforts:[]}];
  assert.equal((await command('agent.heartbeat',{auth_status:'ready',model_catalog:models})).error,undefined);
  assert.deepEqual(await api(seed.owner_token,'GET',path+'/models'),models);
  const outsider = await fixture();
  await api(outsider.owner_token,'GET',path+'/models',undefined,404);
  await api(seed.owner_token,'POST',path+'/messages',{text:'Wrong level',codex_settings:{model:'plain',effort:'max'}},409);
  const selection = {model:'claude-from-sdk',effort:'max'};
  await api(seed.owner_token,'POST',path+'/messages',{text:'Run',codex_settings:selection},201);
  const first = (await claimReady()).data;
  assert.deepEqual(first.codex_settings,selection);
  await api(seed.owner_token,'POST',path+'/queue',{text:'Next',codex_settings:{model:'plain'}});
  for (const [sequence,type] of [[1,'execution.started'],[2,'execution.completed']] as const) {
    assert.equal((await command('agent.task.event',{event:event(first.execution_id,sequence,type)})).data,true);
  }
  assert.equal((await command('agent.task.finish')).data,true);
  await new AgentSessionStore(pool).drainQueue(one.id);
  const queued = await api(seed.owner_token,'GET',path);
  assert.deepEqual(queued.turns.at(-1).task.codex_settings,{model:'plain'});
  assert.equal((await command('agent.heartbeat',{auth_status:'required'})).error,undefined);
  assert.deepEqual(await api(seed.owner_token,'GET',path+'/models'),[]);
});

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


test('workspace session navigation is paginated, includes private handoffs only for their owner, and follows membership', async () => {
  const a = await fixture(), foreign = await fixture();
  const created = [];
  for (let i = 0; i < 21; i++) created.push(await session(a, `Sidebar ${i}`));
  const path = `/workspaces/${a.workspace_id}/agent-sessions`;
  const page = await api(a.owner_token, 'GET', path);
  assert.equal(page.items.length, 20);
  assert.equal(page.items[0].id, created.at(-1).id);
  assert.equal(page.items[0].channel_id, a.channel_id);
  assert.equal(page.items[0].channel_archived, false);
  const older = await api(a.owner_token, 'GET', `${path}?before=${page.next_cursor}`);
  assert.deepEqual(older.items.map((item: any) => item.id), [created[0].id]);
  assert.equal(older.next_cursor, null);
  await api(foreign.owner_token, 'GET', path, undefined, 404);
  const source = await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, {client_message_id:randomUUID(),text:'Private sidebar context'}, 201);
  const privateSession = await api(a.owner_token, 'POST', `/workspaces/${a.workspace_id}/sidekick-sessions`, {client_session_id:randomUUID(),installation_id:a.installation_id,skill:'codex.run',source:{channel_id:a.channel_id,message_ids:[source.id]}}, 201);
  assert.equal((await api(a.owner_token, 'GET', path)).items[0].id, privateSession.id);
  assert.ok(!(await api(a.collaborator_token, 'GET', path)).items.some((item: any) => item.id === privateSession.id));
  await api(a.collaborator_token, 'GET', `${path}?before=${privateSession.id}`, undefined, 404);
  const revision = await pool.query('SELECT revision FROM resource_update_revisions WHERE resource=$1', [`workspace:${a.workspace_id}`]);
  await session(a, 'Live sidebar entry');
  const updated = await pool.query('SELECT revision FROM resource_update_revisions WHERE resource=$1', [`workspace:${a.workspace_id}`]);
  assert.ok(Number(updated.rows[0].revision) > Number(revision.rows[0].revision));
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2', [a.channel_id,a.collaborator_id]);
  assert.deepEqual((await api(a.collaborator_token, 'GET', path)).items, []);
});

test('session input links page across turns and delivered steering without including ambient context',async()=>{
  const a=await fixture(), one=await session(a), path='/agent-sessions/'+one.id+'/resources';
  const fixtures=await pool.query(`INSERT INTO tasks(id,workspace_id,thread_id,installation_id,goal,skill,requester_id,
    status,session_id,idempotency_key,request_hash,created_at,result)
    SELECT gen_random_uuid(),$1,$2,$3,'Read https://docs.example/release/'||n,'codex.run',$4,
      'completed',$5,n::text,'test',now()-n*interval '1 second','See https://private.example/output'
    FROM generate_series(1,23) n RETURNING id`,[a.workspace_id,a.thread_id,a.installation_id,a.owner_id,one.id]);
  for(const state of ['sent','cancelled']) {
    await pool.query(`INSERT INTO agent_session_inputs(id,session_id,actor_id,kind,execution_id,body,request_hash,state)
      VALUES($1,$2,$3,'steer',$4,$5,'test',$6)`,[randomUUID(),one.id,a.owner_id,randomUUID(),
      {text:'Review these links',document:{ops:[{insert:'these links',attributes:{link:'https://context.example/'+state}}]},
        browser_url:'https://private.example/browser'},state]);
  }
  const first=await api(a.owner_token,'GET',path), second=await api(a.owner_token,'GET',path+'?before='+first.next_cursor);
  assert.equal(first.items.length,20);assert.equal(second.items.length,4);assert.equal(second.next_cursor,null);
  const links=[...first.items,...second.items].flatMap(item=>item.links);
  assert.equal(new Set(links).size,24);assert.ok(links.includes('https://context.example/sent'));
  assert.ok(!links.some(link=>link.includes('private')||link.includes('cancelled')));
  const another=await session(a);
  await api(a.owner_token,'GET','/agent-sessions/'+another.id+'/resources?before=task:'+fixtures.rows[0].id,undefined,400);
  await pool.query('DELETE FROM channel_members WHERE user_id=$1 AND channel_id=$2',[a.collaborator_id,a.channel_id]);
  await api(a.collaborator_token,'GET',path,undefined,404);
});

test('session uploads bind once to their authorized turn, survive expiry, and reach the runner', async () => {
  const a = await fixture(), foreign = await fixture();
  const one = await session(a), other = await session(a);
  const { AssetStore } = await import('@space/postgres/assets');
  const assets = new AssetStore(pool);
  const file = await assets.create(a.owner_id, a.channel_id, {name:'trace.txt',size:5,type:'text/plain'});
  const path = `/agent-sessions/${one.id}/messages`;
  const body = {text:'',asset_ids:[file.id],asset_descriptions:{[file.id]:'Console log'}};
  await api(a.owner_token,'POST',path,body,409);
  await assets.complete(a.owner_id,file.id,async()=>({kind:'text',text:'hello',language:'plaintext',truncated:false}));
  await api(a.collaborator_token,'POST',path,body,409);
  const key = randomUUID();
  const task = await api(a.owner_token,'POST',path,body,201,key);
  assert.equal((await api(a.owner_token,'POST',path,body,201,key)).id,task.id);
  await api(a.owner_token,'POST',path,{...body,text:'Different'},409,key);
  await api(a.owner_token,'POST',`/agent-sessions/${other.id}/messages`,body,409);
  await pool.query("UPDATE assets SET expires_at=now()-interval '1 hour' WHERE id=$1",[file.id]);
  assert.equal((await assets.download(a.collaborator_id,file.id)).task_id,task.id);
  await assert.rejects(assets.download(foreign.owner_id,file.id), /not_found/);
  assert.equal((await assets.list(a.owner_id,a.channel_id)).items.length,0);
  assert.equal((await pool.query('SELECT 1 FROM graph_source_attachments WHERE id=$1', [file.id])).rowCount, 0);
  assert.equal((await pool.query('SELECT 1 FROM knowledge_visible_attachments($1,$2,$3,$4::uuid[])', [a.workspace_id,a.owner_id,a.channel_id,[file.id]])).rowCount, 0);
  const detail = await api(a.owner_token,'GET',`/agent-sessions/${one.id}`);
  assert.equal(detail.turns[0].task.attachments[0].description,'Console log');
  const resources = '/agent-sessions/'+one.id+'/resources';
  const page = await api(a.collaborator_token,'GET',resources);
  assert.deepEqual(page.items.map((item:any)=>item.files.map((f:any)=>f.id)),[[file.id]]);
  await api(foreign.owner_token,'GET',resources,undefined,404);
  assert.deepEqual((await api(a.owner_token,'GET','/agent-sessions/'+other.id+'/resources')).items,[]);
  const delivery = (await store.claimDelivery(a.installation_id))!;
  const prepared = (await store.prepareDelivery(delivery))!;
  assert.deepEqual(prepared.request.attachments?.[0]?.content,{kind:'text',text:'hello',truncated:false});
});

test('session queue replays FIFO once under concurrent drains, rechecks approval, and permits removal',async()=>{
 const a=await fixture(),s=await session(a),sessions=new AgentSessionStore(pool,store);
 const current=await api(a.owner_token,'POST',`/agent-sessions/${s.id}/messages`,{text:'Start'},201);
 const queue=`/agent-sessions/${s.id}/queue`,key=randomUUID();
 const {AssetStore}=await import('@space/postgres/assets');
 const assets=new AssetStore(pool);
 const file=await assets.create(a.collaborator_id,a.channel_id,{name:'note.txt',size:4,type:'text/plain'});
 await assets.complete(a.collaborator_id,file.id,async()=>({kind:'text',text:'note',language:'plaintext',truncated:false}));
 const body={text:'Next',asset_ids:[file.id],codex_settings:{model:'gpt-6.1-sol',effort:'low'}};
 const first=await api(a.collaborator_token,'POST',queue,body,200,key);
 assert.equal((await pool.query('SELECT 1 FROM graph_source_attachments WHERE id=$1', [file.id])).rowCount, 0);
 await api(a.collaborator_token,'POST',queue,body,409);
 await pool.query("UPDATE assets SET expires_at=now()-interval '1 day' WHERE id=$1",[file.id]);
 assert.equal(await assets.cleanup(async()=>{},1,file.id),0);
 assert.deepEqual(await api(a.collaborator_token,'POST',queue,body,200,key),first);
 await api(a.collaborator_token,'POST',queue,{text:'Changed'},409,key);
 const removed=await api(a.owner_token,'POST',queue,{text:'Remove me'});
 await api(a.collaborator_token,'POST',queue+'/'+removed.id+'/cancel',{},409);
 await api(a.owner_token,'POST',queue+'/'+removed.id+'/cancel',{});
 const last=await api(a.owner_token,'POST',queue,{text:'Last'});
 await api(a.owner_token,'PATCH',queue+'/'+last.id,{move_to:first.id});
 assert.deepEqual((await sessions.read(a.owner_id,s.id)).inputs!.map(item=>item.id),[last.id,first.id]);
 await api(a.owner_token,'PATCH',queue+'/'+first.id,{move_to:last.id});
 await api(a.owner_token,'PATCH',queue+'/'+last.id,{text:'Finally',previous_text:'Last'});
 await api(a.owner_token,'PATCH',queue+'/'+last.id,{text:'Stale',previous_text:'Last'},409);
 await sessions.drainQueue(s.id);
 assert.equal((await sessions.read(a.owner_id,s.id)).turns.length,1);
 const delivery=(await store.claimDelivery(a.installation_id))!;
 await store.acceptEvent(a.installation_id,event(current.active_execution_id,1,'execution.started'),delivery);
 await store.acceptEvent(a.installation_id,event(current.active_execution_id,2,'execution.completed'),delivery);
 await store.ackDelivery(delivery);
 await Promise.all([sessions.drainQueue(s.id),sessions.drainQueue(s.id)]);
 const detail=await sessions.read(a.owner_id,s.id);
 assert.deepEqual(detail.turns.map(row=>row.task.goal),['Start','Next']);
 assert.deepEqual(detail.turns[1]!.task.codex_settings,body.codex_settings);
 assert.equal(detail.turns[1]!.task.attachments?.[0]?.id,file.id);
 assert.equal(detail.turns[1]!.task.status,'awaiting_approval');
 assert.deepEqual(detail.inputs!.map(item=>item.text),['Finally']);
 await sessions.control(a.owner_id,s.id,'stop');
 await sessions.drainQueue(s.id);
 assert.equal((await sessions.read(a.owner_id,s.id)).session.queue_paused,true);
 assert.deepEqual((await sessions.read(a.owner_id,s.id)).inputs!.map(item=>item.text),['Finally']);
 await api(a.owner_token,'POST',queue+'/resume',{});
 await sessions.drainQueue(s.id);
 assert.equal((await sessions.read(a.owner_id,s.id)).turns.at(-1)?.task.goal,'Finally');
 assert.deepEqual((await sessions.read(a.owner_id,s.id)).inputs,[]);
});

test('PDF preparation opens only the attached sealed object and rechecks authorization after reading it', async () => {
  const a = await fixture(), one = await session(a);
  const { AssetStore } = await import('@space/postgres/assets');
  const assets = new AssetStore(pool);
  const pdf = await assets.create(a.owner_id, a.channel_id, {name:'report.pdf',size:1200,type:'application/pdf'});
  const other = await assets.create(a.owner_id, a.channel_id, {name:'other.pdf',size:1200,type:'application/pdf'});
  for (const file of [pdf, other]) await assets.complete(a.owner_id, file.id, async () => ({kind:'pdf',mime:'application/pdf'}));
  const task = await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/messages`, {text:'What is on page 7?',asset_ids:[pdf.id]}, 201);
  const delivery = (await store.claimDelivery(a.installation_id))!;
  assert.equal(delivery.task_id, task.id);
  const reader = new PostgresStore(pool);
  const content = {kind:'pdf',status:'readable',page_count:8,pages:[{page:7,text:'page seven evidence',truncated:false}]} as const;
  reader.attachmentPdf = async (key, size, page, count) => {
    assert.deepEqual([key,size,page,count], [`files/${pdf.id}`,1200,7,1]);
    return {...content, pages:[...content.pages]};
  };
  const prepared = await reader.prepareDelivery(delivery);
  assert.deepEqual(prepared?.request.attachments?.map(f => [f.id, f.content]), [[pdf.id,content]]);
  const authorizedRead = reader.attachmentPdf;
  for (const [code, status] of [['pdf_reader_busy', 'not_read'], ['storage_unavailable', 'unavailable']] as const) {
    reader.attachmentPdf = async () => { throw new AppError(503, code); };
    const fallback = await reader.prepareDelivery(delivery);
    assert.deepEqual(fallback?.request.attachments?.[0]?.content, {kind:'pdf',status,page_count:null,pages:[]});
  }
  reader.attachmentPdf = async (...args) => {
    const result = await authorizedRead(...args);
    await pool.query('UPDATE agent_installations SET enabled=false WHERE id=$1', [a.installation_id]);
    return result;
  };
  await assert.rejects(() => reader.prepareDelivery(delivery), {code:'installation_not_authorized'});
});

test('PDF inline excerpts share one deadline and keep unread files available as attachment metadata', async t => {
  const a = await fixture(), one = await session(a);
  const { AssetStore } = await import('@space/postgres/assets');
  const assets = new AssetStore(pool), ids = [];
  for (const name of ['first.pdf','second.pdf']) {
    const file = await assets.create(a.owner_id, a.channel_id, {name,size:100,type:'application/pdf'});
    await assets.complete(a.owner_id, file.id, async () => ({kind:'pdf',mime:'application/pdf'}));
    ids.push(file.id);
  }
  await api(a.owner_token, 'POST', `/agent-sessions/${one.id}/messages`, {text:'Summarize the attached files',asset_ids:ids}, 201);
  const delivery = (await store.claimDelivery(a.installation_id))!;
  const reader = new PostgresStore(pool), started = Date.now();
  let reads = 0;
  reader.attachmentPdf = async (_key, _size, page, count, budget) => {
    reads++;
    assert.equal(page, undefined);
    assert.equal(count, 2);
    assert.ok(budget! > 0 && budget! <= 8000);
    t.mock.method(Date, 'now', () => started + 8100);
    return {kind:'pdf',status:'readable',page_count:5,pages:[{page:1,text:'first page',truncated:false}]};
  };
  const prepared = await reader.prepareDelivery(delivery);
  assert.equal(reads, 1);
  assert.deepEqual(prepared?.request.attachments?.[1], {id:ids[1],name:'second.pdf',size:100,type:'application/pdf',
    content:{kind:'pdf',status:'not_read',page_count:null,pages:[]}});
});

test('native goals require the owner and persist provider updates only in the addressed session', async () => {
  const a = await fixture();
  await pool.query("UPDATE agent_definitions SET capabilities=$2 WHERE id=$1",[a.definition_id,{skills:['claude.run'],controls:{},persistent_sessions:true}]);
  await pool.query("UPDATE agent_installations SET connector_id='claude.local' WHERE id=$1",[a.installation_id]);
  await pool.query("UPDATE agent_grants SET skill='claude.run' WHERE installation_id=$1",[a.installation_id]);
  const one=await session(a), other=await session(a);
  const sessions = new AgentSessionStore(pool,new PostgresStore(pool));
  const connection = randomUUID();
  await pool.query("UPDATE agent_connections SET connection_id=$2,auth_status='ready',last_seen_at=now() WHERE installation_id=$1",[a.installation_id,connection]);
  const objective = 'The checks pass', input = {text:objective, goal_action:{kind:'set',objective}}, key = randomUUID();
  await api(a.collaborator_token,'POST',`/agent-sessions/${one.id}/messages`,input,403);
  await api(a.owner_token,'POST',`/agent-sessions/${one.id}/queue`,input,400);
  const task = await sessions.send(a.owner_id,one.id,input,key);
  assert.equal((await sessions.send(a.owner_id,one.id,input,key)).id,task.id);
  assert.deepEqual(task.goal_action,input.goal_action);
  const delivery = (await store.claimDelivery(a.installation_id))!;
  assert.deepEqual((await store.prepareDelivery(delivery,connection))?.request.goal_action,input.goal_action);
  const started = event(task.active_execution_id!,1,'execution.started');
  const progress = {...event(task.active_execution_id!,2,'execution.progress'),payload:{text:'Goal set',session_goal:{objective,status:'active'}}};
  await store.acceptEvent(a.installation_id,started,delivery,connection);
  await store.acceptEvent(a.installation_id,progress,delivery,connection);
  await store.acceptEvent(a.installation_id,progress,delivery,connection);
  assert.deepEqual((await sessions.read(a.owner_id,one.id)).session_goal,progress.payload.session_goal);
  assert.equal((await sessions.read(a.owner_id,other.id)).session_goal,null);
  await sessions.control(a.owner_id,one.id,'stop');
  assert.equal((await sessions.read(a.owner_id,one.id)).session_goal?.status,'blocked');
});

test('sidebar moves and archives are personal, reversible, and check both session permissions', async () => {
  const a = await fixture(), foreign = await fixture();
  const first = await session(a,'First'), second = await session(a,'Second'), third = await session(a,'Third');
  const path = `/workspaces/${a.workspace_id}/agent-sessions`;
  const rows = async (token=a.owner_token,query='') => (await api(token,'GET',path+query)).items.map((item:{id:string}) => item.id);
  const patch = (id:string,body:object,status=200) => api(a.owner_token,'PATCH',`/agent-sessions/${id}/sidebar`,body,status);
  await patch(first.id,{target:third.id,side:'before'});
  assert.deepEqual(await rows(),[first.id,third.id,second.id]);
  await patch(second.id,{target:first.id,side:'after'});
  assert.deepEqual(await rows(),[first.id,second.id,third.id]);
  assert.deepEqual(await rows(a.owner_token,'?before='+first.id),[second.id,third.id]);
  assert.deepEqual(await rows(a.collaborator_token),[third.id,second.id,first.id]);
  const stars = `/workspaces/${a.workspace_id}/hub/starred-sessions`;
  await api(a.owner_token,'POST',stars+'/'+second.id,{active:true});
  await Promise.all([patch(second.id,{archived:true}),patch(second.id,{archived:true})]);
  assert.deepEqual(await rows(),[first.id,third.id]);
  assert.deepEqual(await rows(a.owner_token,'?archived=true'),[second.id]);
  assert.deepEqual((await api(a.owner_token,'GET',stars)).items,[]);
  assert.deepEqual(await rows(a.collaborator_token,'?archived=true'),[]);
  await patch(first.id,{target:second.id,side:'before'},409);
  await patch(second.id,{archived:false});
  assert.deepEqual(await rows(),[first.id,second.id,third.id]);
  assert.equal((await api(a.owner_token,'GET',stars)).items[0].id,second.id);
  await Promise.all([
    patch(first.id,{target:third.id,side:'after'}),
    patch(second.id,{target:third.id,side:'after'}),
  ]);
  const concurrent = await rows();
  assert.equal(concurrent[0],third.id);
  assert.deepEqual(new Set(concurrent),new Set([first.id,second.id,third.id]));
  assert.deepEqual(await rows(a.owner_token,'?before='+concurrent[1]),[concurrent[2]]);
  const other = await session(foreign);
  await patch(first.id,{target:other.id,side:'after'},404);
  await patch(other.id,{archived:true},404);
});

test('session-only reviewer can discuss an explicit output snapshot without gaining source or execution access', async () => {
  const a=await fixture(), stranger=await fixture();
  const sessionId=(await session(a)).id;
  const url='/agent-sessions/'+sessionId, team=url+'/team', token=a.collaborator_token;
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[a.channel_id,a.collaborator_id]);
  const invite=(user:string)=>app.inject({method:'PUT',url:'/v1'+team+'/reviewers/'+user,headers:{authorization:'Bearer '+a.owner_token},payload:{}});
  const patch={path:'app.ts',patch:'@@ -1 +1 @@\n-old\n+new'};
  const file={path:'internal.txt',content:'private data'};
  const canvas = {key:'release',name:'Release notes',type:'canvas',content:'# Release preview'};
  const sourceContext = {repository:{label:'Source members only'}};
  await pool.query('UPDATE agent_sessions SET outputs=$1 WHERE id=$2',[{files:[file],changes:[patch],views:[canvas],context:sourceContext},sessionId]);
  const shareView = (output:unknown) => app.inject({method:'PUT',url:'/v1'+team+'/shared',headers:{authorization:'Bearer '+a.owner_token},payload:{kind:'view',path:canvas.key,output}});
  const share=(actor:string,output:unknown)=>app.inject({method:'PUT',url:'/v1'+team+'/shared',headers:{authorization:'Bearer '+actor},payload:{kind:'change',path:patch.path,output}});
  await api(token,'GET',team,undefined,404);
  assert.equal((await invite(stranger.owner_id)).statusCode,404);
  assert.equal((await invite(a.collaborator_id)).statusCode,200);
  const viewerSocket=io(origin,{transports:['websocket'],auth:{token},autoConnect:false,reconnection:false});
  sockets.push(viewerSocket);
  viewerSocket.on('updates.changed',(_notice,ack:()=>void)=>ack());
  const connected=new Promise<void>((resolve,reject)=>{viewerSocket.once('connect',resolve);viewerSocket.once('connect_error',reject);});
  viewerSocket.connect(); await connected;
  const sub={scope:'session-team',id:sessionId};
  const subscribe=()=>viewerSocket.timeout(2500).emitWithAck('updates.subscribe',sub);
  assert.deepEqual((await subscribe()).data,sub);
  assert.ok((await viewerSocket.timeout(2500).emitWithAck('updates.subscribe',{scope:'thread',id:a.thread_id})).error);
  let view=await api(token,'GET',team);
  assert.equal(view.can_manage,false);
  assert.deepEqual(view.shared,[]);
  assert.equal(view.origin_thread_id,undefined);
  await api(token,'GET',url,undefined,404);
  await api(token,'POST',url+'/messages',{text:'Run a command'},404);
  assert.equal((await share(token,patch)).statusCode,403);
  assert.equal((await share(a.owner_token,{...patch,patch:'wrong version'})).statusCode,409);
  assert.equal((await share(a.owner_token,patch)).statusCode,200);
  assert.equal((await shareView({...canvas,content:'stale'})).statusCode,409);
  assert.equal((await shareView(canvas)).statusCode,200);
  await pool.query('UPDATE agent_sessions SET outputs=$1 WHERE id=$2',[{files:[file],changes:[{...patch,patch:'different'}]},sessionId]);
  view=await api(token,'GET',team);
  assert.deepEqual(view.shared,[{kind:'change',path:patch.path,output:patch},{kind:'view',path:canvas.key,output:canvas}]);
  assert.ok(!JSON.stringify(view).includes(sourceContext.repository.label));
  assert.equal((await shareView(null)).statusCode,200);
  assert.ok(!JSON.stringify(view).includes(file.content));
  const key=randomUUID();
  const posts=Array.from({length:4},()=>api(token,'POST',team+'/discussion',{text:'Please review this line'},200,key));
  await Promise.all(posts);
  await api(token,'POST',team+'/discussion',{text:'Different text'},409,key);
  assert.equal((await api(a.owner_token,'GET',team)).messages.length,1);
  assert.equal((await pool.query('SELECT id FROM tasks WHERE session_id=$1',[sessionId])).rowCount,0);
  assert.equal((await share(a.owner_token,null)).statusCode,200);
  assert.deepEqual((await api(token,'GET',team)).shared,[]);
  const revoked=new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('missing review access revocation')),8000);
    viewerSocket.once('updates.revoked', (notice:{scope:string;id:string})=>{
      clearTimeout(timer);
      if(notice.scope===sub.scope && notice.id===sessionId) resolve();
      else reject(new Error('wrong revoked subscription'));
    });
  });
  const removed=await app.inject({method:'DELETE',url:'/v1'+team+'/reviewers/'+a.collaborator_id,headers:{authorization:'Bearer '+a.owner_token}});
  assert.equal(removed.statusCode,200);
  await revoked;
  assert.equal((await subscribe()).error,'not_found');
  viewerSocket.disconnect();

  await api(token,'GET',team,undefined,404);
  await api(token,'POST',team+'/discussion',{text:'After revocation'},404);
  const visibility=(actor:string,value:boolean)=>app.inject({method:'PUT',url:'/v1'+team+'/visibility',headers:{authorization:'Bearer '+actor},payload:{workspace_visible:value}});
  assert.equal((await visibility(a.owner_token,true)).statusCode,200);
  assert.equal((await api(token,'GET',team)).workspace_visible,true);
  await api(token,'GET',url,undefined,404);
  await api(stranger.owner_token,'GET',team,undefined,404);
  assert.equal((await visibility(token,false)).statusCode,403);
  assert.equal((await visibility(a.owner_token,false)).statusCode,200);
  await api(token,'GET',team,undefined,404);
  assert.equal((await invite(a.collaborator_id)).statusCode,200);
  await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[a.workspace_id,a.collaborator_id]);
  await pool.query('UPDATE workspace_members SET active=true WHERE workspace_id=$1 AND user_id=$2',[a.workspace_id,a.collaborator_id]);
  await api(token,'GET',team,undefined,404);
  await api(a.owner_token,'POST',url+'/end',{});
  await api(a.owner_token,'POST',team+'/discussion',{text:'After closing'},409);
  assert.equal((await api(a.owner_token,'GET',team)).writable,false);
});

test('creating a fresh code channel is atomic and retriable without posting a source message', async()=>{
  const a=await fixture(), b=await fixture(), start='/channels/'+a.channel_id+'/agent-sessions';
  const input={client_thread_id:randomUUID(), client_session_id:randomUUID(),installation_id:a.installation_id,title:'Checkout repair'};
  await api(b.owner_token,'POST',start,input,404);
  await Promise.all(Array.from({length:3},()=>api(a.owner_token,'POST',start,input,201)));
  const detail = await api(a.owner_token,'GET','/agent-sessions/'+input.client_session_id);
  assert.equal(detail.session.origin_thread_id,input.client_thread_id);
  assert.equal(detail.session.title,input.title);
  assert.equal(detail.turns.length,0);
  assert.equal((await pool.query('SELECT id FROM messages WHERE thread_id=$1',[input.client_thread_id])).rowCount,0);
  await api(a.owner_token,'POST',start,{...input,title:'different request'},409);
  const wrong={...input,client_session_id:randomUUID(),client_thread_id:randomUUID(),installation_id:b.installation_id};
  await api(a.owner_token,'POST',start,wrong,404);
  assert.equal((await pool.query('SELECT id FROM threads WHERE id=$1',[wrong.client_thread_id])).rowCount,0);
});
