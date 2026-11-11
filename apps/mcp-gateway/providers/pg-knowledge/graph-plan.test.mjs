import test from 'node:test';
import assert from 'node:assert/strict';
import { lsnToVersion, planChange } from './graph-plan.mjs';

const ws = '11111111-1111-4111-8111-111111111111';
const vector = Array.from({ length: 384 }, () => 0.5);
const hydrated = {
  m1: { id: 'm1', workspace_id: ws, channel_id: 'c1', thread_id: 't1', agent_session_id: null, author_id: 'u1', author_type: 'human', sequence: '5', search_revision: '1', created_at: '2026-01-01T00:00:00Z', body: 'Hello', memory: true, knowledge: false, embedding: vector },
  m2: { id: 'm2', workspace_id: ws, channel_id: 'c1', thread_id: 't1', agent_session_id: 's1', author_id: 'i1', author_type: 'agent', sequence: '6', search_revision: '1', created_at: '2026-01-01T00:00:01Z', body: 'Done', memory: true, knowledge: false, embedding: vector },
};
const lookup = {
  message: async (_w, id) => hydrated[id] ?? null,
  threadsOf: async () => new Map([
    ['m1', { message: 'm1', thread: 't1', channel: 'c1', kind: 'channel' }],
    ['mx', { message: 'mx', thread: 't2', channel: 'c2', kind: 'channel' }],
  ]),
  channelsOfThreads: async () => new Map([
    ['t1', { thread: 't1', channel: 'c1', kind: 'channel' }],
    ['td', { thread: 'td', channel: 'cd', kind: 'direct' }],
  ]),
};
const has = (ops, re) => ops.find(o => re.test(o.text));
const note = (extra = {}) => ({ id: 'k1', workspace_id: ws, channel_id: 'c1', kind: 'fact', title: 'T', evidence: ['m1', 'mx'], revision: 3, removed_at: null, ...extra });

test('lsnToVersion turns an LSN into a number that grows with the log', () => {
  assert.equal(lsnToVersion('0/16B3748'), 0x16B3748n);
  assert.equal(lsnToVersion('1/0'), 1n << 32n);
  assert.ok(lsnToVersion('1/0') > lsnToVersion('0/FFFFFFFF'));
  assert.throws(() => lsnToVersion('nope'));
});

test('a message insert writes channel, thread, person and a guarded message with its vector', async () => {
  const ops = await planChange({ table: 'messages', op: 'insert', row: { id: 'm1', workspace_id: ws, channel_id: 'c1' } }, 50n, lookup);
  const upsert = has(ops, /INSERT INTO kb\.m_messages/);
  assert.match(upsert.text, /WHERE kb\.m_messages\.version<EXCLUDED\.version/);
  assert.equal(upsert.values[0], 'm1');
  assert.equal(upsert.values.at(-1), '50');
  assert.ok(upsert.values.includes(JSON.stringify(vector)));
  assert.ok(has(ops, /INSERT INTO kb\.m_channels/) && has(ops, /INSERT INTO kb\.m_threads/) && has(ops, /INSERT INTO kb\.m_people/));
  assert.ok(ops.indexOf(has(ops, /INSERT INTO kb\.m_channels/)) < ops.indexOf(upsert), 'parents exist before the message');
  assert.match(has(ops, /upsert_points\('kb_memory'/).text, /version=\$\d+::bigint/, 'the vector point follows only the winning change');
  assert.ok(has(ops, /UPDATE kb\.m_threads t SET/), 'thread counts are recomputed');
  assert.equal(has(ops, /m_session_turns/), undefined, 'a human message is not a session turn');
});

test('an agent session message also links a session turn', async () => {
  const ops = await planChange({ table: 'messages', op: 'update', row: { id: 'm2', workspace_id: ws, channel_id: 'c1' } }, 51n, lookup);
  assert.ok(has(ops, /INSERT INTO kb\.m_sessions/), 'session placeholder');
  assert.ok(has(ops, /INSERT INTO kb\.m_session_turns/));
});

test('a message that left the source view becomes a guarded delete that also drops its vector point', async () => {
  const ops = await planChange({ table: 'messages', op: 'update', row: { id: 'gone', workspace_id: ws, channel_id: 'c1' } }, 60n, lookup);
  const texts = ops.map(o => o.text);
  const recompute = texts.findIndex(t => /UPDATE kb\.m_threads t SET/.test(t));
  const points = texts.findIndex(t => /delete_points\('kb_memory'/.test(t));
  const del = texts.findIndex(t => /DELETE FROM kb\.m_messages/.test(t));
  assert.ok(recompute >= 0 && recompute < points && points < del, 'counts first, then the point, then the row');
  assert.deepEqual(ops[del].values, ['gone', '60']);
});

test('a delete change uses the key row alone', async () => {
  const ops = await planChange({ table: 'messages', op: 'delete', row: { id: 'gone', channel_id: 'c1' } }, 61n, lookup);
  assert.ok(has(ops, /DELETE FROM kb\.m_messages/));
});

test('a knowledge insert keeps evidence from its own channel at message level', async () => {
  const ops = await planChange({ table: 'knowledge_notes', op: 'insert', row: note() }, 70n, lookup);
  const upsert = has(ops, /INSERT INTO kb\.m_knowledge\(/);
  assert.match(upsert.text, /WHERE kb\.m_knowledge\.version<EXCLUDED\.version/);
  assert.deepEqual(upsert.values.slice(0, 6), ['k1', ws, 'c1', 'fact', 'T', 3]);
  const evidence = has(ops, /INSERT INTO kb\.m_knowledge_evidence/);
  assert.deepEqual(evidence.values[2], ['m1'], 'mx belongs to another channel');
  assert.deepEqual(evidence.values[4], ['t1'], 'each evidence message carries its thread');
});

test('knowledge evidence rows change only when this change won the version check', async () => {
  const ops = await planChange({ table: 'knowledge_notes', op: 'update', row: note() }, 9n, lookup);
  for (const o of ops.filter(o => /m_knowledge_evidence/.test(o.text))) assert.match(o.text, /version=\$\d+::bigint/);
});

test('a removed knowledge becomes one guarded delete', async () => {
  const ops = await planChange({ table: 'knowledge_notes', op: 'update', row: note({ removed_at: new Date() }) }, 7n, lookup);
  assert.equal(ops.length, 1);
  assert.match(ops[0].text, /DELETE FROM kb\.m_knowledge WHERE id=\$1::text AND version<=\$2::bigint/);
  assert.deepEqual(ops[0].values, ['k1', '7']);
});

test('direct-message channels never enter the graph', async () => {
  const dm = { id: 'cd', workspace_id: ws, name: '', private: true, kind: 'direct', memory_enabled: false, knowledge_enabled: false };
  assert.deepEqual(await planChange({ table: 'channels', op: 'insert', row: dm }, 4n, lookup), []);
});

test('a channel row carries both switches', async () => {
  const row = { id: 'c1', workspace_id: ws, name: 'general', private: false, kind: 'channel', memory_enabled: true, knowledge_enabled: false };
  const [op] = await planChange({ table: 'channels', op: 'update', row }, 6n, lookup);
  assert.match(op.text, /WHERE kb\.m_channels\.version<EXCLUDED\.version/);
  assert.deepEqual(op.values, ['c1', ws, 'general', false, true, false, '6']);
});

test('a session in a direct-message thread is skipped, one in a channel thread is kept', async () => {
  const base = { id: 's1', workspace_id: ws, title: 'Run', state: 'active' };
  assert.deepEqual(await planChange({ table: 'agent_sessions', op: 'insert', row: { ...base, origin_thread_id: 'td' } }, 3n, lookup), []);
  const ops = await planChange({ table: 'agent_sessions', op: 'insert', row: { ...base, origin_thread_id: 't1' } }, 3n, lookup);
  assert.ok(has(ops, /INSERT INTO kb\.m_sessions[\s\S]*kb\.m_sessions\.version<EXCLUDED\.version/));
});

test('other tables are ignored', async () => {
  assert.deepEqual(await planChange({ table: 'threads', op: 'insert', row: {} }, 1n, lookup), []);
});
