import type { AgentSessionOutputs, AgentSessionView } from './agent-response.js';

export type SharedSessionOutput =
  | { kind: 'view'; path: string; output: AgentSessionView }
  | { kind: 'file'; path: string; output: AgentSessionOutputs['files'][number] }
  | { kind: 'change'; path: string; output: AgentSessionOutputs['changes'][number] }
  | { kind: 'preview'; path: ''; output: NonNullable<AgentSessionOutputs['preview']> };
export interface SessionDiscussionMessage {
  sequence: string; author: string; body: string; created_at: string;
}
export interface SessionTeamView {
  title: string; workspace_id: string; viewer_id: string; workspace_visible:boolean; can_manage: boolean; writable: boolean;
  reviewers: {user_id: string; display_name: string}[];
  shared: SharedSessionOutput[];
  messages: SessionDiscussionMessage[];
  before: string | null;
}
