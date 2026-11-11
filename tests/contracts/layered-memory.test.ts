import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { encodeChannelCursor, parseChannelCursor, parseSessionMemory, visibleText, extractMemoryBlock, parseAgentResponse } from '@space/contracts';

test('channel cursors round-trip and reject tampering', () => {
  const cursor = { as_of: '2026-11-11 10:00:00.123456+00', created_at: '2026-11-10 09:00:00.5+00', thread_id: randomUUID() };
  assert.deepEqual(parseChannelCursor(encodeChannelCursor(cursor)), cursor);
  for (const bad of ['', 'not-base64!', Buffer.from('{"as_of":1}').toString('base64url'), encodeChannelCursor({ ...cursor, thread_id: 'x' })]) {
    assert.throws(() => parseChannelCursor(bad), (e: any) => e.code === 'invalid_memory_cursor');
  }
});

test('session memory is a node, recent turns and related turns, with no agent note', () => {
  const node = { ref: { kind: 'session', id: randomUUID() }, parent: { kind: 'thread', id: randomUUID() }, summary: 'Fix', updated_at: 'x', children: null };
  assert.deepEqual(parseSessionMemory({ node, messages: [], related: [] }).messages, []);
  assert.throws(() => parseSessionMemory({ node, messages: [], related: [], memory: null }), (e: any) => e.code === 'invalid_record' || e.status === 400);
  assert.throws(() => parseSessionMemory({ node, messages: Array(17).fill(null), related: [] }), (e: any) => e.status === 400);
});

const notes = '<space-memory>{"notes":[{"kind":"decision","title":"T","content":"C"}]}</space-memory>';

test('the memory block is hidden from people while streaming and when final', () => {
  assert.equal(visibleText(`Done.\n${notes}`, true), 'Done.');
  assert.equal(visibleText('Done.\n<space-mem', false), 'Done.\n');
  assert.equal(visibleText('a < b', true), 'a < b');
  assert.equal(visibleText('a <', false), 'a ');
});

test('extractMemoryBlock keeps knowledge notes and drops a block with nothing to save', () => {
  assert.equal(extractMemoryBlock(`x ${notes}`)?.notes?.[0]?.title, 'T');
  assert.equal(extractMemoryBlock('<space-memory>{bad</space-memory>'), undefined);
  assert.equal(extractMemoryBlock('<space-memory>{"thread":{"base_revision":0,"summary":"s","content":"x"}}</space-memory>'), undefined, 'the retired thread part saves nothing');
  assert.equal(extractMemoryBlock('no block'), undefined);
});

test('an invalid memory field never fails the whole response', () => {
  const response = parseAgentResponse({ messages: [], tools: [], components: [], memory: { session: { base_revision: -1, summary: 'x', content: 'y' } } });
  assert.equal(response.memory, undefined);
  const ok = parseAgentResponse({ messages: [], tools: [], components: [], memory: { notes: [{ kind: 'fact', title: 'A', content: 'B' }] } });
  assert.equal(ok.memory?.notes?.[0]?.title, 'A');
});
