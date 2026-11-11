// Exercise the actual gateway discovery, search and response validation over local HTTP.
import assert from 'node:assert/strict';
import { RemoteMcp } from '../../dist/remote.js';
import { callKnowledge, discoverKnowledge } from '../../dist/knowledge.js';
const base = '00000000-0000-4000-8000-00000000000';
process.env.NODE_ENV = 'development';
process.env.SPACE_LOCAL_PG_KNOWLEDGE = '1';
const conn = { id:base+'6', url:'https://pg-knowledge.invalid/mcp', token:process.env.KNOWLEDGE_BEARER, kind:'knowledge' };
const remote = new RemoteMcp();
const signal = AbortSignal.timeout(30000);
const tools = await discoverKnowledge(remote,conn,signal);
assert.deepEqual(tools.map(t=>t.name), ['knowledge_search']);
const question = 'A customer was charged twice after retrying checkout. Which runbook should I use and who owns the service?';
async function ask(channel, requester='2', workspace='1') {
  const context = {connectionId:conn.id,installationId:base+'5',workspaceId:base+workspace,
    requesterId:base+requester,audience:{kind:'channel', channelId:base+channel}};
  return (await callKnowledge(null,remote,conn,'knowledge_search',{query:question, limit:4},context,signal)).structuredContent.hits;
}
const restricted = await ask('3');
const shared = await ask('4');
assert.ok(restricted.some(h=>h.evidence==='Mina owns Payments.' && h.citation.url.endsWith('/ownership')));
assert.ok(restricted.some(h=>h.ref.recordId==='passage/pay-internal'));
assert.equal(shared[0].ref.recordId,'passage/pay');
assert.ok(!JSON.stringify(shared).match(/Mina|Internal escalation|ownership|private payments incident room/i));
for (const params of [['7'], ['3','8'], ['3','2','9']]) await assert.rejects(ask(...params), /knowledge_provider_failed/);
await assert.rejects(discoverKnowledge(remote,{...conn,token:'incorrect'},signal));
for (const [audience,hits] of [['team',restricted],['shared',shared]]) {
  console.log(audience, hits.map(h=>h.title+' — '+h.citation.url));
}
console.log('PASS: both engines, cited results, private passage and edge, denied identities, bearer authentication.');

if (process.argv.includes('--agent')) {
  async function chat(messages, format) {
    const response = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST', headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({model:'qwen2.5-coder:3b', messages, format, stream:false, options:{temperature:0, num_predict:300}}),
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok) throw new Error('Ollama chat unavailable: '+response.status);
    return (await response.json()).message;
  }
  for (const [channel,label] of [['3','team'],['4','shared']]) {
    const messages = [{role:'system',content:'Use knowledge_search to answer. Only report what the results establish. If an owner is missing, say ownership is unknown. Cite the relevant source URLs.'},
      {role:'user',content:question}];
    const options = {type:'object',properties:{action:{type:'string',enum:['knowledge_search','ask_for_clarification']},
      query:{type:'string'}},required:['action','query']};
    const plan = await chat([...messages,{role:'system',content:'Choose the next action. Use knowledge_search for a concrete incident. Set query to the symptoms to retrieve.'}],options);
    const chosen = JSON.parse(plan.content);
    assert.equal(chosen.action,'knowledge_search');
    assert.equal(typeof chosen.query,'string');
    const context = {connectionId:conn.id, installationId:base+'5', workspaceId:base+'1', requesterId:base+'2',
      audience:{kind:'channel',channelId:base+channel}};
    const result = await callKnowledge(null,remote,conn,chosen.action,{query:chosen.query,limit:4},context,AbortSignal.timeout(15000));
    const hits = result.structuredContent.hits;
    const answerFormat = {type:'object', properties:{runbookSource:{type:'string',enum:hits.filter(h=>h.ref.recordId.startsWith('passage/')).map(h=>h.ref.recordId)},
      ownerSource:{type:'string',enum:['', ...hits.filter(h=>h.ref.recordId.startsWith('ownership/')).map(h=>h.ref.recordId)]}},
      required:['runbookSource','ownerSource']};
    const reply = await chat([...messages,{role:'user',content:'Search completed. Name the single best runbook and its service owner if available. Choose one source for each claim. Use an empty ownerSource if unknown. Records: '+JSON.stringify(hits)}],answerFormat);
    const answer = JSON.parse(reply.content);
    const citations = [answer.runbookSource,answer.ownerSource].filter(Boolean).map(id => {
      const hit = hits.find(h=>h.ref.recordId === id);
      assert.ok(hit, 'The model must cite visible evidence');
      return hit.citation.url;
    });
    const runbook = hits.find(h=>h.ref.recordId === answer.runbookSource);
    const ownership = hits.find(h=>h.ref.recordId === answer.ownerSource);
    const response = runbook.title + '. ' + (ownership?.evidence ?? 'Ownership unknown from visible sources.');
    console.log(label + ' answer:',response, citations);
    assert.ok(citations.includes('https://catalog.example/runbooks/pay'));
    if (label === 'team') {
      assert.match(response,/Mina/);
      assert.ok(citations.includes('https://catalog.example/services/payments/ownership'));
    } else assert.doesNotMatch(response,/Mina|pay-internal|private payments incident room/i);
  }
}
