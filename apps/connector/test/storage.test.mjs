import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorStore, platformOrigin } from '../dist/storage.js';

test('only bare HTTPS or loopback HTTP origins are accepted', () => {
  assert.equal(platformOrigin('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000');
  assert.equal(platformOrigin('https://space.example'), 'https://space.example');
  for (const value of ['http://space.example', 'https://u:secret@space.example', 'https://space.example/?token=secret', 'https://space.example/#secret', 'https://space.example/path']) assert.throws(() => platformOrigin(value));
});

test('state is atomic, private, and credential survives a failed pairing/restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'space-store-'));
  try {
    const store = new ConnectorStore(join(dir, 'private'));
    const release = await store.lock();
    const first = await store.load();
    await store.save({ ...first, pending: { origin: 'https://space.example', credential: 'x'.repeat(43) } });
    assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(store.directory, 'state.json'))).mode & 0o777, 0o600);
    assert.equal((await new ConnectorStore(store.directory).load()).pending.credential, 'x'.repeat(43));
    await assert.rejects(new ConnectorStore(store.directory).lock(), /already running/);
    await release();
    const releaseAgain = await store.lock();
    await releaseAgain();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('refuses a symlink as the private storage directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'space-symlink-'));
  try {
    await symlink(dir, join(dir, 'link'));
    await assert.rejects(new ConnectorStore(join(dir, 'link')).load(), /symlink/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('stale locks require explicit recovery instead of racing two refresh writers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'space-lock-'));
  try {
    const store = new ConnectorStore(dir);
    await store.load();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'connector.lock'), '2147483647', { mode: 0o600 });
    await assert.rejects(store.lock(), /previous connector did not shut down/);
    assert.equal(await readFile(join(dir, 'connector.lock'), 'utf8'), '2147483647');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
