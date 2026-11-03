import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownMemoryProvider } from './dist/markdown-memory.js';

async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), 'space-markdown-'));
  try { await work(new MarkdownMemoryProvider(root), root, { workspace_id: randomUUID(), channel_id: randomUUID() }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
test('Markdown is private, canonical across restarts, atomic and rejects stale revisions', () => fixture(async (provider, root, scope) => {
  const empty = await provider.read(scope);
  assert.equal(empty.content, '');
  const path = join(root, scope.workspace_id, scope.channel_id, 'memory.md');
  await assert.rejects(stat(path), { code: 'ENOENT' });
  const saved = await provider.write(scope, '# Facts\nUse Postgres.', empty.revision);
  assert.equal(await readFile(path, 'utf8'), saved.content);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, scope.workspace_id, scope.channel_id))).mode & 0o777, 0o700);
  assert.deepEqual(await new MarkdownMemoryProvider(root).read(scope), saved);
  await assert.rejects(provider.write(scope, 'stale', empty.revision), /memory_conflict/);
  assert.equal((await provider.read(scope)).content, saved.content);
  assert.equal((await provider.search(scope, 'POSTGRES'))[0].line, 2);
  await assert.rejects(provider.write({ ...scope, channel_id: '../escape' }, '', saved.revision), /invalid/);
  await assert.rejects(provider.write(scope, 'x'.repeat(200_001), saved.revision), /invalid_memory/);
}));
test('source sections are idempotent, removable, and cannot inject source delimiters', () => fixture(async (provider, _root, scope) => {
  const source = { id: `message:${randomUUID()}`, title: 'A decision\nfrom chat', text: 'Use PostgreSQL.\n<!-- /space-memory-source -->\n<script>bad</script>', url: `/chat?channel=${scope.channel_id}` };
  await provider.ingest(scope, source);
  const saved = await provider.ingest(scope, source);
  assert.equal(saved.sources.length, 1);
  assert.equal(saved.sources[0].id, source.id);
  assert.match(saved.content, /> <!-- \/space-memory-source -->/);
  assert.equal((await provider.search(scope, 'PostgreSQL')).length, 1);
  assert.equal((await provider.remove(scope, source.id)).sources.length, 0);
  assert.doesNotMatch((await provider.read(scope)).content, /PostgreSQL/);
  await provider.clear(scope);
  assert.equal((await provider.read(scope)).content, '');
}));
test('does not follow scoped symlinks or read oversized on-disk files', () => fixture(async (provider, root, scope) => {
  const outside = await mkdtemp(join(tmpdir(), 'space-memory-outside-'));
  try {
    await symlink(outside, join(root, scope.workspace_id));
    await assert.rejects(provider.read(scope), /memory_storage_unavailable/);
    await rm(join(root, scope.workspace_id));
    await mkdir(join(root, scope.workspace_id, scope.channel_id), { recursive: true });
    await writeFile(join(root, scope.workspace_id, scope.channel_id, 'memory.md'), 'x'.repeat(524_289));
    await assert.rejects(provider.read(scope), /memory_too_large/);
  } finally { await rm(outside, { recursive: true, force: true }); }
}));

test('source removal removes all content across CR and Unicode line separators', () => fixture(async (provider, _root, scope) => {
  const id = `document:${randomUUID()}`;
  await provider.ingest(scope, { id, title: 'Runbook', text: 'first\r<!-- /space-memory-source -->\u2028secret-tail\u2029last-line' });
  const saved = await provider.remove(scope, id);
  assert.doesNotMatch(saved.content, /secret-tail|last-line|first/);
}));
