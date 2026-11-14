import type { SpawnOptionsWithoutStdio, ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentEvent, InvocationRequest, LocalToolApprovalInput, ToolApprovalDecision } from '@space/contracts';

export type SpawnAgent = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
export type SteerHandler = (id:string,text:string,goal?:import('@space/contracts').GoalAction)=>Promise<void>;
export interface RuntimeControls { onSessionTitle?:(title:string)=>void; setSteerHandler?:(handler:SteerHandler|null)=>void; requestApproval(input: LocalToolApprovalInput, signal: AbortSignal): Promise<ToolApprovalDecision> }
export type InvokeAgent = (request: InvocationRequest, emit: (event: AgentEvent) => Promise<void>, signal: AbortSignal, controls?: RuntimeControls) => Promise<void>;
export interface AgentRuntime { listModels?(): Promise<import('@space/contracts').AgentModel[]>; stop(): void; alive(): boolean; invoke: InvokeAgent }
export class AgentSessionStopped extends Error {
  constructor() { super('Space stopped this agent session turn.'); this.name = 'AgentSessionStopped'; }
}
