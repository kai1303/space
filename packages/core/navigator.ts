import { AppError, record, text } from '@space/contracts';
import type { NavigationContext, NavigationDecision, NavigationTask, NavigatorCandidate } from '@space/contracts';

function invalid(): never { throw new AppError(400, 'invalid_navigation_decision'); }
function strings(value: unknown, max: number, allowed?: Set<string>): string[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  const result = value.map(item => text(item, 200));
  if (new Set(result).size !== result.length || (allowed && result.some(item => !allowed.has(item)))) return invalid();
  return result;
}

export function parseNavigationDecision(value: unknown, context: NavigationContext): NavigationDecision {
  const v = record(value, ['action', 'capabilities', 'evidenceMessageIds', 'reason', 'tasks', 'assessment']);
  if (context.candidates.length > 100 || !['ignore', 'suggest', 'clarify', 'escalate'].includes(v.action as string)) return invalid();
  const capabilities = strings(v.capabilities, 8, new Set(context.candidates.map(c => c.skill)));
  const evidenceMessageIds = strings(v.evidenceMessageIds, 32, new Set(context.messages.map(m => m.id)));
  if(v.action==='suggest'&&context.pendingMessageIds&&!evidenceMessageIds.some(id=>context.pendingMessageIds!.includes(id)))return invalid();
  const reason = text(v.reason, 1000);
  if ((v.action === 'ignore' && capabilities.length) || (v.action === 'suggest' && (!capabilities.length || !evidenceMessageIds.length))) return invalid();
  const result: NavigationDecision = { action: v.action as NavigationDecision['action'], capabilities, evidenceMessageIds, reason };
  if(v.assessment!==undefined){
    const a=record(v.assessment,['model','targetMessageId','requestsAgentWork','assistanceUseful','needsDeeperReasoning','capabilityRelevance']);
    const targetMessageId=text(a.targetMessageId,200);
    if(targetMessageId!==(context.pendingMessageIds?.at(-1)??context.messages.at(-1)?.id))return invalid();
    const probability=(value:unknown):number=>{if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1)return invalid();return value;};
    const relevance=record(a.capabilityRelevance,context.candidates.map(c=>c.skill));
    result.assessment={model:text(a.model,200),targetMessageId,requestsAgentWork:probability(a.requestsAgentWork),assistanceUseful:probability(a.assistanceUseful),needsDeeperReasoning:probability(a.needsDeeperReasoning),capabilityRelevance:Object.fromEntries(Object.entries(relevance).map(([id,p])=>[id,probability(p)]))};
  }
  if (v.tasks !== undefined) {
    if (v.action !== 'suggest' || !Array.isArray(v.tasks) || v.tasks.length < 1 || v.tasks.length > 8) return invalid();
    const tasks: NavigationTask[] = v.tasks.map(item => {
      const task = record(item, ['id', 'title', 'capabilities', 'dependsOn']);
      const skills = strings(task.capabilities, 8, new Set(capabilities));
      if (!skills.length) return invalid();
      return { id: text(task.id, 80), title: text(task.title, 200), capabilities: skills, dependsOn: strings(task.dependsOn, 8) };
    });
    const byId = new Map(tasks.map(task => [task.id, task]));
    if (byId.size !== tasks.length) return invalid();
    const active = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (active.has(id) || !byId.has(id)) return invalid();
      if (visited.has(id)) return;
      active.add(id);
      for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
      active.delete(id);
      visited.add(id);
    };
    for (const task of tasks) visit(task.id);
    result.tasks = tasks;
  }
  return result;
}

// Mentions and rules use visible prose, so quoted or code examples cannot route a message.
function prose(value: string): string {
  let fence: string | undefined;
  const visible = value.split('\n').map(line => {
    if (/^\s*>/.test(line)) return '';
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      return '';
    }
    if (fence) return '';
    return line;
  }).join('\n');
  let inline: number | undefined;
  return visible.split(/(`+)/).map(part => {
    if (/^`+$/.test(part)) {
      if (inline === undefined) inline = part.length;
      else if (inline === part.length) inline = undefined;
      return '';
    }
    return inline === undefined ? part : '';
  }).join('');
}
function slug(value: string): string { return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

export function matchAgentMentions(value: string, candidates: NavigatorCandidate[]): { mentioned: boolean; candidates: NavigatorCandidate[] } {
  const tokens = [...prose(value).matchAll(/(?:^|[\s([{"'])@([a-z0-9][a-z0-9_-]*)(?![a-z0-9_-])/gi)].map(match => match[1]!.toLowerCase());
  const matches = new Set<NavigatorCandidate>();
  for (const token of tokens) {
    const canonical = /^agent-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(token);
    const eligible = candidates.filter(candidate => canonical ? candidate.installation_id.toLowerCase() === canonical[1] : slug(candidate.name) === token);
    if (new Set(eligible.map(candidate => candidate.installation_id)).size === 1) for (const candidate of eligible) matches.add(candidate);
  }
  return { mentioned: tokens.length > 0, candidates: candidates.filter(candidate => matches.has(candidate)) };
}

export function rulesDecision(context: NavigationContext): NavigationDecision {
  const allowed = new Set(context.candidates.map(candidate => candidate.skill));
  const capabilities = new Set<string>();
  const evidence = new Set<string>();
  for (const message of context.messages) {
    const content = prose(message.text).toLocaleLowerCase();
    for (const rule of context.rules) {
      if (!allowed.has(rule.skill) || (capabilities.size >= 8 && !capabilities.has(rule.skill))) continue;
      const matched = rule.keywords.some(keyword => {
        const literal = keyword.trim().toLocaleLowerCase();
        if (!literal) return false;
        const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, 'u').test(content);
      });
      if (matched) { capabilities.add(rule.skill); if (evidence.size < 32) evidence.add(message.id); }
    }
  }
  return parseNavigationDecision({ action: capabilities.size ? 'suggest' : 'ignore', capabilities: [...capabilities], evidenceMessageIds: [...evidence], reason: capabilities.size ? 'Configured keywords match available capabilities.' : 'No configured rule matched.' }, context);
}
