export interface NavigatorCandidate { persistent_sessions?: boolean; installation_id: string; name: string; skill: string; description: string }
export interface NavigatorRule { skill: string; keywords: string[] }
export interface NavigationTask { id: string; title: string; capabilities: string[]; dependsOn: string[] }
interface AssessmentBase {
  model:string; targetMessageId:string; requestsAgentWork:number; capabilityRelevance:Record<string,number>;
}
export type NavigationAssessment = AssessmentBase & (
  | {version:'execution-intent-v1';workStateHash:string;taskClear:number;continuesExistingWork:number}
  | {version?:never;assistanceUseful:number;needsDeeperReasoning:number}
);
export interface NavigationWorkState {
  pendingProposals:{id:string;goal:string;capabilities:string[]}[];
  tasks:{id:string;goal:string;skill:string;status:string}[];
  sessions:{id:string;title:string;skill:string;state:string;installation_id?:string;revision?:number;created_by?:string}[];
}
export interface NavigationDecision {
  assessment?:NavigationAssessment;
  action: 'ignore' | 'suggest' | 'clarify' | 'escalate' | 'continue' | 'stop' | 'read_context';
  targetSessionId?: string;
  readMessageIds?: string[];
  capabilities: string[];
  evidenceMessageIds: string[];
  reason: string;
  tasks?: NavigationTask[];
}
export interface NavigationContext {
  workState?: NavigationWorkState;
  retrievedMessages?: {id:string;text:string;truncated?:boolean}[];
  workingMemory?: Pick<import('./thread-context.js').ThreadContext, 'root' | 'checkpoint'>;
  pendingMessageIds?: string[];
  messages: { id: string; text: string; truncated?:boolean; author?:{id:string;kind:'human'|'agent';name?:string} }[];
  candidates: NavigatorCandidate[];
  rules: NavigatorRule[];
}
export interface NavigatorResult { decision: NavigationDecision; inputTokens: number; outputTokens: number }
export interface NavigatorProvider {
  readonly name: string;
  readonly model: string;
  readonly maxOutputTokens: number;
  estimateTokens?(context:NavigationContext,level:1|2):number;
  decide(context: NavigationContext, level: 1 | 2, signal: AbortSignal): Promise<NavigatorResult>;
}
