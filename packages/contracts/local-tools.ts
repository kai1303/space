import {AppError, record, text, uuid} from './validation.js';

export const CODING_TURN_TIMEOUT_MS = 30 * 60 * 1000;
export type ToolApprovalDecision = 'allow' | 'deny';
export interface LocalToolApprovalInput {
  id: string;
  kind: 'project' | 'command' | 'file_change' | 'permissions';
  title: string;
  details: string;
}
export interface LocalToolApproval extends LocalToolApprovalInput {
  session_id: string; task_id: string; execution_id: string;
  status: 'pending' | 'allow' | 'deny' | 'cancelled';
  created_at: string; resolved_at: string | null; consumed_at?: string | null;
}
export function parseLocalToolApproval(raw: unknown): LocalToolApprovalInput {
  const v = record(raw, ['id','kind','title','details']);
  if (!['project','command','file_change','permissions'].includes(v.kind as string)) throw new AppError(400,'invalid_tool_approval');
  return {id:uuid(v.id),kind:v.kind as LocalToolApprovalInput['kind'],title:text(v.title,200),details:text(v.details,8000)};
}
export function parseToolApprovalDecision(raw: unknown): ToolApprovalDecision {
  const v = record(raw, ['decision']);
  if (v.decision !== 'allow' && v.decision !== 'deny') throw new AppError(400,'invalid_tool_decision');
  return v.decision;
}
