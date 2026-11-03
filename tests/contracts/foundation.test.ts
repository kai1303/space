import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseCapabilities, parseDefinitionInput, parseInstallationInput, parseGrantInput, parseInvocation, parseSession, parseExecution, parseAgentEvent } from '@space/contracts';

test('capabilities are descriptive, bounded and explicitly typed', () => {
  assert.deepEqual(parseCapabilities({ skills: ['research'], controls: {} }), { skills: ['research'], controls: {} });
  for (const value of [null, { skills: ['x', 'x'], controls: {} }, { skills: ['x'], controls: { active_steer: 'yes' } }, { skills: ['x'], controls: { execute_anything: true } }, { skills: Array(101).fill('x'), controls: {} }]) assert.throws(() => parseCapabilities(value));
  assert.throws(() => parseDefinitionInput({ name: 'Agent', capabilities: { skills: ['x'], controls: {} }, approved: true }));
});
test('install and grant requests cannot supply ownership or foreign authority fields', () => {
  const installation = { workspace_id: randomUUID(), definition_id: randomUUID(), connector_id: 'mock' };
  assert.deepEqual(parseInstallationInput(installation), installation);
  assert.throws(() => parseInstallationInput({ ...installation, owner_id: randomUUID() }));
  const grant = { channel_id: randomUUID(), skill: 'demo.echo' };
  assert.deepEqual(parseGrantInput(grant), grant);
  assert.throws(() => parseGrantInput({ ...grant, workspace_id: randomUUID() }));
});
test('invocations, sessions and executions have separate validated contracts', () => {
  const execution = { id: randomUUID(), task_id: randomUUID(), workspace_id: randomUUID(), installation_id: randomUUID(), session_id: randomUUID(), status: 'queued', last_sequence: 0 };
  assert.deepEqual(parseExecution(execution), execution);
  assert.throws(() => parseExecution({ ...execution, last_sequence: -1 }));
  assert.throws(() => parseExecution({ ...execution, status: 'approved' }));
  const session = { id: execution.session_id, workspace_id: execution.workspace_id, installation_id: execution.installation_id, origin_thread_id: randomUUID() };
  assert.deepEqual(parseSession(session), session);
  const invocation = { schema_version: '1.0', task_id: execution.task_id, execution_id: execution.id, session_id: session.id, idempotency_key: execution.id, goal: 'Review', skill: 'demo.echo' };
  assert.deepEqual(parseInvocation(invocation), invocation);
  assert.throws(() => parseInvocation({ ...invocation, schema_version: '2.0' }));
  assert.throws(() => parseInvocation({ ...invocation, idempotency_key: randomUUID() }));
});
test('event timestamps reject calendar dates normalized by Date.parse', () => {
  assert.throws(() => parseAgentEvent({ id: randomUUID(), schema_version: '1.0', execution_id: randomUUID(), sequence: 1, type: 'execution.started', occurred_at: '2026-02-30T00:00:00.000Z', payload: { text: 'Hello' } }));
});
