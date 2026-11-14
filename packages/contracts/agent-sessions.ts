import { parseGoalAction, type SessionGoal } from './session-goal.js';
import { sidekickPageUrl } from './sidekick.js';
import { parseCodexSettings } from './codex-settings.js';
import { parseAssetIds, parseAssetDescriptions } from './assets.js';
import { parseRichDocument } from './rich-text.js';
import type { AgentResponse, AgentSession, AgentSessionOutputs, Task } from './index.js';
import { projectToken, AppError, record, text, uuid } from './validation.js';
export interface AgentSessionSummary extends AgentSession {
  code_channel?: boolean; queue_paused?: boolean; supports_steering?: boolean; title: string; state: 'active' | 'ended'; managed: boolean; agent_name: string; owner_id: string;
  created_by: string | null; created_at: string; skill: string; turn_count: number;
}
export interface WorkspaceAgentSession extends AgentSessionSummary { sidebar_expires_at?:string; sidebar_expires_in_ms?:number; working: boolean; channel_id: string; channel_archived: boolean }
export type AgentSessionReference = Pick<WorkspaceAgentSession, 'id' | 'agent_name' | 'origin_thread_id' | 'channel_id' | 'channel_archived' | 'code_channel'>;
export interface StarredAgentSession { id: string; name: string; kind: 'agent_session'; working: boolean; can_rename: boolean; private: boolean; session: AgentSessionReference }
export interface AgentSessionTurn { steering?: SessionInput[]; task: Task; created_at: string; requester_name: string; response?: AgentResponse; detail: string }
export interface SessionInput {
  id:string; browser_url?:string|null; actor_id:string; actor_name?:string; created_at?:string; text:string; document?:import('./rich-text.js').RichDocument; kind:'queue'|'steer'; state:'pending'|'blocked'|'sent'|'cancelled'|'sending'|'uncertain';
  execution_id:string|null; detail:string|null; file_count?:number;
}
export type SessionRelatedAgent = { id:string; title:string; agent_name:string; owner_name:string; relation:'parent'|'helper' };
export interface SessionResourceMessage {
  id: string;
  author: string;
  created_at: string;
  files: import('./assets.js').AssetAttachment[];
  links: string[];
}
export interface AgentSessionDetail { final_summary?: { task_id:string; excerpt:string }; related_agents?: SessionRelatedAgent[]; session_goal?: SessionGoal | null; inputs?:SessionInput[]; audience?: string; tool_approvals?: import('./local-tools.js').LocalToolApproval[]; context?: import('./sidekick.js').SidekickContext; outputs?: AgentSessionOutputs; session: AgentSessionSummary; turns: AgentSessionTurn[]; next_cursor: string | null; has_newer?: boolean }
export function parseAgentSessionInput(value: unknown) {
  const v = record(value, ['client_session_id', 'installation_id', 'title', 'skill', 'project_token']);
  return { ...(v.project_token === undefined ? {} : { project_token: projectToken(v.project_token) }), skill: v.skill === undefined ? undefined : text(v.skill, 80), client_session_id: uuid(v.client_session_id), installation_id: uuid(v.installation_id), title: text(v.title, 160) };
}
export function parseAgentSessionMessage(value: unknown) {
  const v = record(value, ['text', 'document', 'asset_ids', 'asset_descriptions', 'codex_settings', 'goal_action', 'browser_url']);
  const asset_ids = v.asset_ids === undefined ? [] : parseAssetIds(v.asset_ids);
  const asset_descriptions = v.asset_descriptions === undefined ? undefined : parseAssetDescriptions(v.asset_descriptions, asset_ids);
  const content = asset_ids.length && v.text === '' ? '' : text(v.text, 4000);
  const document = v.document === undefined ? undefined : parseRichDocument(v.document);
  if (document && document.ops.map(op => op.insert).join('').trim() !== content.trim()) throw new AppError(400, 'invalid_document');
  return { asset_ids, asset_descriptions, text: content, ...(v.browser_url === undefined ? {} : {browser_url:sidekickPageUrl(v.browser_url)}), ...(v.goal_action === undefined ? {} : {goal_action:parseGoalAction(v.goal_action)}), ...(v.codex_settings === undefined ? {} : {codex_settings:parseCodexSettings(v.codex_settings)}), ...(document ? { document } : {}) };
}
