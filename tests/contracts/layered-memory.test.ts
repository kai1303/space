import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseThreadCheckpoint, encodeChannelCursor, parseChannelCursor, CHECKPOINT_LIMIT } from '@space/contracts';

const base = { revision: 0, through_sequence: '4', content: '# Decisions\nUse TS.', summary: 'Use TS', source_message_ids: [randomUUID()] };

test('checkpoints require a 1–280 character summary', () => {
  assert.equal(parseThreadCheckpoint(base).summary, 'Use TS');
  assert.throws(() => parseThreadCheckpoint({ ...base, summary: undefined }), (e: any) => e.code === 'invalid_summary');
  assert.throws(() => parseThreadCheckpoint({ ...base, summary: ' ' }), (e: any) => e.code === 'invalid_summary');
  assert.throws(() => parseThreadCheckpoint({ ...base, summary: 'x'.repeat(281) }), (e: any) => e.code === 'invalid_summary');
});

test('over-long checkpoints return 413 checkpoint_too_large', () => {
  assert.equal(CHECKPOINT_LIMIT, 6000);
  assert.throws(() => parseThreadCheckpoint({ ...base, content: 'x'.repeat(6001) }), (e: any) => e.status === 413 && e.code === 'checkpoint_too_large');
});

test('channel cursors round-trip and reject tampering', () => {
  const cursor = { as_of: '2026-11-11 10:00:00.123456+00', created_at: '2026-11-10 09:00:00.5+00', thread_id: randomUUID() };
  assert.deepEqual(parseChannelCursor(encodeChannelCursor(cursor)), cursor);
  for (const bad of ['', 'not-base64!', Buffer.from('{"as_of":1}').toString('base64url'), encodeChannelCursor({ ...cursor, thread_id: 'x' })]) {
    assert.throws(() => parseChannelCursor(bad), (e: any) => e.code === 'invalid_memory_cursor');
  }
});
