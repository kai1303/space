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
  const text = memoryInstructions({ thread_id: 't', messages: [], working_memory: { checkpoint: { revision: 3 } }, agent_session_memory: { checkpoint: null } });
  assert.match(text, /<space-memory>/);
  assert.match(text, /thread base_revision 3/);
  assert.match(text, /session base_revision 0/);
  assert.equal(memoryInstructions(undefined), '');
});
