import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseProfileInput, parseWorkspaceInput, parseRoleInput, parseMemberInput, parsePage } from '@space/contracts';

test('workspace contracts reject malformed profiles, roles, members and cursors', () => {
  assert.deepEqual(parseProfileInput({ display_name: ' Kai ' }), { display_name: 'Kai' });
  assert.deepEqual(parseWorkspaceInput({ name: ' Space ' }), { name: 'Space' });
  assert.deepEqual(parsePage({}), { limit: 50 });
  for (const input of [{}, { display_name: '' }, { display_name: '\0' }, { display_name: 42 }, { display_name: 'Kai', role: 'owner' }]) {
    assert.throws(() => parseProfileInput(input), { status: 400 });
  }
  for (const role of ['superadmin', null, {}, 1]) assert.throws(() => parseRoleInput({ role }), { status: 400 });
  assert.throws(() => parseMemberInput({ user_id: randomUUID(), role: 'member', active: true }), { status: 400 });
  for (const limit of ['0', '-1', '101', '1.5', '1e2', ['10'], 10]) assert.throws(() => parsePage({ limit }), { status: 400 });
  assert.throws(() => parsePage({ after: 'bad' }), { status: 400 });
});

test('workspace names are strict and cannot include organization ancestry', () => {
  for (const input of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(101) }, { name: 42 }, { name: 'Space', organization_id: randomUUID() }]) {
    assert.throws(() => parseWorkspaceInput(input), { status: 400 });
  }
});
