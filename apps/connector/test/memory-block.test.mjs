import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentProgress } from '../dist/agent-progress.js';
import { memoryInstructions } from '../dist/memory-instructions.js';

const block = '<space-memory>{"thread":{"base_revision":1,"summary":"Fixed","content":"# Done\\nFixed"}}</space-memory>';

test('progress snapshots hide the block and attach memory only when terminal', () => {
  const progress = new AgentProgress();
  const streaming = progress.snapshot([{ id: 'm', text: 'Fixed it.\n<space-mem', status: 'streaming' }], false);
  assert.equal(streaming.messages[0].text, 'Fixed it.\n');
  assert.equal(streaming.memory, undefined);
  const final = progress.snapshot([{ id: 'm', text: `Fixed it.\n${block}`, status: 'complete' }], true);
  assert.equal(final.messages[0].text, 'Fixed it.');
  assert.equal(final.memory.thread.summary, 'Fixed');
});

test('instructions name the base revisions from the supplied context', () => {
  const text = memoryInstructions({ thread_id: 't', messages: [], working_memory: { memory: { revision: 3 } }, agent_session_memory: { memory: null } });
  assert.match(text, /<space-memory>/);
  assert.match(text, /thread base_revision 3/);
  assert.match(text, /session base_revision 0/);
  assert.equal(memoryInstructions(undefined), '');
});

test('instructions describe notes only when knowledge_notes is supplied', () => {
  const base = { thread_id: 't', messages: [], working_memory: { memory: null } };
  assert.doesNotMatch(memoryInstructions(base), /"notes"/);
  const text = memoryInstructions({ ...base, knowledge_notes: { channel_id: 'c', notes: [{ title: 'Duplicate charge fix' }], truncated: true } });
  assert.match(text, /"notes":\[/);
  assert.match(text, /At most 3 notes/);
  assert.match(text, /Reuse a title/);
  assert.match(text, /search knowledge first/);
});

test('notes in the block stay hidden from people', () => {
  const progress = new AgentProgress();
  const block = '<space-memory>{"notes":[{"kind":"fact","title":"T","content":"C"}]}</space-memory>';
  const final = progress.snapshot([{ id: 'm', text: `Answer.\n${block}`, status: 'complete' }], true);
  assert.equal(final.messages[0].text, 'Answer.');
  assert.equal(final.memory.notes[0].title, 'T');
});
