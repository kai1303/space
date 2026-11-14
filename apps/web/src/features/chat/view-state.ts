import type { AgentSessionReference, SessionReport } from '@space/contracts';
export type CodeChannelLocation = AgentSessionReference & {fromDirectInbox?: boolean; artifact?: NonNullable<SessionReport['artifact']>};
export type ConversationView = { thread?: string; sessionView?: {thread:string;selected:string;artifactRequest?:number;artifact?:NonNullable<import('@space/contracts').SessionReport['artifact']>}; sessionOpen: boolean };
