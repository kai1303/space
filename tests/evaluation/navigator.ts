import type { NavigationContext, NavigationDecision, NavigatorProvider } from '@space/contracts';
import { parseNavigationDecision, rulesDecision } from '@space/core/navigator';

export interface NavigatorEvaluationCase {
  id: string;
  category: string;
  context: NavigationContext;
  expected: { actions: NavigationDecision['action'][]; capabilities: string[] };
}
interface Options {
  mode: 'rules' | 'level1';
  provider?: NavigatorProvider;
  maxReservedTokens?: number;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
}
interface EvaluationResult {
  id: string;
  category: string;
  expected: NavigatorEvaluationCase['expected'];
  status: 'completed' | 'error' | 'skipped';
  decision?: NavigationDecision;
  correct?: boolean;
  error?: 'budget_exhausted' | 'stopped_after_error' | 'provider_failed';
  latencyMs: number;
}
const ratio = (numerator: number, denominator: number) => denominator ? numerator / denominator : null;
const sameSkills = (actual: string[], expected: string[]) => actual.length === expected.length && expected.every(skill => actual.includes(skill));

export async function evaluateNavigator(cases: NavigatorEvaluationCase[], options: Options) {
  const budget = options.maxReservedTokens ?? 100_000;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 1_000_000) throw Error('Invalid reservation budget (1–1000000)');
  if (cases.length < 1 || cases.length > 100 || new Set(cases.map(item => item.id)).size !== cases.length) throw Error('Expected 1–100 uniquely identified cases');
  if (options.mode === 'level1' && !options.provider) throw Error('A configured Level 1 provider is required');
  for (const price of [options.inputUsdPerMillion, options.outputUsdPerMillion]) {
    if (price !== undefined && (!Number.isFinite(price) || price < 0)) throw Error('Invalid token price');
  }
  let calls = 0, reservedTokens = 0, inputTokens = 0, outputTokens = 0, stopped = false, unknownUsage = false;
  const results: EvaluationResult[] = [], latencies: number[] = [];
  for (const item of cases) {
    const row: EvaluationResult = { id: item.id, category: item.category, expected: item.expected, status: 'skipped', latencyMs: 0 };
    results.push(row);
    if (stopped) { row.error = 'stopped_after_error'; continue; }
    let started: number | undefined;
    try {
      let decision: NavigationDecision;
      if (options.mode === 'rules') {
        const pending = item.context.pendingMessageIds;
        decision = rulesDecision({ ...item.context, messages: item.context.messages.filter(message => !pending || pending.includes(message.id)) });
      } else {
        const provider = options.provider!;
        const reserve = provider.estimateTokens?.(item.context, 1) ?? Buffer.byteLength(JSON.stringify(item.context), 'utf8') + 3000 + provider.maxOutputTokens;
        if (!Number.isSafeInteger(reserve) || reserve < 1) throw Error('Invalid reservation');
        if (reservedTokens + reserve > budget) { row.error = 'budget_exhausted'; continue; }
        reservedTokens += reserve;
        calls++;
        started = performance.now();
        const response = await provider.decide(item.context, 1, AbortSignal.timeout(12_000));
        decision = parseNavigationDecision(response.decision, item.context);
        if (![response.inputTokens, response.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000)) throw Error('Invalid usage');
        inputTokens += response.inputTokens;
        outputTokens += response.outputTokens;
        // Compatible adapters use 0/0 when a provider omits usage; that is not proof of a free call.
        if (response.inputTokens + response.outputTokens === 0) unknownUsage = true;
      }
      row.status = 'completed';
      row.decision = decision;
      row.correct = item.expected.actions.includes(decision.action) && (decision.action !== 'suggest' || sameSkills(decision.capabilities, item.expected.capabilities));
    } catch {
      row.status = 'error';
      row.error = 'provider_failed';
      stopped = true;
    } finally {
      if (started !== undefined) { row.latencyMs = performance.now() - started; latencies.push(row.latencyMs); }
    }
  }
  const completed = results.filter(row => row.status === 'completed');
  const negatives = completed.filter(row => row.expected.actions.length === 1 && row.expected.actions[0] === 'ignore');
  const positives = completed.filter(row => !row.expected.actions.includes('ignore'));
  const skillCases = completed.filter(row => row.expected.actions.includes('suggest'));
  const falsePositives = negatives.filter(row => row.decision!.action !== 'ignore').length;
  const missedIntents = positives.filter(row => row.decision!.action === 'ignore').length;
  const capabilityMatches = skillCases.filter(row => row.decision!.action === 'suggest' && sameSkills(row.decision!.capabilities, row.expected.capabilities)).length;
  const errors = results.filter(row => row.status === 'error').length;
  const correct = completed.filter(row => row.correct).length;
  latencies.sort((a, b) => a - b);
  return {
    schemaVersion: 1,
    mode: options.mode,
    provider: options.mode === 'level1' ? { name: options.provider!.name, model: options.provider!.model } : null,
    prices: { inputUsdPerMillion: options.inputUsdPerMillion ?? null, outputUsdPerMillion: options.outputUsdPerMillion ?? null },
    summary: {
      total: cases.length, completed: completed.length, errors, skipped: results.filter(row => row.status === 'skipped').length,
      coverage: ratio(completed.length, cases.length), correct, accuracy: ratio(correct, completed.length),
      negativeCases: negatives.length, falsePositives, falsePositiveRate: ratio(falsePositives, negatives.length),
      positiveCases: positives.length, missedIntents, missedIntentRate: ratio(missedIntents, positives.length),
      capabilityCases: skillCases.length, capabilityMatches, capabilityAccuracy: ratio(capabilityMatches, skillCases.length),
      escalations: completed.filter(row => row.decision!.action === 'escalate').length,
      calls, reservedTokens, inputTokens, outputTokens,
      latencyP50Ms: latencies[Math.max(0, Math.ceil(latencies.length * 0.5) - 1)] ?? null,
      latencyP95Ms: latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] ?? null,
      estimatedUsd: calls === 0 ? 0 : errors || unknownUsage || options.inputUsdPerMillion === undefined || options.outputUsdPerMillion === undefined ? null : (inputTokens * options.inputUsdPerMillion + outputTokens * options.outputUsdPerMillion) / 1_000_000,
    },
    results,
  };
}
