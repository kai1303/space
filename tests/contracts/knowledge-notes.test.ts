import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseNoteDraft, parseNotePatch, parseKnowledgeNotesContext, parseAgentMemoryUpdate, extractMemoryBlock, parseInvocation, parseKnowledgeSettings } from '@space/contracts';

const message = randomUUID();
const note = { kind: 'decision', title: ' Duplicate charge fix ', content: ' Dedupe on idempotency_key. ', message_ids: [message, message] };

test('note drafts trim text, dedupe evidence and reject bad input', () => {
  assert.deepEqual(parseNoteDraft(note), { kind: 'decision', title: 'Duplicate charge fix', content: 'Dedupe on idempotency_key.', message_ids: [message] });
  for (const bad of [{ ...note, kind: 'rumor' }, { ...note, title: 'x'.repeat(161) }, { ...note, content: ' ' }, { ...note, message_ids: [] }, { ...note, extra: 1 }]) {
    assert.throws(() => parseNoteDraft(bad), (e: any) => e.status === 400);
  }
});

test('note patches need at least one field', () => {
  assert.deepEqual(parseNotePatch({ title: 'New' }), { title: 'New' });
  assert.throws(() => parseNotePatch({}), (e: any) => e.code === 'invalid_note');
});

test('block notes are optional evidence, 2,000 characters, at most 3, and a bad one is dropped alone', () => {
  const update = parseAgentMemoryUpdate({ notes: [{ kind: 'fact', title: 'A', content: 'B' }, { kind: 'fact', title: 'C', content: 'x'.repeat(2001) }] });
  assert.deepEqual(update.notes, [{ kind: 'fact', title: 'A', content: 'B', message_ids: [] }]);
  const many = parseAgentMemoryUpdate({ thread: { base_revision: 0, summary: 's', content: 'c' }, notes: [1, 2, 3, 4].map(i => ({ kind: 'fact', title: `T${i}`, content: 'c' })) });
  assert.equal(many.notes, undefined, 'too many notes drops the list but keeps the memory');
  assert.equal(many.thread?.summary, 's');
  assert.throws(() => parseAgentMemoryUpdate({ notes: [{ kind: 'bad', title: 'A', content: 'B' }] }), (e: any) => e.code === 'invalid_memory_update');
  const block = '<space-memory>{"notes":[{"kind":"decision","title":"T","content":"C"}]}</space-memory>';
  assert.equal(extractMemoryBlock(`Done ${block}`)?.notes?.[0]?.title, 'T');
});

test('knowledge_notes context is bounded and accepted by parseInvocation', () => {
  const channel = randomUUID(), id = randomUUID();
  const context = { channel_id: channel, truncated: false, notes: [{ id, kind: 'decision', title: 'T', revision: 2, updated_at: '2026-11-11 10:00:00+00' }] };
  assert.deepEqual(parseKnowledgeNotesContext(context), context);
  assert.throws(() => parseKnowledgeNotesContext({ ...context, notes: Array(21).fill(context.notes[0]) }), (e: any) => e.code === 'invalid_knowledge_notes');
  const execution = randomUUID();
  const request = parseInvocation({ schema_version: '1.0', task_id: randomUUID(), execution_id: execution, session_id: randomUUID(), idempotency_key: execution, goal: 'g', skill: 's',
    context: { thread_id: randomUUID(), messages: [], knowledge_notes: context } });
  assert.equal(request.context?.knowledge_notes?.notes[0]?.title, 'T');
});

test('knowledge settings take one boolean', () => {
  assert.deepEqual(parseKnowledgeSettings({ enabled: true }), { enabled: true });
  assert.throws(() => parseKnowledgeSettings({ enabled: 'yes' }), (e: any) => e.code === 'invalid_knowledge_settings');
});
