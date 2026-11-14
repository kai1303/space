import assert from 'node:assert/strict';
import test from 'node:test';
import { searchAttachments } from './attachment-search.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = { connectionId: id(1), workspaceId: id(2), requesterId: id(3), audience: { channelId: id(4) } };
const attachment = {
  id: id(5), workspace_id: context.workspaceId, channel_id: id(6), thread_id: id(7),
  message_id: id(8), name: 'launch-brief.pdf', type: 'application/pdf', size: 128,
};

function search(ranked, visible, limit = 10) {
  return searchAttachments({ async query(_sql, args) {
    assert.deepEqual(args, [context.workspaceId, 'launch-brief', Math.min(100, limit * 4)]);
    return { rows: ranked };
  } }, { async query(_sql, args) {
    assert.deepEqual(args, [context.workspaceId, context.requesterId, context.audience.channelId, ranked.map(row => row.id)]);
    return { rows: visible };
  } }, context, 'launch-brief', limit);
}

test('returns authorized attachment metadata with a stable ref and the asset download URL', async () => {
  const hidden = { ...attachment, id: id(9) };
  const hits = await search([hidden, attachment], [attachment], 1);
  assert.equal(hits.length, 1);
  const [hit] = hits;
  assert.deepEqual(hit.ref, { connectionId: context.connectionId, recordId: 'attachment/' + attachment.id });
  assert.equal(hit.title, attachment.name);
  assert.deepEqual(hit.citation, { label: attachment.name, url: '/v1/assets/' + attachment.id + '/download' });
  assert.match(hit.evidence, /application\/pdf/);
  assert.match(hit.evidence, /128 bytes/);
});

test('drops stale metadata, changed ownership and revoked attachments', async () => {
  for (const [field, changed] of Object.entries({
    workspace_id: id(10), channel_id: id(11), thread_id: id(12), message_id: id(13),
    name: 'renamed.pdf', type: 'text/plain', size: 256,
  })) {
    assert.deepEqual(await search([attachment], [{ ...attachment, [field]: changed }], 50), [], field);
  }
  assert.deepEqual(await search([attachment], []), []);
});

test('keeps ranked order and caps the number of visible hits', async () => {
  const another = { ...attachment, id: id(9) };
  const hits = await search([attachment, another], [another, attachment], 1);
  assert.deepEqual(hits.map(hit => hit.ref.recordId), ['attachment/' + attachment.id]);
});
