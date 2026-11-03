import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, mkdir, writeFile, utimes } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownMemoryProvider } from './dist/markdown-memory.js';

async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), 'space-markdown-'));
  try { await work(new MarkdownMemoryProvider(root), root, { workspace_id: randomUUID(), channel_id: randomUUID() }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
test('independent Markdown providers atomically reject concurrent stale replacements', () => fixture(async (provider, root, scope) => {
  const empty = await provider.read(scope);
  const other = new MarkdownMemoryProvider(root);
  const results = await Promise.allSettled([provider.write(scope, 'first', empty.revision), other.write(scope, 'second', empty.revision)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /memory_conflict/);
}));
test('independent Markdown providers retain concurrent sources without caller serialization', () => fixture(async (_provider, root, scope) => {
  const sources = Array.from({ length: 8 }, (_, i) => ({ id: `document:${randomUUID()}`, title: `Source ${i}`, text: `Fact ${i}` }));
  await Promise.all(sources.map(source => new MarkdownMemoryProvider(root).ingest(scope, source)));
  const saved = await new MarkdownMemoryProvider(root).read(scope);
  assert.deepEqual(new Set(saved.sources.map(source => source.id)), new Set(sources.map(source => source.id)));
}));
test('Markdown revision checks coordinate separate processes and recover abandoned locks', () => fixture(async (provider, root, scope) => {
  const empty = await provider.read(scope);
  const script = `import { MarkdownMemoryProvider } from ${JSON.stringify(new URL('./dist/markdown-memory.js', import.meta.url).href)};
    const provider = new MarkdownMemoryProvider(process.argv[1]);
    try { await provider.write(JSON.parse(process.argv[2]), process.argv[3], process.argv[4]); console.log('saved'); }
    catch (error) { if (error.message !== 'memory_conflict') throw error; console.log('conflict'); }`;
  const run = promisify(execFile);
  const results = await Promise.all(['first', 'second'].map(content => run(process.execPath, ['--input-type=module', '-e', script, root, JSON.stringify(scope), content, empty.revision])));
  assert.deepEqual(results.map(result => result.stdout.trim()).sort(), ['conflict', 'saved']);
  const lock = join(root, scope.workspace_id, scope.channel_id, 'memory.md.lock');
  await mkdir(lock);
  const stale = new Date(Date.now() - 60_000);
  await utimes(lock, stale, stale);
  const current = await provider.read(scope);
  assert.equal((await provider.write(scope, 'recovered', current.revision)).content, 'recovered');
}));
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
