import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { NavigationContext, NavigationDecision, NavigatorProvider } from '@space/contracts';
import { evaluateNavigator, type NavigatorEvaluationCase } from '../evaluation/navigator.js';
import { navigatorEvaluationCases } from '../evaluation/navigator-fixtures.js';
import { CompatibleNavigatorProvider } from '@space/core/navigator-provider';

const candidate = { installation_id: 'writer', name: 'Writer', skill: 'writing.summarize', description: 'Summarize discussions' };
function sample(id: string, action: NavigationDecision['action'] = 'suggest'): NavigatorEvaluationCase {
  return { id, category: 'test', context: { messages: [{ id, text: 'Please summarize this' }], pendingMessageIds: [id], candidates: [candidate], rules: [{ skill: candidate.skill, keywords: ['summarize'] }] }, expected: { actions: [action], capabilities: action === 'suggest' ? [candidate.skill] : [] } };
}
function provider(decide: NavigatorProvider['decide']): NavigatorProvider {
  return { name: 'fixture', model: 'fixture', maxOutputTokens: 10, estimateTokens: () => 100, decide };
}
function result(context: NavigationContext, action: NavigationDecision['action']) {
  return { decision: { action, capabilities: action === 'suggest' ? [candidate.skill] : [], evidenceMessageIds: [context.pendingMessageIds!.at(-1)!], reason: 'Fixture decision' }, inputTokens: 10, outputTokens: 2 };
}

test('rules replay scores only pending messages and does not call a configured provider', async () => {
  const item = sample('ack', 'ignore');
  item.context.messages.unshift({ id: 'old', text: 'Please summarize yesterday' });
  item.context.messages[1]!.text = 'Thanks!';
  const report = await evaluateNavigator([item], { mode: 'rules', provider: provider(async () => { throw Error('must not call'); }) });
  assert.equal(report.summary.correct, 1);
  assert.equal(report.summary.calls, 0);
  assert.equal(report.summary.falsePositiveRate, 0);
  assert.equal(report.summary.missedIntentRate, null);
  assert.equal(report.summary.estimatedUsd, 0);
});

test('metrics expose wrong suggestions, missed intent, capability mistakes, usage and latency', async () => {
  const cases = [sample('good'), sample('miss'), sample('false', 'ignore'), sample('quiet', 'ignore'), sample('wrong-skill')];
  const fake = provider(async context => {
    const id = context.pendingMessageIds![0];
    const value = result(context, id === 'miss' || id === 'quiet' ? 'ignore' : 'suggest');
    if (id === 'wrong-skill') value.decision.capabilities = ['engineering.investigate'];
    return value;
  });
  cases[4]!.context.candidates.push({ ...candidate, skill: 'engineering.investigate' });
  const report = await evaluateNavigator(cases, { mode: 'level1', provider: fake, inputUsdPerMillion: 1, outputUsdPerMillion: 5 });
  assert.equal(report.summary.correct, 2);
  assert.equal(report.summary.accuracy, 2 / 5);
  assert.equal(report.summary.falsePositives, 1);
  assert.equal(report.summary.falsePositiveRate, 1 / 2);
  assert.equal(report.summary.missedIntents, 1);
  assert.equal(report.summary.missedIntentRate, 1 / 3);
  assert.equal(report.summary.capabilityMatches, 1);
  assert.equal(report.summary.capabilityAccuracy, 1 / 3);
  assert.equal(report.summary.inputTokens, 50);
  assert.equal(report.summary.outputTokens, 10);
  assert.equal(report.summary.reservedTokens, 500);
  assert.equal(report.summary.estimatedUsd, 0.0001);
  assert.ok(report.summary.latencyP95Ms! >= 0);
});

test('budget is reserved before calls, skipped cases remain visible and no live call is retried', async () => {
  let calls = 0;
  const report = await evaluateNavigator([sample('one'), sample('two'), sample('three')], { mode: 'level1', maxReservedTokens: 100, provider: provider(async context => { calls++; return result(context, 'suggest'); }) });
  assert.equal(calls, 1);
  assert.equal(report.summary.skipped, 2);
  assert.equal(report.summary.coverage, 1 / 3);
  assert.equal(report.summary.accuracy, 1);
  assert.equal(report.results[1]!.error, 'budget_exhausted');
  assert.equal(report.summary.estimatedUsd, null, 'missing prices must not imply free inference');
});

test('provider errors stop subsequent calls, preserve reservation, and never expose raw errors', async () => {
  const report = await evaluateNavigator([sample('one'), sample('two')], { mode: 'level1', provider: provider(async () => { throw Error('private-key-and-raw-response'); }), inputUsdPerMillion: 1, outputUsdPerMillion: 1 });
  assert.equal(report.summary.calls, 1);
  assert.equal(report.summary.errors, 1);
  assert.equal(report.summary.skipped, 1);
  assert.equal(report.summary.reservedTokens, 100);
  assert.equal(report.summary.estimatedUsd, null, 'failed call has unknown billable usage');
  assert.equal(report.summary.accuracy, null);
  assert.equal(report.summary.coverage, 0);
  assert.ok(!JSON.stringify(report).includes('private-key'));
});

test('invalid provider decisions and usage cannot earn a passing score', async () => {
  for (const invalid of ['skill', 'usage'] as const) {
    const report = await evaluateNavigator([sample('one')], { mode: 'level1', provider: provider(async context => {
      const value = result(context, 'suggest');
      if (invalid === 'skill') value.decision.capabilities = ['unauthorized.skill'];
      else value.inputTokens = -1;
      return value;
    }) });
    assert.equal(report.summary.errors, 1);
    assert.equal(report.summary.correct, 0);
  }
});

test('compatible responses without usage do not masquerade as free inference', async () => {
  const item = sample('one');
  const compatible = new CompatibleNavigatorProvider({ endpoint: 'http://127.0.0.1/v1/chat/completions', model: 'fixture', fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result(item.context, 'suggest').decision) } }] })) });
  const report = await evaluateNavigator([item], { mode: 'level1', provider: compatible, inputUsdPerMillion: 1, outputUsdPerMillion: 1 });
  assert.equal(report.summary.correct, 1);
  assert.equal(report.summary.estimatedUsd, null);
});

test('live mode requires a provider and invalid budgets fail before any calls', async () => {
  await assert.rejects(evaluateNavigator([sample('one')], { mode: 'level1' }), /Level 1 provider/);
  await assert.rejects(evaluateNavigator([sample('one')], { mode: 'rules', maxReservedTokens: -1 }), /budget/);
});

test('starter corpus has valid labels and covers contexts, negation, unavailable skills and Vietnamese', () => {
  assert.equal(navigatorEvaluationCases.length, 36);
  assert.equal(new Set(navigatorEvaluationCases.map(item => item.id)).size, 36);
  for (const item of navigatorEvaluationCases) {
    assert.ok(item.expected.actions.length > 0);
    assert.ok(item.expected.capabilities.every(skill => item.context.candidates.some(candidate => candidate.skill === skill)));
    assert.ok(item.context.pendingMessageIds!.every(id => item.context.messages.some(message => message.id === id)));
    assert.equal(item.expected.capabilities.length > 0, item.expected.actions.includes('suggest'));
  }
  for (const category of ['context', 'negation', 'capability-boundary', 'vietnamese', 'untrusted-input','work-state','multiuser','cancellation']) {
    assert.ok(navigatorEvaluationCases.some(item => item.category === category));
  }
});

test('CLI is offline by default, emits JSON, and rejects absent live configuration', () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NAVIGATOR_') && key !== 'TYPESAFE_API_KEY'));
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'evaluation/navigator-cli.ts', ...args], { cwd, env, encoding: 'utf8', timeout: 10_000 });
  const offline = run('--limit', '1');
  assert.equal(offline.status, 0, offline.stderr);
  assert.equal(JSON.parse(offline.stdout).summary.calls, 0);
  const live = run('--mode', 'level1', '--limit', '1');
  assert.equal(live.status, 1);
  assert.match(live.stderr, /configured Level 1 provider/);
  const strict = run('--case', 'postponed', '--require-perfect');
  assert.equal(strict.status, 1);
  assert.equal(JSON.parse(strict.stdout).summary.falsePositives, 1);
});
