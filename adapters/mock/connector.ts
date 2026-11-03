import { createHash } from 'node:crypto';
import { parseInvocation } from '@space/contracts';
import type { AgentConnector, AgentEvent, InvocationRequest, InvocationReceipt } from '@space/contracts';
function stableId(executionId: string, sequence: number): string {
  if (sequence === 1) return executionId;
  const hex = createHash('sha256').update(`${executionId}:${sequence}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export class MockConnector implements AgentConnector {
  readonly id = 'mock';
  async discover() { return { skills: ['demo.echo'], controls: { progress_stream: true, active_steer: false, queued_followup: false, cancel: false } }; }
  async invoke(request: InvocationRequest, emit: (event: unknown) => Promise<void>, signal: AbortSignal): Promise<InvocationReceipt> {
    request = parseInvocation(request);
    const events: [AgentEvent['type'], string][] = [['execution.started', 'Working'], ['execution.progress', 'Preparing a mock result'], ['execution.completed', `Mock result: ${request.goal}`]];
    for (const [index, [type, text]] of events.entries()) {
      signal.throwIfAborted();
      // The mock has no external side effects. Stable envelopes replay after any restart.
      await emit({ id: stableId(request.execution_id, index + 1), schema_version: '1.0', execution_id: request.execution_id, sequence: index + 1, type, occurred_at: '2026-11-03T00:00:00.000Z', payload: { text } });
    }
    return { external_execution_id: request.execution_id, status: 'completed' };
  }
}
