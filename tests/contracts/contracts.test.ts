import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseTaskInput, parseAgentEvent, assertTransition } from '@space/contracts';

test('task requests are bounded and cannot smuggle authority', () => {
  const input = { workspace_id: randomUUID(), thread_id: randomUUID(), installation_id: randomUUID(), goal: 'Review churn', skill: 'demo.echo' };
  assert.deepEqual(parseTaskInput(input), input);
  for (const bad of [{ ...input, approved_by: 'agent' }, { ...input, goal: ' ' }, { ...input, goal: 'x'.repeat(4001) }, { ...input, thread_id: 'bad' }, null]) {
    assert.throws(() => parseTaskInput(bad));
  }
});

test('agent events have versioned, typed, bounded payloads and sequence', () => {
  const event = { id: randomUUID(), schema_version: '1.0', execution_id: randomUUID(), sequence: 1, type: 'execution.completed', occurred_at: new Date().toISOString(), payload: { text: 'Done' } };
  assert.deepEqual(parseAgentEvent(event), event);
  for (const bad of [{ ...event, schema_version: '2' }, { ...event, sequence: 0 }, { ...event, type: 'task.approved' }, { ...event, payload: { text: 'ok', approved: true } }, { ...event, occurred_at: 'yesterday' }]) {
    assert.throws(() => parseAgentEvent(bad));
  }
});

test('terminal task states cannot be reopened', () => {
  assert.doesNotThrow(() => assertTransition('awaiting_approval', 'queued'));
  assert.doesNotThrow(() => assertTransition('running', 'completed'));
  assert.throws(() => assertTransition('completed', 'running'));
  assert.throws(() => assertTransition('awaiting_approval', 'completed'));
});
