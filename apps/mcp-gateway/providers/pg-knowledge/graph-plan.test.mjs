import test from 'node:test';
import assert from 'node:assert/strict';
import { lsnToVersion, planChange } from './graph-plan.mjs';

const ws = '11111111-1111-4111-8111-111111111111';
const lookup = {
  threadsOf: async () => new Map([
    ['m1', { message: 'm1', thread: 't1', channel: 'c1', kind: 'channel' }],
    ['m2', { message: 'm2', thread: 't2', channel: 'c2', kind: 'channel' }],
  ]),
  channelsOfThreads: async () => new Map([
    ['t1', { thread: 't1', channel: 'c1', kind: 'channel' }],
    ['td', { thread: 'td', channel: 'cd', kind: 'direct' }],
  ]),
};
const note = (extra = {}) => ({ id: 'k1', workspace_id: ws, channel_id: 'c1', kind: 'fact', title: 'T', evidence: ['m1', 'm2'], revision: 3, removed_at: null, ...extra });

test('lsnToVersion turns an LSN into a number that grows with the log', () => {
  assert.equal(lsnToVersion('0/16B3748'), 0x16B3748n);
  assert.equal(lsnToVersion('1/0'), 1n << 32n);
  assert.ok(lsnToVersion('1/0') > lsnToVersion('0/FFFFFFFF'));
  assert.throws(() => lsnToVersion('nope'));
});

test('a knowledge insert writes a guarded upsert and only evidence from its own channel', async () => {
  const ops = await planChange({ table: 'knowledge_notes', op: 'insert', row: note() }, 50n, lookup);
  const upsert = ops.find(o => o.text.includes('INSERT INTO kb.g_knowledge'));
  assert.match(upsert.text, /WHERE kb\.g_knowledge\.version<EXCLUDED\.version/);
  assert.deepEqual(upsert.values.slice(0, 6), ['k1', ws, 'c1', 'fact', 'T', 3]);
  assert.equal(upsert.values[6], '50');
  const evidence = ops.find(o => o.text.includes('INSERT INTO kb.g_evidence'));
  assert.deepEqual(evidence.values[2], ['t1'], 'm2 belongs to another channel and is dropped');
  const stubs = ops.filter(o => o.text.includes('INSERT INTO kb.g_channels') || o.text.includes('INSERT INTO kb.g_threads'));
  assert.equal(stubs.length, 2, 'the channel and thread exist before the knowledge points at them');
  assert.ok(ops.indexOf(stubs[0]) < ops.indexOf(upsert));
});

test('evidence arrives as text in a Postgres array literal too', async () => {
  const ops = await planChange({ table: 'knowledge_notes', op: 'insert', row: note({ evidence: '{m1}' }) }, 5n, lookup);
  assert.deepEqual(ops.find(o => o.text.includes('INSERT INTO kb.g_evidence')).values[2], ['t1']);
});

test('evidence rows are only touched when this change won the version check', async () => {
  const ops = await planChange({ table: 'knowledge_notes', op: 'update', row: note() }, 9n, lookup);
  for (const o of ops.filter(o => o.text.includes('g_evidence'))) assert.match(o.text, /version=\$\d+::bigint/);
});

test('a removed knowledge becomes one guarded delete', async () => {
  const ops = await planChange({ table: 'knowledge_notes', op: 'update', row: note({ removed_at: new Date() }) }, 7n, lookup);
  assert.equal(ops.length, 1);
  assert.match(ops[0].text, /DELETE FROM kb\.g_knowledge WHERE id=\$1::text AND version<=\$2::bigint/);
  assert.deepEqual(ops[0].values, ['k1', '7']);
});

test('a delete change uses the key row alone', async () => {
  const ops = await planChange({ table: 'knowledge_notes', op: 'delete', row: { id: 'k1' } }, 8n, lookup);
  assert.deepEqual(ops.map(o => o.values), [['k1', '8']]);
});

test('direct-message channels never enter the graph', async () => {
  const dm = { id: 'cd', workspace_id: ws, name: '', private: true, kind: 'direct', knowledge_enabled: false };
  assert.deepEqual(await planChange({ table: 'channels', op: 'insert', row: dm }, 4n, lookup), []);
});

test('a channel row is a guarded upsert', async () => {
  const row = { id: 'c1', workspace_id: ws, name: 'general', private: false, kind: 'channel', knowledge_enabled: true };
  const [op] = await planChange({ table: 'channels', op: 'update', row }, 6n, lookup);
  assert.match(op.text, /WHERE kb\.g_channels\.version<EXCLUDED\.version/);
  assert.deepEqual(op.values, ['c1', ws, 'general', false, true, '6']);
});

test('a session in a direct-message thread is skipped, one in a channel thread is kept', async () => {
  const base = { id: 's1', workspace_id: ws, title: 'Run', state: 'active' };
  assert.deepEqual(await planChange({ table: 'agent_sessions', op: 'insert', row: { ...base, origin_thread_id: 'td' } }, 3n, lookup), []);
  const ops = await planChange({ table: 'agent_sessions', op: 'insert', row: { ...base, origin_thread_id: 't1' } }, 3n, lookup);
  assert.ok(ops.some(o => o.text.includes('INSERT INTO kb.g_sessions') && o.text.includes('kb.g_sessions.version<EXCLUDED.version')));
});

test('other tables are ignored', async () => {
  assert.deepEqual(await planChange({ table: 'messages', op: 'insert', row: {} }, 1n, lookup), []);
});
