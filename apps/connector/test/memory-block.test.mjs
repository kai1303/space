import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentProgress } from '../dist/agent-progress.js';
import { memoryInstructions } from '../dist/memory-instructions.js';

const block = '<space-memory>{"notes":[{"kind":"fact","title":"T","content":"C"}]}</space-memory>';

test('progress snapshots hide the block and attach knowledge only when terminal', () => {
  const progress = new AgentProgress();
  const streaming = progress.snapshot([{ id: 'm', text: 'Fixed it.\n<space-mem', status: 'streaming' }], false);
  assert.equal(streaming.messages[0].text, 'Fixed it.\n');
  assert.equal(streaming.memory, undefined);
  const final = progress.snapshot([{ id: 'm', text: `Fixed it.\n${block}`, status: 'complete' }], true);
  assert.equal(final.messages[0].text, 'Fixed it.');
  assert.equal(final.memory.notes[0].title, 'T');
});

test('a block with only the retired thread or session part saves nothing', () => {
  const progress = new AgentProgress();
  const old = '<space-memory>{"thread":{"base_revision":1,"summary":"Fixed","content":"# Done"}}</space-memory>';
  const final = progress.snapshot([{ id: 'm', text: `Fixed it.\n${old}`, status: 'complete' }], true);
  assert.equal(final.messages[0].text, 'Fixed it.');
  assert.equal(final.memory, undefined);
});

test('agents are asked for nothing unless knowledge notes are on', () => {
  const base = { thread_id: 't', messages: [] };
  assert.equal(memoryInstructions(undefined), '');
  assert.equal(memoryInstructions(base), '');
  assert.doesNotMatch(memoryInstructions({ ...base, working_memory: {} }), /base_revision/);
});

test('instructions describe notes when knowledge_notes is supplied', () => {
  const base = { thread_id: 't', messages: [] };
  const text = memoryInstructions({ ...base, knowledge_notes: { channel_id: 'c', notes: [{ title: 'Duplicate charge fix' }], truncated: true } });
  assert.match(text, /<space-memory>/);
  assert.match(text, /"notes":\[/);
  assert.match(text, /At most 3 notes/);
  assert.match(text, /Reuse a title/);
  assert.match(text, /search knowledge first/);
  assert.doesNotMatch(text, /base_revision|"thread"|"session"/);
});
