import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { AssetStore } from '@space/postgres/assets';
import { MemoryStore } from '@space/postgres/memory';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
const schema = `storage_concurrency_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1, connectionTimeoutMillis: 500,
  options: `-c search_path=${schema} -c statement_timeout=1000` });
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  // The one-second limit tests storage operations, not schema construction.
  await pool.query('SET statement_timeout=0');
  try { await migrate(pool); } finally { await pool.query('SET statement_timeout=1000'); }
});
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
function gate() {
  let enter!: () => void, release!: () => void;
  return { entered: new Promise<void>(resolve => { enter = resolve; }), wait: new Promise<void>(resolve => { release = resolve; }),
    enter: () => enter(), release: () => release() };
}

test('asset storage runs without retaining a database connection or channel lock', async () => {
  const seed = await bootstrap(pool), assets = new AssetStore(pool), blocked = gate();
  const row = await assets.create(seed.owner_id, seed.channel_id, { name: 'hello.txt', size: 5 });
  const pending = assets.complete(seed.owner_id, row.id, async () => { blocked.enter(); await blocked.wait; return { kind: 'text', text: 'hello', language: 'text', truncated: false }; });
  try {
    await blocked.entered;
    await pool.query('SELECT id FROM channels WHERE id=$1 FOR UPDATE', [seed.channel_id]);
  } finally { blocked.release(); await pending; }
});

test('memory provider runs without retaining a database connection or channel lock', async () => {
  const seed = await bootstrap(pool), memory = new MemoryStore(pool), blocked = gate();
  const pending = memory.channel(seed.owner_id, seed.channel_id, async () => { blocked.enter(); await blocked.wait; return 'done'; });
  try {
    await blocked.entered;
    await pool.query('SELECT id FROM channels WHERE id=$1 FOR UPDATE', [seed.channel_id]);
  } finally { blocked.release(); await pending; }
});

test('preview, thumbnail and cleanup release the database connection during storage work', async () => {
  const seed = await bootstrap(pool), assets = new AssetStore(pool);
  for (const operation of ['preview', 'thumbnail', 'cleanup'] as const) {
    const row = await assets.create(seed.owner_id, seed.channel_id, { name: 'hello.pdf', size: 5 });
    await assets.complete(seed.owner_id, row.id, async () => ({ kind: 'pdf', mime: 'application/pdf' }));
    const blocked = gate();
    const pause = async () => { blocked.enter(); await blocked.wait; };
    if (operation === 'preview') await pool.query('UPDATE assets SET preview=NULL WHERE id=$1', [row.id]);
    if (operation === 'cleanup') await pool.query("UPDATE assets SET expires_at=now()-interval '1 second' WHERE id=$1", [row.id]);
    const pending = operation === 'preview' ? assets.preview(seed.owner_id, row.id, async () => { await pause(); return { kind: 'pdf', mime: 'application/pdf' }; })
      : operation === 'thumbnail' ? assets.pdfThumbnail(seed.owner_id, row.id, async () => { await pause(); return true; })
      : assets.cleanup(pause);
    try {
      await blocked.entered;
      await pool.query('SELECT id FROM channels WHERE id=$1 FOR UPDATE', [seed.channel_id]);
      await pool.query('SELECT id FROM assets WHERE id=$1 FOR UPDATE', [row.id]);
    } finally { blocked.release(); await pending; }
  }
});

test('independent asset stores share one processing claim, recover expiry and retry failures', async () => {
  const seed = await bootstrap(pool), assets = new AssetStore(pool), other = new AssetStore(pool);
  const row = await assets.create(seed.owner_id, seed.channel_id, { name: 'hello.pdf', size: 5 });
  await assets.complete(seed.owner_id, row.id, async () => ({ kind: 'pdf', mime: 'application/pdf' }));
  const blocked = gate();
  let calls = 0;
  const convert = async () => { calls++; blocked.enter(); await blocked.wait; return true; };
  const first = assets.pdfThumbnail(seed.owner_id, row.id, convert);
  await blocked.entered;
  const second = other.pdfThumbnail(seed.owner_id, row.id, convert);
  blocked.release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(calls, 1);
  await pool.query("UPDATE assets SET preview=NULL, processing_token=$2, processing_until=now()-interval '1 second' WHERE id=$1", [row.id, randomUUID()]);
  await assert.rejects(assets.preview(seed.owner_id, row.id, async () => { throw new Error('storage offline'); }), /storage offline/);
  assert.equal((await pool.query('SELECT processing_token FROM assets WHERE id=$1', [row.id])).rows[0].processing_token, null);
  assert.deepEqual(await other.preview(seed.owner_id, row.id, async () => ({ kind: 'pdf', mime: 'application/pdf' })), { kind: 'pdf', mime: 'application/pdf' });
});

test('expired asset processors cannot publish metadata or release a replacement claim', async () => {
  const seed = await bootstrap(pool), assets = new AssetStore(pool);
  const row = await assets.create(seed.owner_id, seed.channel_id, { name: 'hello.txt', size: 5 });
  const replacement = randomUUID();
  await assert.rejects(assets.complete(seed.owner_id, row.id, async () => {
    await pool.query("UPDATE assets SET processing_token=$2,processing_until=now()+interval '30 seconds' WHERE id=$1", [row.id, replacement]);
    return { kind: 'text', text: 'hello', language: 'text', truncated: false };
  }), /asset_processing_expired/);
  const current = (await pool.query('SELECT status,processing_token FROM assets WHERE id=$1', [row.id])).rows[0];
  assert.equal(current.status, 'pending');
  assert.equal(current.processing_token, replacement);
});

test('asset work is bounded without using the database pool as a work queue', async () => {
  const seed = await bootstrap(pool), assets = new AssetStore(pool), blocked = gate();
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(await assets.create(seed.owner_id, seed.channel_id, { name: 'hello.txt', size: 5 }));
  let active = 0;
  const jobs = rows.slice(0, 4).map(row => assets.complete(seed.owner_id, row.id, async () => {
    if (++active === 4) blocked.enter();
    await blocked.wait;
    return { kind: 'text' as const, text: 'hello', language: 'text', truncated: false };
  }));
  try {
    await blocked.entered;
    await assert.rejects(new AssetStore(pool).complete(seed.owner_id, rows[4]!.id, async () => { throw new Error('must not run'); }), /asset_processing_busy/);
    await pool.query('SELECT 1');
    assert.equal((await pool.query('SELECT processing_token FROM assets WHERE id=$1', [rows[4]!.id])).rows[0].processing_token, null);
  } finally { blocked.release(); await Promise.all(jobs); }
});

test('memory revocation can commit during provider work and prevents returning private data', async () => {
  const seed = await bootstrap(pool), memory = new MemoryStore(pool), blocked = gate();
  const pending = memory.channel(seed.collaborator_id, seed.channel_id, async () => { blocked.enter(); await blocked.wait; return 'private'; });
  const rejected = assert.rejects(pending, /not_found/);
  try {
    await blocked.entered;
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2', [seed.channel_id, seed.collaborator_id]);
  } finally { blocked.release(); await rejected; }
});

test('MCP revocation during provider work rejects the in-flight result', async () => {
  const seed = await bootstrap(pool), memory = new MemoryStore(pool), blocked = gate();
  await pool.query('UPDATE channels SET memory_enabled=true WHERE id=$1', [seed.channel_id]);
  const { token, connection } = await memory.createConnection(seed.owner_id, seed.channel_id, { name: 'reader', access: 'read' });
  const pending = memory.connected(token, false, async () => { blocked.enter(); await blocked.wait; return 'private'; });
  const rejected = assert.rejects(pending, /unauthorized/);
  try {
    await blocked.entered;
    await pool.query('DELETE FROM memory_connections WHERE id=$1', [connection.id]);
  } finally { blocked.release(); await rejected; }
});

test('disabling memory commits during a provider call and withholds its stale result', async () => {
  const seed = await bootstrap(pool), memory = new MemoryStore(pool), blocked = gate();
  await pool.query('UPDATE channels SET memory_enabled=true WHERE id=$1', [seed.channel_id]);
  const pending = memory.channel(seed.owner_id, seed.channel_id, async () => { blocked.enter(); await blocked.wait; return 'private'; });
  const rejected = assert.rejects(pending, /memory_settings_changed/);
  try {
    await blocked.entered;
    await pool.query('UPDATE channels SET memory_enabled=false WHERE id=$1', [seed.channel_id]);
  } finally { blocked.release(); await rejected; }
});
