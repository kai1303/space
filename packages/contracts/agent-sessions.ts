import { parseRichDocument } from './rich-text.js';
import type { AgentResponse, AgentSession, AgentSessionOutputs, Task } from './index.js';
import { AppError, record, text, uuid } from './validation.js';
export interface AgentSessionSummary extends AgentSession {
  title: string; state: 'active' | 'ended'; managed: boolean; agent_name: string; owner_id: string;
  created_by: string | null; created_at: string; skill: string; turn_count: number;
}
export interface WorkspaceAgentSession extends AgentSessionSummary { working: boolean; channel_id: string; channel_archived: boolean }
export type AgentSessionReference = Pick<WorkspaceAgentSession, 'id' | 'agent_name' | 'origin_thread_id' | 'channel_id' | 'channel_archived'>;
export interface StarredAgentSession { id: string; name: string; kind: 'agent_session'; working: boolean; can_rename: boolean; private: boolean; session: AgentSessionReference }
export interface AgentSessionTurn { task: Task; created_at: string; requester_name: string; response?: AgentResponse; detail: string }
export interface AgentSessionDetail { audience?: string; tool_approvals?: import('./local-tools.js').LocalToolApproval[]; context?: import('./sidekick.js').SidekickContext; outputs?: AgentSessionOutputs; session: AgentSessionSummary; turns: AgentSessionTurn[]; next_cursor: string | null; has_newer?: boolean }
export function parseAgentSessionInput(value: unknown) {
  const v = record(value, ['client_session_id', 'installation_id', 'title', 'skill']);
  return { skill: v.skill === undefined ? undefined : text(v.skill, 80), client_session_id: uuid(v.client_session_id), installation_id: uuid(v.installation_id), title: text(v.title, 160) };
}
export function parseAgentSessionMessage(value: unknown) {
  const v = record(value, ['text', 'document']);
  const content = text(v.text, 4000);
  const document = v.document === undefined ? undefined : parseRichDocument(v.document);
  if (document && document.ops.map(op => op.insert).join('').trim() !== content.trim()) throw new AppError(400, 'invalid_document');
  return { text: content, ...(document ? { document } : {}) };
}
