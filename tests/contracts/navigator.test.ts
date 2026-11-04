import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NavigationContext, NavigatorCandidate } from '@space/contracts';
import { matchAgentMentions, parseNavigationDecision, rulesDecision } from '@space/core/navigator';

const candidates: NavigatorCandidate[] = [
  { installation_id: 'f8a17af0-a602-439b-bae2-18749e41ced5', name: 'Research Agent', skill: 'research', description: 'Research questions' },
  { installation_id: '2b377637-11cc-460f-9897-47409499ba83', name: 'Code Agent', skill: 'code', description: 'Write code' },
];
const context: NavigationContext = { messages: [{ id: 'message-1', text: 'Research and fix the bug' }], candidates, rules: [{ skill: 'research', keywords: ['research'] }, { skill: 'code', keywords: ['bug'] }] };
const decision = { action: 'suggest', capabilities: ['research', 'code'], evidenceMessageIds: ['message-1'], reason: 'Both skills match.' };

test('navigation accepts only known bounded closed decisions and evidence', () => {
  assert.deepEqual(parseNavigationDecision(decision, context), decision);
  for (const value of [
    { ...decision, execute: true }, { ...decision, action: 'execute' },
    { ...decision, capabilities: ['unknown'] }, { ...decision, capabilities: ['code', 'code'] },
    { ...decision, evidenceMessageIds: ['unknown'] }, { ...decision, evidenceMessageIds: ['message-1', 'message-1'] },
    { ...decision, reason: 'x'.repeat(1001) }, { ...decision, capabilities: [] },
    { ...decision, action: 'ignore' },
  ]) assert.throws(() => parseNavigationDecision(value, context));
});

test('navigation task dependencies must reference unique acyclic tasks and selected capabilities', () => {
  const tasks = [
    { id: 'research-task', title: 'Research issue', capabilities: ['research'], dependsOn: [] },
    { id: 'fix-task', title: 'Fix issue', capabilities: ['code'], dependsOn: ['research-task'] },
  ];
  assert.deepEqual(parseNavigationDecision({ ...decision, tasks }, context).tasks, tasks);
  for (const invalid of [
    [...tasks, tasks[0]],
    [{ ...tasks[0], dependsOn: ['fix-task'] }, tasks[1]],
    [{ ...tasks[0], dependsOn: ['unknown'] }],
    [{ ...tasks[0], dependsOn: ['research-task'] }],
    [{ ...tasks[0], capabilities: ['unknown'] }],
    [{ ...tasks[0], approved: true }],
    Array.from({ length: 9 }, (_, i) => ({ ...tasks[0], id: String(i) })),
  ]) assert.throws(() => parseNavigationDecision({ ...decision, tasks: invalid }, context));
});

test('mentions match canonical installation tags and unique slugs with boundaries', () => {
  assert.deepEqual(matchAgentMentions(`@agent-${candidates[0]!.installation_id} please research`, candidates), { mentioned: true, candidates: [candidates[0]] });
  assert.deepEqual(matchAgentMentions('@CODE-AGENT help', candidates), { mentioned: true, candidates: [candidates[1]] });
  assert.equal(matchAgentMentions('mail@code-agent.example', candidates).mentioned, false);
  assert.deepEqual(matchAgentMentions('@unknown-agent please', candidates), { mentioned: true, candidates: [] });
  assert.deepEqual(matchAgentMentions('@code-agent-extra please', candidates), { mentioned: true, candidates: [] });
});

test('quoted and code mentions are ignored and duplicate names never guess an installation', () => {
  for (const text of ['`@code-agent`', '```\n@code-agent\n```', '~~~js\n@code-agent\n~~~', '> @code-agent help', '  > @code-agent', '`unclosed @code-agent', '``code ` @code-agent ``', '`multiline\n@code-agent\ncode`']) assert.equal(matchAgentMentions(text, candidates).mentioned, false);
  const duplicate = { ...candidates[0]!, installation_id: candidates[1]!.installation_id };
  assert.deepEqual(matchAgentMentions('@research-agent help', [candidates[0]!, duplicate]), { mentioned: true, candidates: [] });
  assert.deepEqual(matchAgentMentions('@research-agent', [candidates[0]!, { ...candidates[0]!, skill: 'summarize' }]).candidates.map(c => c.skill), ['research', 'summarize']);
});

test('rules return multiple matching skills with source evidence and no inference', () => {
  const result = rulesDecision(context);
  assert.equal(result.action, 'suggest');
  assert.deepEqual(result.capabilities, ['research', 'code']);
  assert.deepEqual(result.evidenceMessageIds, ['message-1']);
  assert.equal(rulesDecision({ ...context, rules: [] }).action, 'ignore');
  assert.equal(rulesDecision({ ...context, messages: [{ id: 'm', text: 'Debugging is fun' }] }).action, 'ignore');
  assert.equal(rulesDecision({ ...context, messages: [{ id: 'm', text: '`bug`' }] }).action, 'ignore');
});


test('catalogs up to 100 candidates permit bounded selections and deterministic rules select at most eight', () => {
  const many = Array.from({ length: 100 }, (_, index) => ({ installation_id: `installation-${index}`, name: `Agent ${index}`, skill: `skill-${index}`, description: 'Capability' }));
  const large: NavigationContext = { ...context, candidates: many, rules: many.map(candidate => ({ skill: candidate.skill, keywords: ['research'] })) };
  assert.deepEqual(parseNavigationDecision({ ...decision, capabilities: ['skill-8'] }, large).capabilities, ['skill-8']);
  assert.equal(rulesDecision(large).capabilities.length, 8);
  assert.deepEqual(rulesDecision(large).capabilities, many.slice(0, 8).map(candidate => candidate.skill));
  assert.throws(() => parseNavigationDecision({ ...decision, capabilities: many.slice(0, 9).map(candidate => candidate.skill) }, large));
  assert.throws(() => parseNavigationDecision({ ...decision, capabilities: ['skill-8'] }, { ...large, candidates: [...many, many[0]!] }));
  const messages = Array.from({ length: 40 }, (_, index) => ({ id: `message-${index}`, text: 'research' }));
  assert.equal(rulesDecision({ ...large, messages }).evidenceMessageIds.length, 32);
});

test('versioned intent assessments are strict while historical assessments remain readable', () => {
 const base={model:'jev',targetMessageId:'message-1',requestsAgentWork:.98,capabilityRelevance:{code:.9}};
 const current={...base,version:'execution-intent-v1',workStateHash:'a'.repeat(64),taskClear:.99,continuesExistingWork:.01};
 const legacy={...base,assistanceUseful:.99,needsDeeperReasoning:.01};
 for(const assessment of [current,legacy])assert.deepEqual(parseNavigationDecision({...decision,assessment},context).assessment,assessment);
 for(const assessment of [{...current,workStateHash:undefined},{...current,workStateHash:'bad'},{...current,taskClear:undefined},{...current,continuesExistingWork:2},{...current,version:'future'},{...current,assistanceUseful:.99},{...legacy,taskClear:.99}])assert.throws(()=>parseNavigationDecision({...decision,assessment},context));
});
