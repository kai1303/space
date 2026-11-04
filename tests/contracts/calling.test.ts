import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseCallStart, parseCallSignal } from '@space/contracts';

test('calls accept only explicit audio/video modes and valid identifiers', () => {
  const value = { id: randomUUID(), channel_id: randomUUID(), device_id: randomUUID(), mode: 'video' };
  assert.deepEqual(parseCallStart(value), value);
  for (const mode of ['screen', '', undefined]) assert.throws(() => parseCallStart({...value, mode}));
  assert.throws(() => parseCallStart({...value, caller_id: randomUUID()}));
});
test('signaling validates descriptions and bounds candidate payloads', () => {
  const base = { call_id: randomUUID(), generation: randomUUID() };
  assert.equal(parseCallSignal({...base, description: {type:'offer',sdp:'v=0\r\n'}}).description?.type,'offer');
  assert.throws(() => parseCallSignal({...base, description: {type:'rollback',sdp:'v=0'}}));
  assert.throws(() => parseCallSignal({...base, description: {type:'offer',sdp:'x'.repeat(32769)}}));
  assert.throws(() => parseCallSignal({...base, candidate: {candidate:'x'.repeat(2049)}}));
  assert.throws(() => parseCallSignal({...base, description:{type:'offer',sdp:'v=0'},candidate:{candidate:'x'}}));
  assert.throws(() => parseCallSignal({...base, candidate:{candidate:'x',sdpMLineIndex:-1}}));
});
