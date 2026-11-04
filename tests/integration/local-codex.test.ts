import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { io, type Socket } from 'socket.io-client';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const schema = `local_codex_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
const store = new PostgresStore(pool);
const app = createApi(store, { allowDevelopmentTokens: true, realtime: { } });
let origin = '';
const sockets: Socket[] = [];
const available = new WeakSet<Socket>();
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); origin = await app.listen({ host: '127.0.0.1', port: 0 }); });
after(async () => { sockets.forEach(socket => socket.disconnect()); await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
async function api(token: string | undefined, method: 'GET' | 'POST', path: string, payload?: object, status = 200) {
  const response = await app.inject({ method, url: `/v1${path}`, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload ? { payload } : {}) });
  assert.equal(response.statusCode, status, response.body);
  return response.json();
}
async function fixture() {
  const seed = await bootstrap(pool);
  const pairing = await api(seed.owner_token, 'POST', `/workspaces/${seed.workspace_id}/agent-pairings`, {}, 201);
  const credential = randomBytes(32).toString('base64url');
  const { installation_id } = await api(undefined, 'POST', '/agent-pairings/claim', { code: pairing.code, credential }, 201);
  const grantPath = `/agents/connections/${installation_id}/channels/${seed.channel_id}`;
  return { ...seed, installation_id, credential, grantPath };
}
async function connect(credential: string) {
  const socket = io(`${origin}/agents`, { transports: ['websocket'], auth: { token: credential }, autoConnect: false, reconnection: false });
  sockets.push(socket);
  const ready = new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  socket.on('agent.tasks.available', () => { available.add(socket); });
  socket.connect(); await ready;
  return socket;
}
const command = (socket: Socket, name: string, body: object = {}): Promise<any> => socket.timeout(2000).emitWithAck(name, body);
async function claimReady(socket: Socket) {
  if (!available.has(socket)) await new Promise<void>((resolve,reject) => {
    const timer = setTimeout(() => { socket.off('agent.tasks.available',done); reject(new Error('missing durable task notification')); },5000);
    const done = () => { clearTimeout(timer); resolve(); };
    socket.once('agent.tasks.available',done);
  });
  available.delete(socket);
  return command(socket,'agent.task.claim');
}
async function queued(seed: Awaited<ReturnType<typeof fixture>>, approve = true) {
  await api(seed.owner_token, 'POST', seed.grantPath, { enabled: true });
  const task = await store.createTask(seed.owner_id, { workspace_id: seed.workspace_id, thread_id: seed.thread_id, installation_id: seed.installation_id, skill: 'codex.run', goal: 'Say hello' }, randomUUID());
  if (approve) await store.approveTask(seed.owner_id, task.id);
  return task;
}
function event(execution_id: string, sequence: number, type = 'execution.started') {
  return { id: randomUUID(), schema_version: '1.0', execution_id, sequence, type, occurred_at: new Date().toISOString(), payload: { text: type === 'execution.completed' ? 'Hello from Codex' : 'Working', response: { messages: type === 'execution.completed' ? [{ id: 'reply', text: 'Hello from Codex', status: 'complete' }] : [], tools: [], components: [] } } };
}

test('paired Codex advertises execution but requires an explicit owner channel grant', async () => {
  const seed = await fixture(), foreign = await fixture();
  const installations = await api(seed.owner_token, 'GET', `/agents/installations?workspace_id=${seed.workspace_id}`);
  assert.deepEqual(installations.find((a: any) => a.id === seed.installation_id).capabilities.skills, ['codex.run']);
  const path = `/channels/${seed.channel_id}/local-codex`;
  const [agent] = await api(seed.owner_token, 'GET', path);
  assert.equal(agent.enabled_in_channel, false);
  assert.deepEqual(await api(seed.collaborator_token, 'GET', path), []);
  await api(foreign.owner_token, 'GET', path, undefined, 404);
  await assert.rejects(store.createTask(seed.owner_id, { workspace_id: seed.workspace_id, thread_id: seed.thread_id, installation_id: seed.installation_id, skill: 'codex.run', goal: 'hello' }, randomUUID()), /installation_not_authorized/);
  await api(seed.collaborator_token, 'POST', seed.grantPath, { enabled: true }, 403);
  await api(seed.owner_token, 'POST', seed.grantPath, { enabled: true, arbitrary: true }, 400);
  await api(seed.owner_token, 'POST', seed.grantPath, { enabled: true });
  await api(seed.owner_token, 'POST', seed.grantPath, { enabled: true });
  assert.equal((await api(seed.owner_token, 'GET', path))[0].enabled_in_channel, true);
  assert.equal((await pool.query('SELECT count(*) FROM agent_grants WHERE installation_id=$1', [seed.installation_id])).rows[0].count, '1');
  await api(seed.owner_token, 'POST', seed.grantPath, { enabled: false });
  assert.equal((await api(seed.owner_token, 'GET', path))[0].enabled_in_channel, false);
});

test('only the ready connector can claim approved local work and stream a persisted reply', async () => {
  const seed = await fixture(), other = await fixture();
  const task = await queued(seed, false);
  const socket = await connect(seed.credential), foreign = await connect(other.credential);
  assert.equal((await command(socket, 'agent.task.claim')).error, 'agent_not_ready');
  await command(socket, 'agent.heartbeat', { auth_status: 'ready' });
  await command(foreign, 'agent.heartbeat', { auth_status: 'ready' });
  assert.equal((await command(socket, 'agent.task.claim')).data, null);
  await store.approveTask(seed.owner_id, task.id);
  assert.equal(await store.claimDelivery(), null, 'ordinary worker must not take a local job');
  assert.equal((await command(foreign, 'agent.task.claim')).data, null);
  const { data: request } = await claimReady(socket);
  assert.equal(request.task_id, task.id);
  assert.equal(request.skill, 'codex.run');
  assert.equal((await command(socket, 'agent.task.claim')).error, 'agent_busy');
  assert.equal((await command(socket, 'agent.task.event', { event: event(randomUUID(), 1) })).error, 'stale_execution');
  const started = event(request.execution_id, 1);
  assert.equal((await command(socket, 'agent.task.event', { event: started })).data, true);
  assert.equal((await command(socket, 'agent.task.event', { event: started })).data, true);
  assert.equal((await command(socket, 'agent.task.renew')).data, true);
  assert.equal((await command(socket, 'agent.task.finish')).error, 'missing_terminal_event');
  assert.equal((await command(socket, 'agent.task.event', { event: event(request.execution_id, 2, 'execution.completed') })).data, true);
  assert.equal((await command(socket, 'agent.task.finish')).data, true);
  assert.equal((await store.readTask(seed.owner_id, task.id)).result, 'Hello from Codex');
  const messages = await pool.query('SELECT text,agent_response FROM messages WHERE task_id=$1', [task.id]);
  assert.equal(messages.rowCount, 1);
  assert.equal(messages.rows[0].agent_response.messages[0].text, 'Hello from Codex');
  assert.equal((await command(socket, 'agent.task.claim')).data, null);
});

test('expired local leases reject writes and fail visibly without invoking the same execution again', async () => {
  const seed = await fixture(), task = await queued(seed);
  const socket = await connect(seed.credential);
  await command(socket, 'agent.heartbeat', { auth_status: 'ready' });
  const { data: request } = await claimReady(socket);
  await command(socket, 'agent.task.event', { event: event(request.execution_id, 1) });
  await pool.query("UPDATE outbox SET lease_until=now()-interval '1 second' WHERE task_id=$1", [task.id]);
  assert.equal((await command(socket, 'agent.task.event', { event: event(request.execution_id, 2, 'execution.completed') })).error, 'stale_lease');
  // A replacement cannot claim this attempt; its durable deadline settles it asynchronously.
  const replacement = await connect(seed.credential);
  await command(replacement, 'agent.heartbeat', { auth_status: 'ready' });
  assert.equal((await command(replacement, 'agent.task.claim')).data, null);
  const until = Date.now()+5000;
  while ((await store.readTask(seed.owner_id,task.id)).status !== 'failed' && Date.now()<until) await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal((await store.readTask(seed.owner_id, task.id)).status, 'failed');
  assert.equal((await pool.query('SELECT 1 FROM messages WHERE task_id=$1', [task.id])).rowCount, 0);
});

test('replacement sockets and revoked grants cannot publish results or renew work', async () => {
  const seed = await fixture(), task = await queued(seed);
  const socket = await connect(seed.credential);
  await command(socket, 'agent.heartbeat', { auth_status: 'ready' });
  const { data: request } = await claimReady(socket);
  await command(socket, 'agent.task.event', { event: event(request.execution_id, 1) });
  const replacement = await connect(seed.credential);
  if (socket.connected) {
    const denied = await command(socket, 'agent.task.event', {event:event(request.execution_id,2,'execution.completed')}).catch((error: Error) => {
      assert.match(error.message,/disconnected/); assert.equal(socket.connected,false); return {error:'unauthorized'};
    });
    assert.equal(denied.error,'unauthorized');
  }
  await command(replacement, 'agent.heartbeat', { auth_status: 'ready' });
  await api(seed.owner_token, 'POST', seed.grantPath, { enabled: false });
  assert.notEqual((await command(replacement, 'agent.task.claim')).data?.task_id, task.id);
  assert.notEqual((await store.readTask(seed.owner_id, task.id)).status, 'completed');
});

test('disconnect fails an active local execution and retains its partial response', async () => {
  const seed = await fixture(), task = await queued(seed);
  const socket = await connect(seed.credential);
  await command(socket, 'agent.heartbeat', { auth_status: 'ready' });
  const { data: request } = await claimReady(socket);
  const started = event(request.execution_id, 1);
  started.payload.response.messages = [{ id: 'partial', text: 'Partial answer', status: 'streaming' }];
  await command(socket, 'agent.task.event', { event: started });
  socket.disconnect();
  const until = Date.now() + 2000;
  while ((await store.readTask(seed.owner_id, task.id)).status !== 'failed' && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await store.readTask(seed.owner_id, task.id)).status, 'failed');
  const response = (await store.events(seed.owner_id, task.id, 0)).at(-1)?.payload.response as { messages: { text: string }[] };
  assert.equal(response.messages[0]?.text, 'Partial answer');
});

test('revoking channel access fences the current connector before renewal or result persistence', async () => {
  const seed = await fixture(), task = await queued(seed);
  const socket = await connect(seed.credential);
  await command(socket, 'agent.heartbeat', { auth_status: 'ready' });
  const { data: request } = await claimReady(socket);
  await command(socket, 'agent.task.event', { event: event(request.execution_id, 1) });
  await api(seed.owner_token, 'POST', seed.grantPath, { enabled: false });
  assert.equal((await command(socket, 'agent.task.renew')).error, 'installation_not_authorized');
  assert.equal((await command(socket, 'agent.task.event', { event: event(request.execution_id, 2, 'execution.completed') })).error, 'installation_not_authorized');
  assert.equal((await command(socket, 'agent.task.fail')).data, true);
  assert.equal((await store.readTask(seed.owner_id, task.id)).status, 'failed');
  assert.equal((await pool.query('SELECT 1 FROM messages WHERE task_id=$1', [task.id])).rowCount, 0);
});

test('targeted deadline fails an expired local delivery without taking another worker job', async () => {
  const seed = await fixture(), task = await queued(seed);
  const socket = await connect(seed.credential);
  await command(socket, 'agent.heartbeat', { auth_status: 'ready' });
  const { data: request } = await claimReady(socket);
  await command(socket, 'agent.task.event', { event: event(request.execution_id, 1) });
  await pool.query("UPDATE outbox SET lease_until=now()-interval '1 second' WHERE task_id=$1", [task.id]);
  const attempt = (await pool.query('SELECT id,lease_token FROM outbox WHERE task_id=$1',[task.id])).rows[0];
  await store.expireDelivery(attempt.id,attempt.lease_token);
  assert.equal((await store.readTask(seed.owner_id, task.id)).status, 'failed');
  assert.equal((await pool.query('SELECT last_error FROM outbox WHERE task_id=$1', [task.id])).rows[0].last_error, 'execution_interrupted');
});

test('queued work wakes the ready connector without a recurring task claim', async () => {
  const seed = await fixture(), socket = await connect(seed.credential);
  await command(socket, 'agent.heartbeat', { auth_status: 'ready' });
  let available = 0;
  socket.on('agent.tasks.available', () => { available++; });
  const task = await queued(seed);
  const deadline = Date.now() + 2000;
  while (!available && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(available > 0, 'durable task creation must wake the connector');
  assert.equal((await claimReady(socket)).data.task_id, task.id);
});

test('idle ready connectors do not periodically query the task queue',async()=>{
  const seed=await fixture(),socket=await connect(seed.credential);
  await command(socket,'agent.heartbeat',{auth_status:'ready'});
  await new Promise(resolve=>setTimeout(resolve,150));
  const original=pool.query;
  let queueReads=0;
  try {
    pool.query=(function(...args:any[]){
      const query=typeof args[0]==='string'?args[0]:args[0]?.text ?? '';
      if (/\b(?:FROM|UPDATE)\s+"?outbox"?\b/i.test(query)) queueReads++;
      return (original as any).apply(pool,args);
    }) as typeof pool.query;
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.equal(queueReads,0,'a ready connector must wait for targeted broker delivery');
  } finally {pool.query=original;socket.disconnect();}
});
