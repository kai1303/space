import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseInvitationInput, invitationToken } from '@space/contracts';

test('invitations default to members and normalize email, without accepting ownership or authority fields', () => {
  const input = { request_id: randomUUID(), email: '  Ada@Example.test ' };
  assert.equal(parseInvitationInput(input).email, 'ada@example.test');
  assert.equal(parseInvitationInput(input).role, 'member');
  for (const extra of [{ role: 'owner' }, { created_by: randomUUID() }, { use_limit: 2 }, { expires_in_days: 31 }]) assert.throws(() => parseInvitationInput({ ...input, ...extra }));
});
test('guest invitations require bounded channel assignments and cannot grant administrator access', () => {
  const input = { request_id: randomUUID(), kind: 'link', guest_type: 'single', channel_ids: [randomUUID()] };
  assert.equal(parseInvitationInput(input).guest_type, 'single');
  for (const extra of [{ channel_ids: [] }, { channel_ids: [randomUUID(), randomUUID()] }, { role: 'admin' }, { use_limit: 1001 }]) assert.throws(() => parseInvitationInput({ ...input, ...extra }));
  assert.throws(() => invitationToken('short'));
  assert.equal(invitationToken('a'.repeat(43)), 'a'.repeat(43));
});
