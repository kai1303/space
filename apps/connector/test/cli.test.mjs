import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOptions } from '../dist/main.js';

test('CLI accepts onboarding arguments, requires no repository/channel, and rejects unknown flags', () => {
  assert.deepEqual(parseOptions(['--url', 'http://localhost:3000', '--pair', 'a'.repeat(32)]), { url: 'http://localhost:3000', pair: 'a'.repeat(32), login: false, logout: false, help: false, connect: false });
  assert.equal(parseOptions(['--login']).login, true);
  assert.equal(parseOptions(['--connect']).connect, true);
  assert.throws(() => parseOptions(['--logout', '--connect']));
  assert.equal(parseOptions(['--logout']).logout, true);
  assert.throws(() => parseOptions(['--repo', '/tmp/project']));
  assert.throws(() => parseOptions(['--url', 'https://example.com?token=secret']));
  assert.throws(() => parseOptions(['--login', '--logout']));
  assert.throws(() => parseOptions(['--pair', 'bad']));
});


test('--connect prompts for a new code even with a saved platform connection', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const { ConnectorStore } = await import('../dist/storage.js');
  const home = await mkdtemp(join(tmpdir(), 'space-cli-'));
  try {
    const store = new ConnectorStore(join(home, '.config', 'space-connector'));
    const state = await store.load();
    state.connection = { origin: 'http://127.0.0.1:9', credential: 'credential', installation_id: 'i', workspace_id: 'w' };
    await store.save(state);
    await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../dist/main.js', import.meta.url)), '--url', 'http://127.0.0.1:9', '--connect'], { env: { ...process.env, HOME: home }, timeout: 3000 }), error => {
      assert.match(error.stderr, /Provide --pair/);
      return true;
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});
