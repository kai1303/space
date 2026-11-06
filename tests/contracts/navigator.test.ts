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

const managedContext: NavigationContext = {
  ...context, pendingMessageIds: ['message-1'],
  workState: {pendingProposals: [], tasks: [], sessions: [{id: 'session-1', title: 'Fix bug', skill: 'code', state: 'active'}]},
};
test('continue and stop require an active known session and exact latest pending human evidence', () => {
  for (const action of ['continue', 'stop']) {
    const followup = {action, targetSessionId: 'session-1', capabilities: [], evidenceMessageIds: ['message-1'], reason: 'Update existing work.'};
    assert.deepEqual(parseNavigationDecision(followup, managedContext), followup);
    for (const value of [{...followup, targetSessionId: undefined}, {...followup, targetSessionId: 'unknown'}, {...followup, capabilities: ['code']}, {...followup, evidenceMessageIds: []}, {...followup, readMessageIds: ['message-1']}]) assert.throws(() => parseNavigationDecision(value, managedContext));
    for (const invalid of [context, {...managedContext, pendingMessageIds: []}, {...managedContext, pendingMessageIds: ['missing']}, {...managedContext, messages: [{id:'message-1',text:'Update',author:{id:'agent',kind:'agent' as const}}]}, {...managedContext, workState: {...managedContext.workState!, sessions: [{...managedContext.workState!.sessions[0]!,state:'ended'}]}}]) assert.throws(() => parseNavigationDecision(followup, invalid));
    assert.throws(() => parseNavigationDecision({...followup,evidenceMessageIds:['old','message-1']}, {...managedContext,messages:[{id:'old',text:'Previous request'},...context.messages]}));
  }
  for (const action of ['ignore','suggest','clarify','escalate']) assert.throws(() => parseNavigationDecision({...decision,action,targetSessionId:'session-1'}, managedContext));
});
test('read_context reads at most eight unique known IDs once, including the working memory root', () => {
  const root = {id:'root',sequence:'1',text:'Root',text_truncated:true,author:{id:'human',kind:'human' as const},attachments:[]};
  const source = {...managedContext, workingMemory:{root,checkpoint:null}};
  const read = {action:'read_context',readMessageIds:['root','message-1'],capabilities:[],evidenceMessageIds:['message-1'],reason:'Resolve truncated context.'};
  assert.deepEqual(parseNavigationDecision(read, source), read);
  for (const value of [{...read,readMessageIds:[]},{...read,readMessageIds:undefined},{...read,readMessageIds:['unknown']},{...read,readMessageIds:['root','root']},{...read,readMessageIds:Array(9).fill('root')},{...read,targetSessionId:'session-1'},{...read,capabilities:['code']},{...read,evidenceMessageIds:[]}]) assert.throws(() => parseNavigationDecision(value, source));
  assert.throws(() => parseNavigationDecision(read, {...source,retrievedMessages:[]}));
  assert.throws(() => parseNavigationDecision({...decision,readMessageIds:['root']}, source));
});

test('automatic follow-ups require the complete latest human message, including recovered truncated targets', () => {
  const source: NavigationContext = {...managedContext, messages: [{...context.messages[0]!, truncated: true}]};
  for (const action of ['continue', 'stop']) {
    const followup = {action, targetSessionId: 'session-1', capabilities: [], evidenceMessageIds: ['message-1'], reason: 'Follow up.'};
    for (const retrievedMessages of [undefined, [], [{id:'other',text:'Complete',truncated:false}], [{id:'message-1',text:'Partial',truncated:true}], [{id:'message-1',text:'Unknown completeness'}]]) {
      assert.throws(() => parseNavigationDecision(followup, {...source,retrievedMessages}));
    }
    assert.deepEqual(parseNavigationDecision(followup, {...source,retrievedMessages:[{id:'message-1',text:'Full request',truncated:false}]}), followup);
  }
  assert.equal(parseNavigationDecision({action:'read_context',readMessageIds:['message-1'],capabilities:[],evidenceMessageIds:['message-1'],reason:'Read the full target.'},source).action,'read_context');
  assert.equal(parseNavigationDecision(decision,source).action,'suggest');
});
