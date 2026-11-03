export interface NavigatorCandidate { installation_id: string; name: string; skill: string; description: string }
export interface NavigatorRule { skill: string; keywords: string[] }
export interface NavigationTask { id: string; title: string; capabilities: string[]; dependsOn: string[] }
export interface NavigationAssessment {
  model:string; targetMessageId:string; requestsAgentWork:number; assistanceUseful:number; needsDeeperReasoning:number; capabilityRelevance:Record<string,number>;
}
export interface NavigationDecision {
  assessment?:NavigationAssessment;
  action: 'ignore' | 'suggest' | 'clarify' | 'escalate';
  capabilities: string[];
  evidenceMessageIds: string[];
  reason: string;
  tasks?: NavigationTask[];
}
export interface NavigationContext {
  workingMemory?: Pick<import('./thread-context.js').ThreadContext, 'root' | 'checkpoint'>;
  pendingMessageIds?: string[];
  messages: { id: string; text: string; author?:{id:string;kind:'human'|'agent';name?:string} }[];
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
