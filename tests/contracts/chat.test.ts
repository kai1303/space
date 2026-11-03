import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseMessageInput } from '@space/contracts';

const document = { ops: [
  { insert: 'Guide', attributes: { bold: true, link: 'https://example.test/guide' } },
  { insert: '\nFirst item' }, { insert: '\n', attributes: { list: 'bullet' } },
  { insert: 'const ready = true;' }, { insert: '\n', attributes: { 'code-block': true } },
] };
const message = () => ({ client_message_id: randomUUID(), text: document.ops.map(op => op.insert).join('').trim(), document });
test('chat messages retain links, lists and code with matching plain text', () => {
  const input = message();
  assert.deepEqual(parseMessageInput(input), { ...input, thread_id: null });
});
test('plain-text messages retain the original request shape', () => {
  const input = { client_message_id: randomUUID(), text: 'Hello' };
  assert.deepEqual(parseMessageInput(input), { ...input, thread_id: null });
});
test('message documents reject unsafe links, embeds, unknown attributes and text mismatches', () => {
  for (const invalid of [
    { ops: [{ insert: 'Hello', attributes: { link: 'javascript:alert(1)' } }] },
    { ops: [{ insert: { image: 'https://example.test/image' } }] },
    { ops: [{ insert: 'Hello', attributes: { onclick: 'alert(1)' } }] },
    { ops: [{ insert: 'Hello', attributes: { list: 'checklist' } }] },
    { ops: [{ insert: 'Hello', attributes: { bold: 'true' } }] },
    { ops: [{ insert: 'Hello', retain: 4 }] },
    { ops: [{ insert: 'Other text' }] },
    { ops: [{ insert: 'Hello\0' }] },
    { ops: [] }, null,
  ]) assert.throws(() => parseMessageInput({ client_message_id: randomUUID(), text: 'Hello', document: invalid }));
});
test('message documents bound text operations and serialized formatting bytes', () => {
  for (const invalid of [
    { ops: [{ insert: 'x'.repeat(10002) }] },
    { ops: Array.from({ length: 20001 }, () => ({ insert: 'a' })) },
    { ops: Array.from({ length: 1000 }, () => ({ insert: 'a', attributes: { link: 'https://example.test/' + 'x'.repeat(100) } })) },
  ]) assert.throws(() => parseMessageInput({ client_message_id: randomUUID(), text: invalid.ops.map(op => op.insert).join(''), document: invalid }));
});
