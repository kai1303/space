import type { SpawnOptionsWithoutStdio, ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentEvent, InvocationRequest, LocalToolApprovalInput, ToolApprovalDecision } from '@space/contracts';

export type SpawnAgent = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
export interface RuntimeControls { requestApproval(input: LocalToolApprovalInput, signal: AbortSignal): Promise<ToolApprovalDecision> }
export type InvokeAgent = (request: InvocationRequest, emit: (event: AgentEvent) => Promise<void>, signal: AbortSignal, controls?: RuntimeControls) => Promise<void>;
export interface AgentRuntime { stop(): void; alive(): boolean; invoke: InvokeAgent }
export class AgentSessionStopped extends Error {
  constructor() { super('Space stopped this agent session turn.'); this.name = 'AgentSessionStopped'; }
}
