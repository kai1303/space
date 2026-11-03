import assert from 'node:assert/strict';
import { createPool } from '@space/postgres/database';
import { bootstrap } from '@space/postgres/bootstrap';
import { FoundationStore } from '@space/postgres/foundation';
const pool = createPool(process.env.DATABASE_URL);
try {
  const seed = await bootstrap(pool);
  const foundation = new FoundationStore(pool);
  const request = { workspace_id: seed.workspace_id, definition_id: seed.definition_id, connector_id: 'mock' };
  const alice = await foundation.install(seed.owner_id, request);
  const bob = await foundation.install(seed.collaborator_id, request);
  assert.notEqual(alice.id, bob.id);
  const visible = async () => (await foundation.list(seed.collaborator_id, seed.workspace_id)).some(i => i.id === alice.id);
  assert.equal(await visible(), false);
  console.log('Two owners installed one definition; each installation starts with no grants.');
  await assert.rejects(foundation.setEnabled(seed.collaborator_id, alice.id, false), { status: 403 });
  console.log('Collaborator cannot manage the other owner’s installation.');
  const grant = { channel_id: seed.channel_id, skill: 'demo.echo' };
  await foundation.grant(seed.owner_id, alice.id, grant);
  assert.equal(await visible(), true);
  console.log('Channel grant makes the installation visible to its members.');
  await foundation.revoke(seed.owner_id, alice.id, grant);
  assert.equal(await visible(), false);
  const disabled = await foundation.setEnabled(seed.owner_id, alice.id, false);
  assert.equal(disabled.enabled, false);
  console.log('Revocation removes shared visibility; owner can disable the installation.');
  console.log(`Foundation demo passed. Created workspace ${seed.workspace_id}.`);
} finally { await pool.end(); }
