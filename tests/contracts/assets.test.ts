import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as contracts from '@space/contracts';
import { parseAssetInput, parseMessageInput } from '@space/contracts';

test('asset upload contract bounds names, sizes and MIME metadata', () => {
  const parse = parseAssetInput;
  assert.equal(typeof parse, 'function');
  assert.deepEqual(parse({ name: 'report.pdf', size: 12, type: 'application/pdf' }), { name: 'report.pdf', size: 12, type: 'application/pdf' });
  for (const input of [
    { name: '../secret', size: 1, type: 'text/plain' }, { name: 'bad\r\nname', size: 1, type: 'text/plain' },
    { name: 'x', size: 0, type: 'text/plain' }, { name: 'x', size: 26214401, type: 'text/plain' },
    { name: 'x', size: 1.5, type: 'text/plain' }, { name: 'x', size: 1, type: 'text/plain\r\nx: y' },
    { name: 'x', size: 1, type: 'text/plain', object_key: 'outside' },
  ]) assert.throws(() => parse(input));
});
test('messages accept up to five unique asset IDs and attachment-only content', () => {
  const ids = [randomUUID(), randomUUID()];
  const input = { client_message_id: randomUUID(), text: '', asset_ids: ids };
  assert.deepEqual(parseMessageInput(input), { ...input, thread_id: null });
  assert.deepEqual(parseMessageInput({ ...input, text: 'File' }).asset_ids, ids);
  for (const asset_ids of [[ids[0], ids[0]], Array.from({ length: 6 }, () => randomUUID()), ['bad'], 'bad']) {
    assert.throws(() => parseMessageInput({ ...input, asset_ids }));
  }
  assert.throws(() => parseMessageInput({ ...input, asset_ids: [] }));
  assert.throws(() => parseMessageInput({ client_message_id: randomUUID(), text: '' }));
});


test('channel file queries validate literal search, known filters and bounded string pagination', () => {
  assert.equal(typeof contracts.parseAssetListQuery, 'function');
  const parse = contracts.parseAssetListQuery;
  assert.deepEqual(parse({}), { q: '', kind: 'all', sort: 'newest', limit: 30 });
  const after = randomUUID();
  assert.deepEqual(parse({ q: ' %_\\ ', kind: 'other', sort: 'oldest', limit: '100', after }), { q: ' %_\\ ', kind: 'other', sort: 'oldest', limit: 100, after });
  assert.equal(parse({ q: '', limit: '1' }).limit, 1);
  for (const input of [null, [], { unexpected: 'yes' }, { q: 'x'.repeat(256) }, { q: 2 }, { q: null }, { kind: null }, { sort: null }, { limit: null }, { q: 'bad\0' }, { q: ['x'] }, { kind: 'unsupported' }, { kind: ['image'] }, { sort: 'recent' }, { after: 'bad' }, { limit: 30 }, { limit: '0' }, { limit: '101' }, { limit: '01' }, { limit: '1.5' }, { limit: '1e2' }, { limit: ['1'] }]) assert.throws(() => parse(input));
});
