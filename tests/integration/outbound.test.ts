import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
const schema = `outbound_${randomBytes(6).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
test('personal connections isolate accounts and reset permissions on credential changes', async () => {
  assert.ok(existsSync('../adapters/postgres/outbound.ts'), 'personal outbound store exists');
  const { OutboundStore } = await import('@space/postgres/outbound');
  const seed = await bootstrap(pool);
  const store = new OutboundStore(pool, randomBytes(32).toString('hex'));
  const users = (await pool.query('SELECT id FROM users ORDER BY id LIMIT 2')).rows;
  const owner = users[0].id,
    other = users[1].id;
  const first = await store.create(owner, {
    name: 'Work',
    url: 'https://mcp.example.com/mcp',
    auth_type: 'bearer',
    token: 'work-token',
  });
  const second = await store.create(owner, {
    name: 'Personal',
    url: first.url,
    auth_type: 'bearer',
    token: 'personal-token',
  });
  assert.equal((await store.list(owner)).items.length, 2);
  assert.equal((await store.list(other)).items.length, 0);
  assert.ok(!JSON.stringify(await store.list(owner)).includes('work-token'));
  await assert.rejects(store.get(other, first.id), /not_found/);
  await assert.rejects(store.remove(other, first.id, { revision: first.revision }), /not_found/);
  assert.equal((await store.credentials(owner, first.id)).token, 'work-token');
  assert.equal((await store.credentials(owner, second.id)).token, 'personal-token');
  // Rotate both fields precisely between metadata and secret reads. A consistent
  // snapshot must never send the new credential to the previous server.
  const get = store.get.bind(store);
  let rotate = true;
  store.get = async (actor, id, client) => {
    const result = await get(actor, id, client);
    if (rotate && id === second.id) {
      rotate = false;
      await store.update(owner, second.id, {
        revision: second.revision,
        url: 'https://new.example.com/mcp',
        token: 'new-account-token',
      });
    }
    return result;
  };
  const snapshot = await store.credentials(owner, second.id);
  store.get = get;
  assert.equal(snapshot.url, second.url);
  assert.equal(snapshot.token, 'personal-token');
  assert.equal((await store.credentials(owner, second.id)).token, 'new-account-token');
  const discovered = await store.catalog(owner, first.id, first.revision, [
    { name: 'read', inputSchema: { type: 'object' } },
  ]);
  const edited = await store.update(owner, first.id, { revision: discovered.revision, token: 'new-token' });
  assert.deepEqual(edited.tools, []);
  assert.deepEqual(edited.grants, []);
  await assert.rejects(
    store.update(owner, first.id, { revision: first.revision, name: 'stale' }),
    /connection_changed/,
  );
  assert.equal((await store.credentials(owner, first.id)).token, 'new-token');
  await store.remove(owner, first.id, { revision: edited.revision });
  await assert.rejects(store.get(owner, first.id), /not_found/);
});
test('concurrent personal creates cannot exceed twenty connections', async () => {
  assert.ok(existsSync('../adapters/postgres/outbound.ts'), 'personal outbound store exists');
  const { OutboundStore } = await import('@space/postgres/outbound');
  const owner = (await pool.query('SELECT id FROM users ORDER BY id DESC LIMIT 1')).rows[0].id;
  const store = new OutboundStore(pool, randomBytes(32).toString('hex'));
  const attempts = await Promise.allSettled(
    Array.from({ length: 24 }, (_, i) =>
      store.create(owner, { name: `Server ${i}`, url: 'https://mcp.example.com', auth_type: 'none' }),
    ),
  );
  assert.ok(attempts.some((a) => a.status === 'rejected'));
  assert.equal((await store.list(owner)).items.length, 20);
});
