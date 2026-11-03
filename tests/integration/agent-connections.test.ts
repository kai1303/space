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
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, realtime: { reconcileMs: 50 } });
let origin = '';
const sockets: Socket[] = [];
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); await migrate(pool); origin = await app.listen({ host: '127.0.0.1', port: 0 }); });
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
  await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2', [owner.workspace_id, owner.owner_id]);
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
  const stale = await socket.timeout(2000).emitWithAck('agent.heartbeat', { auth_status: 'ready' });
  assert.equal(stale.error, 'unauthorized');
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
  await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2', [owner.workspace_id, owner.owner_id]);
  assert.equal((await socket.timeout(2000).emitWithAck('agent.heartbeat', { auth_status: 'ready' })).error, 'unauthorized');
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
