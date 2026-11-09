import { observeOutbox } from '../fixtures/observe-outbox.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { io, type Socket } from 'socket.io-client';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const schema = `connections_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, realtime: { } });
let origin = '';
const sockets: Socket[] = [];
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); await migrate(pool); await observeOutbox(pool); origin = await app.listen({ host: '127.0.0.1', port: 0 }); });
after(async () => { sockets.forEach(s => s.disconnect()); await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
async function api(token: string | undefined, method: 'GET' | 'POST', path: string, payload?: object, status = 200) {
  const response = await app.inject({ method, url: `/v1${path}`, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload ? { payload } : {}) });
  assert.equal(response.statusCode, status, response.body);
  return response.json();
}
async function pair(owner: Awaited<ReturnType<typeof bootstrap>>) {
  const pairing = await api(owner.owner_token, 'POST', `/workspaces/${owner.workspace_id}/agent-pairings`, {}, 201);
  const credential = randomBytes(32).toString('base64url');
  const connection = await api(undefined, 'POST', '/agent-pairings/claim', { code: pairing.code, credential }, 201);
  return { pairing, credential, connection };
}
async function offboardOwner(owner: Awaited<ReturnType<typeof bootstrap>>) {
  await pool.query("UPDATE workspace_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2", [owner.workspace_id, owner.collaborator_id]);
  await pool.query('UPDATE workspaces SET primary_owner_id=$2 WHERE id=$1', [owner.workspace_id, owner.collaborator_id]);
  await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2', [owner.workspace_id, owner.owner_id]);
}
async function connect(credential: string, namespace = '/agents') {
  const socket = io(`${origin}${namespace}`, { transports: ['websocket'], auth: { token: credential }, autoConnect: false, reconnection: false });
  sockets.push(socket);
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timed out')), 3000);
    socket.once('connect', () => { clearTimeout(timeout); resolve(); });
    socket.once('connect_error', e => { clearTimeout(timeout); reject(e); });
  });
  socket.connect(); await ready; return socket;
}
test('pairing enrolls an agent beside human members without channels, grants or human credentials', async () => {
  const owner = await bootstrap(pool), foreign = await bootstrap(pool);
  await api(foreign.owner_token, 'POST', `/workspaces/${owner.workspace_id}/agent-pairings`, {}, 404);
  await api(undefined, 'POST', `/workspaces/${owner.workspace_id}/agent-pairings`, {}, 401);
  const { pairing, credential, connection } = await pair(owner);
  assert.match(pairing.code, /^[\w-]{32}$/);
  const retry = await api(undefined, 'POST', '/agent-pairings/claim', { code: pairing.code, credential }, 201);
  assert.deepEqual(retry, connection);
  await api(undefined, 'POST', '/agent-pairings/claim', { code: pairing.code, credential: randomBytes(32).toString('base64url') }, 401);
  const directory = await api(owner.collaborator_token, 'GET', `/workspaces/${owner.workspace_id}/participants`);
  assert.ok(directory.items.some((p: any) => p.kind === 'human' && p.id === owner.owner_id));
  const member = directory.items.find((p: any) => p.id === connection.installation_id);
  assert.equal(member.kind, 'agent'); assert.equal(member.status, 'offline'); assert.equal(member.owner_id, owner.owner_id);
  assert.equal((await pool.query('SELECT * FROM agent_grants WHERE installation_id=$1', [connection.installation_id])).rowCount, 0);
  const rows = await pool.query('SELECT * FROM agent_connections WHERE installation_id=$1', [connection.installation_id]);
  assert.ok(!JSON.stringify(rows.rows).includes(credential));
  assert.ok(!JSON.stringify((await pool.query('SELECT * FROM agent_pairings WHERE id=$1', [pairing.id])).rows).includes(pairing.code));
  await api(credential, 'GET', '/me', undefined, 401);
  await api(foreign.owner_token, 'GET', `/workspaces/${owner.workspace_id}/participants`, undefined, 404);
});
test('pairing expiry, cancellation, replacement and owner offboarding prevent claim', async () => {
  const owner = await bootstrap(pool);
  const create = () => api(owner.owner_token, 'POST', `/workspaces/${owner.workspace_id}/agent-pairings`, {}, 201);
  const claim = (code: string) => api(undefined, 'POST', '/agent-pairings/claim', { code, credential: randomBytes(32).toString('base64url') }, 401);
  const expired = await create(); await pool.query("UPDATE agent_pairings SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.id]); await claim(expired.code);
  const cancelled = await create(); await api(owner.collaborator_token, 'POST', `/agent-pairings/${cancelled.id}/cancel`, {}, 403); await api(owner.owner_token, 'POST', `/agent-pairings/${cancelled.id}/cancel`, {}); await claim(cancelled.code);
  const old = await create(); const fresh = await create(); await claim(old.code);
  await offboardOwner(owner);
  await claim(fresh.code);
});
test('agent namespace reports auth status, fences replaced connections and enforces revocation', async () => {
  const owner = await bootstrap(pool); const { credential, connection } = await pair(owner);
  const socket = await connect(credential);
  assert.ok((await socket.timeout(2000).emitWithAck('agent.heartbeat', { auth_status: 'ready' })).data);
  let list = await api(owner.owner_token, 'GET', `/workspaces/${owner.workspace_id}/participants`);
  assert.equal(list.items.find((p: any) => p.id === connection.installation_id).status, 'online');
  assert.equal((await socket.timeout(2000).emitWithAck('agent.heartbeat', { auth_status: 'ready', access_token: 'must-not-accept' })).error, 'unknown_field');
  const replacement = await connect(credential);
  if (socket.connected) {
    const stale = await socket.timeout(2000).emitWithAck('agent.heartbeat', { auth_status: 'ready' }).catch((error: Error) => {
      assert.match(error.message,/disconnected/); assert.equal(socket.connected,false); return {error:'unauthorized'};
    });
    assert.equal(stale.error, 'unauthorized');
  }
  assert.ok((await replacement.timeout(2000).emitWithAck('agent.heartbeat', { auth_status: 'required' })).data);
  list = await api(owner.owner_token, 'GET', `/workspaces/${owner.workspace_id}/participants`);
  assert.equal(list.items.find((p: any) => p.id === connection.installation_id).status, 'auth_required');
  await api(owner.collaborator_token, 'POST', `/agents/connections/${connection.installation_id}/revoke`, {}, 403);
  await api(owner.owner_token, 'POST', `/agents/connections/${connection.installation_id}/revoke`, {});
  await assert.rejects(connect(credential), /unauthorized/);
  await assert.rejects(connect(credential, ''), /unauthorized/);
});
test('agent heartbeat rechecks workspace membership after connection', async () => {
  const owner = await bootstrap(pool); const { credential } = await pair(owner); const socket = await connect(credential);
  await offboardOwner(owner);
  if (socket.connected) {
    const ack = await socket.timeout(2000).emitWithAck('agent.heartbeat', { auth_status: 'ready' }).catch((error: Error) => {
      assert.match(error.message, /disconnected/); assert.equal(socket.connected, false); return { error: 'unauthorized' };
    });
    assert.equal(ack.error, 'unauthorized');
  }
  await assert.rejects(connect(credential), /unauthorized/);
});
test('concurrent claims create one installation and closed or stale connections cannot remain online', async () => {
  const owner = await bootstrap(pool);
  const pairing = await api(owner.owner_token, 'POST', `/workspaces/${owner.workspace_id}/agent-pairings`, {}, 201);
  const credential = randomBytes(32).toString('base64url');
  const claims = await Promise.all([1,2,3].map(() => api(undefined, 'POST', '/agent-pairings/claim', { code: pairing.code, credential }, 201)));
  assert.equal(new Set(claims.map(c => c.installation_id)).size, 1);
  const socket = await connect(credential);
  await socket.timeout(2000).emitWithAck('agent.heartbeat', { auth_status: 'ready' });
  await pool.query("UPDATE agent_connections SET last_seen_at=now()-interval '46 seconds' WHERE installation_id=$1", [claims[0].installation_id]);
  const list = await api(owner.owner_token, 'GET', `/workspaces/${owner.workspace_id}/participants`);
  assert.equal(list.items.find((p: any) => p.id === claims[0].installation_id).status, 'offline');
  await api(owner.owner_token, 'POST', `/agents/connections/${claims[0].installation_id}/revoke`, {});
  await api(undefined, 'POST', '/agent-pairings/claim', { code: pairing.code, credential }, 401);
});

test('a missing heartbeat disconnects stale agents and commits an offline participant update', {timeout:14000}, async () => {
  const owner=await bootstrap(pool), paired=await pair(owner), socket=await connect(paired.credential);
  await socket.timeout(1000).emitWithAck('agent.heartbeat',{auth_status:'ready'});
  await pool.query("UPDATE agent_connections SET last_seen_at=now()-interval '46 seconds' WHERE installation_id=$1",[paired.connection.installation_id]);
  const deadline=Date.now()+12000;
  while (socket.connected && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(socket.connected,false,'expired agent heartbeat must disconnect its socket');
  const row=(await pool.query('SELECT connection_id FROM agent_connections WHERE installation_id=$1',[paired.connection.installation_id])).rows[0];
  assert.equal(row.connection_id,null,'offline transition must be committed for the participant subscription');
});

for (const provider of ['kiro', 'claude'] as const) test(`${provider} enrollment binds the provider, grants its own skill and delivers only to its local connector`, async () => {
  const owner = await bootstrap(pool);
  const pairing = await api(owner.owner_token, 'POST', `/workspaces/${owner.workspace_id}/agent-pairings`, { provider }, 201);
  const credential = randomBytes(32).toString('base64url');
  await api(undefined, 'POST', '/agent-pairings/claim', { code: pairing.code, credential, provider: 'codex' }, 409);
  await api(undefined, 'POST', '/agent-pairings/claim', { code: pairing.code, credential }, 409);
  const claims = await Promise.all([1, 2, 3].map(() => api(undefined, 'POST', '/agent-pairings/claim', { code: pairing.code, credential, provider }, 201)));
  assert.equal(new Set(claims.map(c => c.installation_id)).size, 1);
  const connection = claims[0];
  assert.equal(connection.provider, provider);
  const row = (await pool.query('SELECT i.connector_id,d.capabilities FROM agent_installations i JOIN agent_definitions d ON d.id=i.definition_id WHERE i.id=$1', [connection.installation_id])).rows[0];
  assert.equal(row.connector_id, `${provider}.local`); assert.deepEqual(row.capabilities.skills, [`${provider}.run`]);
  const path = `/agents/connections/${connection.installation_id}/channels/${owner.channel_id}`;
  await api(owner.collaborator_token, 'POST', path, { enabled: true }, 403);
  await api(owner.owner_token, 'POST', path, { enabled: true });
  const agents = await api(owner.owner_token, 'GET', `/channels/${owner.channel_id}/local-agents`);
  assert.ok(agents.some((a: any) => a.id === connection.installation_id && a.enabled_in_channel && a.provider === provider));
  const store = new PostgresStore(pool);
  const task = await store.createTask(owner.owner_id, { workspace_id: owner.workspace_id, thread_id: owner.thread_id, installation_id: connection.installation_id, skill: `${provider}.run`, goal: `Hello from ${provider}` }, randomBytes(16).toString('hex'));
  await store.approveTask(owner.owner_id, task.id);
  const events = await pool.query("SELECT kind FROM observed_outbox WHERE payload->>'task_id'=$1 AND kind LIKE 'task.%'", [task.id]);
  assert.deepEqual(events.rows.map(r => r.kind), ['task.local.ready']);
  assert.equal(await store.claimDelivery(), null);
  assert.ok(await store.claimDelivery(connection.installation_id));
});

for (const provider of ['kiro', 'claude'] as const) test(`${provider} mentions start managed sessions, stream over the socket, resume and stop`, { timeout: 12000 }, async () => {
  const { ChatStore } = await import('@space/postgres/chat');
  const { NavigatorStore } = await import('@space/postgres/navigator');
  const { AgentSessionStore } = await import('@space/postgres/agent-sessions');
  const { randomUUID } = await import('node:crypto');
  const owner = await bootstrap(pool);
  const pairing = await api(owner.owner_token, 'POST', `/workspaces/${owner.workspace_id}/agent-pairings`, { provider }, 201);
  const credential = randomBytes(32).toString('base64url');
  const connection = await api(undefined, 'POST', '/agent-pairings/claim', { code: pairing.code, credential, provider }, 201);
  await api(owner.owner_token, 'POST', `/agents/connections/${connection.installation_id}/channels/${owner.channel_id}`, { enabled: true });
  const socket = await connect(credential), sessions = new AgentSessionStore(pool);
  const command = (name: string, payload: object = {}) => socket.timeout(3000).emitWithAck(name, payload);
  const available = () => new Promise<void>(resolve => socket.once('agent.tasks.available', () => resolve()));
  await command('agent.heartbeat', { auth_status: 'ready' });
  const first = available();
  await new ChatStore(pool).send(owner.owner_id, owner.channel_id, { client_message_id: randomUUID(), thread_id: owner.thread_id, text: `@agent-${connection.installation_id} Remember the project is Aurora` });
  await pool.query("UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1", [owner.thread_id]);
  await new NavigatorStore(pool).processOne();
  await first;
  const { data: request } = await command('agent.task.claim');
  assert.equal(request.skill, `${provider}.run`);assert.deepEqual(request.persistent_session, { resume: false });
  const list = await sessions.list(owner.owner_id, owner.thread_id);
  assert.equal(list.items.length, 1);assert.equal(list.items[0]!.skill, `${provider}.run`);
  for (const [sequence, type, payload] of [[1, 'execution.started', { text: 'Working' }], [2, 'execution.progress', { text: 'Ready', session_ready: true }], [3, 'execution.completed', { text: 'Aurora remembered' }]] as const) {
    assert.equal((await command('agent.task.event', { event: { id: randomUUID(), schema_version: '1.0', execution_id: request.execution_id, sequence, type, occurred_at: new Date().toISOString(), payload } })).data, true);
  }
  assert.equal((await command('agent.task.finish')).data, true);
  const second = available();
  await sessions.send(owner.owner_id, request.session_id, { text: 'What is the project name?' }, randomUUID());
  await second;
  assert.deepEqual((await command('agent.task.claim')).data.persistent_session, { resume: true });
  await sessions.control(owner.owner_id, request.session_id, 'stop');
  assert.equal((await command('agent.task.renew')).error, 'agent_session_stopped');
});
