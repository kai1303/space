const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { bundledPlugins } = require('../src/browser/plugins.cjs');

test('bundled activation is independent, durable and scoped to the desktop profile', t => {
  const root = mkdtempSync(join(tmpdir(), 'space-plugins-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const alice = bundledPlugins(root, 'alice');
  assert.deepEqual(alice.installed(), []);
  alice.set('office', true);
  alice.set('office', true);
  assert.deepEqual(bundledPlugins(root, 'alice').installed(), ['office']);
  assert.deepEqual(bundledPlugins(root, 'bob').installed(), []);
  alice.set('browser', true);
  alice.set('office', false);
  alice.set('office', false);
  assert.deepEqual(bundledPlugins(root, 'alice').installed(), ['browser']);
  assert.throws(() => alice.set('../other', true));
});
