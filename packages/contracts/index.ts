export * from './local-tools.js';
export * from './sidekick.js';
export * from './calling.js';
import type { RichDocument } from './rich-text.js';
import { AppError, record, text, uuid } from './validation.js';
import { parseAgentResponse, type AgentResponse } from './agent-response.js';
export * from './agent-response.js';
export * from './agent-sessions.js';
export { AppError, record, text, uuid } from './validation.js';
export * from './foundation.js';
export * from './workspace.js';
export * from './profile.js';
export * from './chat.js';
export * from './rich-text.js';
export * from './assets.js';
export * from './memory.js';
export * from './thread-context.js';
import type { ThreadContext } from './thread-context.js';
export const SCHEMA_VERSION = '1.0' as const;
export type ControlFeature = 'active_steer' | 'queued_followup' | 'cancel' | 'pause' | 'resume' | 'progress_stream' | 'input_request';
export interface AgentCapabilities { persistent_sessions?: boolean; skills: string[]; controls: Partial<Record<ControlFeature, boolean>> }
export interface AgentDefinition { id: string; name: string; capabilities: AgentCapabilities }
export interface AgentInstallation { id: string; workspace_id: string; owner_id: string; definition_id: string; connector_id: string; enabled: boolean; capabilities: AgentCapabilities }
export interface AgentSession { id: string; workspace_id: string; installation_id: string; origin_thread_id: string }
export type TaskStatus = 'awaiting_approval' | 'queued' | 'running' | 'completed' | 'failed' | 'rejected';
export interface TaskInput { workspace_id: string; thread_id: string; installation_id: string; goal: string; skill: string }
export interface Task extends TaskInput { request_document?: RichDocument | null; id: string; requester_id: string; approved_by: string | null; status: TaskStatus; session_id: string | null; active_execution_id: string | null; revision: number; result: string | null }
export interface Execution { id: string; task_id: string; workspace_id: string; installation_id: string; session_id: string; status: 'queued' | 'running' | 'completed' | 'failed'; last_sequence: number }
export interface ControlCommand { id: string; execution_id: string; expected_revision: number; operation: 'steer' | 'follow_up' | 'cancel' | 'pause' | 'resume'; status: 'created' | 'authorized' | 'queued' | 'delivered' | 'acknowledged' | 'applied' | 'rejected' | 'failed' | 'expired'; text?: string }
export type AgentEventType = 'execution.started' | 'execution.progress' | 'execution.completed' | 'execution.failed';
export interface AgentEvent { id: string; schema_version: '1.0'; execution_id: string; sequence: number; type: AgentEventType; occurred_at: string; payload: { text: string; response?: AgentResponse; session_ready?: true } }
export interface WorkplaceEvent { id: string; schema_version: '1.0'; type: string; workspace_id: string; actor_id: string; resource_id: string; correlation_id: string; causation_id: string | null; sequence: number; occurred_at: string; payload: Record<string, unknown> }
export interface InvocationRequest { outbound?: import('./outbound.js').OutboundAccess; persistent_session?: { resume: boolean }; schema_version: typeof SCHEMA_VERSION; task_id: string; execution_id: string; session_id: string; idempotency_key: string; goal: string; skill: string; context?: {handoff?:import('./sidekick.js').SidekickContext;channel_memory?:import('./memory.js').AgentMemoryContext;working_memory?:ThreadContext;thread_id:string;messages:{id:string;text:string;author_type:'human'|'agent'|'app'|'workflow'}[]} }
export interface InvocationReceipt { external_execution_id: string; status: 'completed' }
// Invoke resolves only after terminal events are accepted in Increment A. Async receipt/status
// transports will extend this contract after local/cloud conformance in Increment B.
export interface AgentConnector {
  readonly id: string;
  discover(): Promise<AgentCapabilities>;
  invoke(request: InvocationRequest, emit: (event: unknown) => Promise<void>, signal: AbortSignal): Promise<InvocationReceipt>;
}
export function parseTaskInput(value: unknown): TaskInput {
  const v = record(value, ['workspace_id', 'thread_id', 'installation_id', 'goal', 'skill']);
  return { workspace_id: uuid(v.workspace_id), thread_id: uuid(v.thread_id), installation_id: uuid(v.installation_id), goal: text(v.goal), skill: text(v.skill, 80) };
}
export function parseAgentEvent(value: unknown): AgentEvent {
  const v = record(value, ['id', 'schema_version', 'execution_id', 'sequence', 'type', 'occurred_at', 'payload']);
  if (v.schema_version !== '1.0' || !Number.isSafeInteger(v.sequence) || (v.sequence as number) < 1 || !['execution.started', 'execution.progress', 'execution.completed', 'execution.failed'].includes(v.type as string)) throw new AppError(400, 'invalid_event');
  const occurred_at = text(v.occurred_at, 30);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(occurred_at) || (!Number.isFinite(Date.parse(occurred_at)) || new Date(occurred_at).toISOString() !== occurred_at)) throw new AppError(400, 'invalid_timestamp');
  const payload = record(v.payload, ['text', 'response', 'session_ready']);
  if (payload.session_ready !== undefined && (payload.session_ready !== true || v.type !== 'execution.progress')) throw new AppError(400, 'invalid_session_ready');
  return { id: uuid(v.id), schema_version: '1.0', execution_id: uuid(v.execution_id), sequence: v.sequence as number, type: v.type as AgentEventType, occurred_at, payload: { ...(payload.session_ready === true ? { session_ready: true as const } : {}), text: text(payload.text, 16000), ...(payload.response === undefined ? {} : { response: parseAgentResponse(payload.response) }) } };
}
const transitions: Record<TaskStatus, TaskStatus[]> = { awaiting_approval: ['queued', 'rejected'], queued: ['running', 'failed'], running: ['completed', 'failed'], completed: [], failed: [], rejected: [] };
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!transitions[from]?.includes(to)) throw new AppError(409, 'invalid_transition');
}

export * from './agent-connection.js';
export * from './navigator.js';

export * from './mentions.js';

export * from './typing.js';

export * from './notifications.js';

export * from './workspace-hub.js';
export * from './todo-sync.js';

export * from './workspace-settings.js';

export * from './workspace-invitations.js';

export * from "./outbound.js";
export * from './huddles.js';

export * from './channel-permissions.js';
