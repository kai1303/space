import type { AgentSessionReference } from './agent-sessions.js';

export type SessionDiscoveryItem =
  | (AgentSessionReference & {access:'source'; title:string; channel_name:string; creator_name:string | null; sidebar_archived:boolean; sidebar_inactive?:boolean})
  | {access:'reviewer'; id:string; title:string};
export type SessionDiscoveryPage = {items:SessionDiscoveryItem[]; next_cursor:string | null};
