import type { AgentSessionReference } from './agent-sessions.js';

export const sessionWorkStatusLabels = {
  needs_attention: 'Needs attention', active: 'Working', done: 'Done', inactive: 'Inactive', archived: 'Ended',
} as const;
export type SessionWorkStatus = keyof typeof sessionWorkStatusLabels;
export type SessionDiscoveryItem =
  | (AgentSessionReference & {access:'source'; title:string; status:SessionWorkStatus; channel_name:string; creator_name:string | null; sidebar_archived:boolean; sidebar_inactive?:boolean})
  | {access:'reviewer'; id:string; title:string};
export type SessionDiscoveryPage = {items:SessionDiscoveryItem[]; next_cursor:string | null};
