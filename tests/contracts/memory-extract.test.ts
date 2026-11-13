import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitMessages, parseExtraction, EXTRACT_LIMITS } from '@space/core/memory-extract';

const ids = new Set(['m1', 'm2']);

test('facts need evidence from this run; a bad item is dropped alone', () => {
  const out = parseExtraction({
    topics: [{ name: 'checkout retries', message_ids: ['m1'] }, { name: 'Checkout  Retries', message_ids: ['m2'] }, { name: 'x'.repeat(61), message_ids: ['m1'] }, 'refunds', { name: 'secret', message_ids: ['elsewhere'] }],
    facts: [
      { text: 'Charges are deduped on the idempotency key.', kind: 'decision', topic: 'checkout retries', message_ids: ['m1'] },
      { text: 'Made up.', kind: 'fact', topic: null, message_ids: ['elsewhere'] },
      { text: 'No evidence.', kind: 'fact', message_ids: [] },
      { text: 'Bad kind.', kind: 'opinion', message_ids: ['m2'] },
      { text: 'Missing kind becomes a fact.', message_ids: ['m1'] },
      { text: 'x'.repeat(281), kind: 'fact', message_ids: ['m2'] },
      { text: 'Unknown topic keeps the fact.', kind: 'answer', topic: 'nowhere', message_ids: ['m2', 'm2'] },
    ],
  }, ids);
  assert.deepEqual(out.topics, [{ name: 'checkout retries', message_ids: ['m1'] }], 'topic names need valid citations from this batch');
  assert.deepEqual(out.facts, [
    { text: 'Charges are deduped on the idempotency key.', kind: 'decision', topic: 'checkout retries', message_ids: ['m1'] },
    { text: 'Missing kind becomes a fact.', kind: 'fact', topic: null, message_ids: ['m1'] },
    { text: 'Unknown topic keeps the fact.', kind: 'answer', topic: null, message_ids: ['m2'] },
  ]);
});

test('model output is bounded and garbage yields nothing', () => {
  const many = parseExtraction({ topics: Array.from({ length: 9 }, (_, i) => ({ name: `t${i}`, message_ids: ['m1'] })), facts: Array.from({ length: 9 }, (_, i) => ({ text: `f${i}`, kind: 'fact', message_ids: ['m1'] })) }, ids);
  assert.equal(many.topics.length, EXTRACT_LIMITS.topics);
  assert.equal(many.facts.length, EXTRACT_LIMITS.facts);
  assert.deepEqual(parseExtraction('not json', ids), { topics: [], facts: [] });
  assert.deepEqual(parseExtraction('{"topics":"x"}', ids), { topics: [], facts: [] });
  assert.deepEqual(parseExtraction({ facts: [{ text: 'a\u0001b', kind: 'fact', message_ids: ['m1'] }] }, ids).facts, [], 'control characters are refused');
});

test('fitMessages keeps the oldest prefix inside the request budget', () => {
  const big = Array.from({ length: 80 }, (_, i) => ({ id: `m${i}`, speaker: 'a', text: 'x'.repeat(400) }));
  const kept = fitMessages(big);
  assert.ok(kept.length < 64 && kept.length > 0);
  assert.equal(kept[0]!.id, 'm0');
  assert.ok(Buffer.byteLength(JSON.stringify(kept)) <= EXTRACT_LIMITS.bytes);
  assert.equal(fitMessages(Array.from({ length: 70 }, (_, i) => ({ id: `m${i}`, speaker: 'a', text: 'hi' }))).length, 64);
});

test('an oversized message advances one position and leaves the next message intact', () => {
  const oversized = { id: 'm1', speaker: 'Kai', text: '𠮷語"\\\n'.repeat(2500) };
  const next = { id: 'm2', speaker: 'Kai', text: 'Follow up' };
  const source = [oversized, next];
  const batch = fitMessages(source);
  assert.deepEqual(batch.map(m => m.id), [oversized.id]);
  const first = batch[0]!;
  assert.equal(first.speaker, oversized.speaker);
  assert.ok(first.text.length > 0 && first.text.length < oversized.text.length);
  assert.ok(oversized.text.startsWith(first.text));
  assert.doesNotMatch(first.text, /[\uD800-\uDBFF]$/);
  assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= EXTRACT_LIMITS.bytes);
  assert.deepEqual(fitMessages(source.slice(batch.length)), [next]);
  assert.deepEqual(fitMessages([next, oversized]), [next]);
});

test('fitMessages counts the array delimiters and keeps a message that just fits', () => {
  const m = { id: 'm1', speaker: 'Kai', text: '' };
  const exact = { ...m, text: 'x'.repeat(EXTRACT_LIMITS.bytes - Buffer.byteLength(JSON.stringify([m]))) };
  assert.deepEqual(fitMessages([exact]), [exact]);
  assert.deepEqual(fitMessages([{ ...exact, text: exact.text + 'x' }]), [exact]);
});
