import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import Fastify from 'fastify';
import { AppError } from '@space/contracts';
import { WorkspaceStore } from '@space/postgres/workspace';
import { AgentConnectionStore } from '@space/postgres/agent-connections';
import { registerWorkspaceRoutes } from '../../apps/server/dist/workspace.js';
import { registerAgentConnectionRoutes } from '../../apps/server/dist/agent-connections.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const schema = `member_profiles_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
const app = Fastify(), store = new PostgresStore(pool);
app.decorateRequest('actorId', '');
app.addHook('onRequest', async request => {
  if (request.routeOptions.url !== '/v1/agent-pairings/claim') request.actorId = await store.authenticate(request.headers.authorization?.slice(7) ?? '');
});
app.setErrorHandler((error, _request, reply) => reply.code(error instanceof AppError ? error.status : 500).send({error:error instanceof AppError ? error.code : 'internal_error'}));
registerWorkspaceRoutes(app, new WorkspaceStore(pool));
registerAgentConnectionRoutes(app, new AgentConnectionStore(pool));
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
async function profile(token: string, workspace: string, kind: string, id: string, status = 200) {
  const result = await app.inject({ method: 'GET', url: `/v1/workspaces/${workspace}/profiles/${kind}/${id}`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(result.statusCode, status, result.body);
  return result.json();
}

test('person profiles expose current public fields only and expire statuses', async () => {
  const a = await bootstrap(pool);
  await pool.query(`UPDATE users SET full_name='Ada Lovelace',title='Engineer',phone='123',time_zone='Asia/Ho_Chi_Minh',status=$2 WHERE id=$1`, [a.collaborator_id, { text: 'Old status', emoji: '👋', expires_at: '2020-01-01T00:00:00.000Z' }]);
  const result = await profile(a.owner_token, a.workspace_id, 'user', a.collaborator_id);
  assert.equal(result.kind, 'user'); assert.equal(result.full_name, 'Ada Lovelace');
  assert.equal(result.title, 'Engineer'); assert.equal(result.phone, '123'); assert.equal(result.status, null);
  assert.equal(result.time_zone, 'Asia/Ho_Chi_Minh');
  assert.deepEqual(Object.keys(result).sort(), ['kind','id','display_name','full_name','title','name_pronunciation','phone','time_zone','image','email','presence','status'].sort());
});

test('profiles enforce workspace membership, guest discovery and inactive target boundaries', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  await profile(b.owner_token, a.workspace_id, 'user', a.owner_id, 404);
  await profile(a.owner_token, a.workspace_id, 'user', b.owner_id, 404);
  await pool.query("UPDATE workspace_members SET guest_type='single' WHERE workspace_id=$1 AND user_id=$2", [a.workspace_id, a.collaborator_id]);
  await profile(a.collaborator_token, a.workspace_id, 'user', a.owner_id);
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2', [a.channel_id, a.collaborator_id]);
  await profile(a.collaborator_token, a.workspace_id, 'user', a.owner_id, 404);
  await profile(a.collaborator_token, a.workspace_id, 'agent', a.installation_id, 404);
  await profile(a.collaborator_token, a.workspace_id, 'user', a.collaborator_id);
  await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2', [a.workspace_id, a.collaborator_id]);
  await profile(a.owner_token, a.workspace_id, 'user', a.collaborator_id, 404);
  await profile(a.collaborator_token, a.workspace_id, 'user', a.owner_id, 404);
});

test('agent profiles exclude credentials and disappear when revoked or their owner leaves', async () => {
  const a = await bootstrap(pool);
  const pairing = await app.inject({ method: 'POST', url: `/v1/workspaces/${a.workspace_id}/agent-pairings`, headers: { authorization: `Bearer ${a.owner_token}` }, payload: {} });
  assert.equal(pairing.statusCode, 201);
  const claim = await app.inject({ method: 'POST', url: '/v1/agent-pairings/claim', payload: { code: pairing.json().code, credential: randomBytes(32).toString('base64url') } });
  assert.equal(claim.statusCode, 201);
  const id = claim.json().installation_id;
  const result = await profile(a.collaborator_token, a.workspace_id, 'agent', id);
  assert.equal(result.kind, 'agent'); assert.equal(result.owner_id, a.owner_id); assert.equal(result.availability, 'offline');
  assert.equal(result.can_message, false);
  assert.equal((await profile(a.owner_token, a.workspace_id, 'agent', id)).can_message, true);
  assert.deepEqual(Object.keys(result).sort(), ['kind','id','display_name','image','owner_id','owner_name','enabled','availability','can_message'].sort());
  await pool.query('UPDATE agent_connections SET revoked_at=now() WHERE installation_id=$1', [id]);
  await profile(a.owner_token, a.workspace_id, 'agent', id, 404);
  await pool.query('UPDATE agent_connections SET revoked_at=NULL WHERE installation_id=$1', [id]);
  await pool.query("UPDATE workspace_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2", [a.workspace_id, a.collaborator_id]);
  await pool.query('UPDATE workspaces SET primary_owner_id=$2 WHERE id=$1', [a.workspace_id, a.collaborator_id]);
  await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2', [a.workspace_id, a.owner_id]);
  await profile(a.collaborator_token, a.workspace_id, 'agent', id, 404);
});
