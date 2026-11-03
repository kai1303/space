import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProfileUpdate, visibleStatus } from '@space/contracts';

test('profile updates validate partial fields without accepting account authority', () => {
  assert.deepEqual(parseProfileUpdate({ full_name: ' Kai Nguyen ', display_name: ' Kai ', title: '', time_zone: 'Asia/Ho_Chi_Minh', presence: 'away' }), { full_name: 'Kai Nguyen', display_name: 'Kai', title: '', time_zone: 'Asia/Ho_Chi_Minh', presence: 'away' });
  for (const input of [{}, { display_name: ' ' }, { email: 'other@example.com' }, { id: 'other' }, { title: 'x'.repeat(201) }, { time_zone: 'invalid/zone' }, { presence: 'online' }, { image: 'https://tracker.example/a.png' }, { image: 'data:image/svg+xml;base64,PHN2Zz4=' }]) assert.throws(() => parseProfileUpdate(input), { status: 400 });
  assert.deepEqual(parseProfileUpdate({ image: null, phone: '' }), { image: null, phone: '' });
});
test('status is atomic, bounded and has a valid future expiration or never clears', () => {
  const status = { text: 'Reviewing', emoji: '👀', expires_at: null };
  assert.deepEqual(parseProfileUpdate({ status }), { status });
  assert.deepEqual(parseProfileUpdate({ status: null }), { status: null });
  assert.equal(visibleStatus({ ...status, expires_at: '2026-11-03T10:00:00.000Z' }, Date.parse('2026-11-03T10:00:00.000Z')), null);
  assert.deepEqual(visibleStatus(status), status);
  for (const status of [{ text: 'x'.repeat(101), emoji: '', expires_at: null }, { text: 'x', emoji: '', expires_at: 'yesterday' }, { text: 'x', emoji: '', expires_at: '2020-01-01T00:00:00.000Z' }, { text: 'x', emoji: '', expires_at: null, user_id: 'other' }]) assert.throws(() => parseProfileUpdate({ status }), { status: 400 });
});
test('status accepts flags, keycaps and skin tones from the shared emoji picker', () => {
  for (const emoji of ['🇻🇳', '1️⃣', '👍🏽', '👨‍👩‍👧‍👦', '🏴󠁧󠁢󠁥󠁮󠁧󠁿']) assert.equal(parseProfileUpdate({status:{text:'',emoji,expires_at:null}}).status?.emoji, emoji);
  for (const emoji of ['a', '👍👀', 'abc👍', '1']) assert.throws(() => parseProfileUpdate({status:{text:'',emoji,expires_at:null}}),{status:400});
});
