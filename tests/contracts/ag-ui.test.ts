import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseAgentEvent } from '@space/contracts';

const response = { messages: [{ id: 'm1', text: 'Hello **Kai**', status: 'streaming' }], tools: [], components: [] };
const event = (value: unknown) => ({ id: randomUUID(), schema_version: '1.0', execution_id: randomUUID(), sequence: 2, type: 'execution.progress', occurred_at: '2026-11-03T00:00:00.000Z', payload: { text: 'Working', response: value } });

test('agent events accept accumulated structured responses without changing legacy envelopes', () => {
  const input = event(response);
  assert.deepEqual(parseAgentEvent(input), input);
});

test('agent responses reject executable components, invalid tools and excessive content', () => {
  for (const value of [
    { ...response, components: [{ id: 'c', type: 'html', html: '<script>run()</script>' }] },
    { ...response, tools: [{ id: 't', name: 'read', arguments: '', status: 'approved' }] },
    { ...response, messages: [{ ...response.messages[0], text: 'x'.repeat(16001) }] },
    { ...response, components: [{ id: 't', type: 'table', title: 'Table', columns: ['Name'], rows: [['a', 'b']] }] },
    { ...response, messages: [response.messages[0], response.messages[0]] },
  ]) assert.throws(() => parseAgentEvent(event(value)));
});


test('agent responses carry typed activity without exposing reasoning text', () => {
  for (const activity of ['working', 'thinking', 'responding', 'using_tools']) {
    assert.equal(parseAgentEvent(event({ ...response, activity })).payload.response?.activity, activity);
  }
  assert.throws(() => parseAgentEvent(event({ ...response, activity: 'pretend_typing' })));
});


test('ordered response items reference every message and tool exactly once',()=>{
 const value={messages:[{id:'before',text:'Before.',status:'complete'},{id:'after',text:'After.',status:'complete'}],tools:[{id:'read',name:'read_text_file',arguments:'{}',status:'completed'}],components:[],items:[{type:'message',id:'before'},{type:'tool',id:'read'},{type:'message',id:'after'}]};
 assert.deepEqual(parseAgentEvent(event(value)).payload.response,value);
 for(const items of [[],value.items.slice(1),[...value.items,value.items[0]],[{type:'message',id:'missing'},...value.items.slice(1)],[{type:'unknown',id:'before'},...value.items.slice(1)]])assert.throws(()=>parseAgentEvent(event({...value,items})));
});
