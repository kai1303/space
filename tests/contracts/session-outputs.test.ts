import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentResponse } from '@space/contracts';
const response = {messages:[],tools:[],components:[]};
test('session responses retain validated previews, files and changes together',()=>{
 const outputs={preview:{state:'ready',label:'Result',document:'<h1>Result</h1>'},files:[{path:'src/result.ts',content:'export const result = 1;',language:'typescript'}],changes:[{path:'src/result.ts',patch:'+export const result = 1;'}]};
 assert.deepEqual(parseAgentResponse({...response,outputs}).outputs,outputs);
});
test('session outputs reject unsafe preview URLs, excessive files and unexpected fields',()=>{
 for(const outputs of [{preview:{state:'ready',label:'Result',url:'javascript:alert(1)'},files:[],changes:[]},{files:Array.from({length:21},()=>({path:'a',content:''})),changes:[]},{files:[],changes:[],execute:'command'}])assert.throws(()=>parseAgentResponse({...response,outputs}));
});

test('saved turn-presentation snapshots remain readable in the original response format',()=>{
 const saved={...response,metadata:{model:'saved-model'},messages:[{id:'m',text:'Saved answer',status:'complete',phase:'final_answer'}],tools:[{id:'t',name:'Read',arguments:'{}',result:'Missing file',status:'failed',duration_ms:25,result_characters:12,arguments_characters:2}]};
 assert.deepEqual(parseAgentResponse(saved),{...response,messages:[{id:'m',text:'Saved answer',status:'complete',phase:'final_answer'}],tools:[{id:'t',name:'Read',arguments:'{}',result:'Missing file',status:'interrupted'}]});
});

test('provider result actions are bounded HTTPS links without embedded credentials',()=>{
 const action={label:'Open PR',url:'https://git.example.test/repo/pull/42'};
 const outputs={files:[],changes:[],actions:[action]};
 assert.deepEqual(parseAgentResponse({...response,outputs}).outputs,outputs);
 for(const actions of [Array(9).fill(action),[{...action,url:'javascript:alert(1)'}],[{...action,url:'https://user:secret@host.example'}]])
   assert.throws(()=>parseAgentResponse({...response,outputs:{...outputs,actions}}));
});

test('document edit blocks preserve passage formatting and reject invalid payloads', () => {
  const edit = { type: 'document_edit', id: 'edit', title: 'Report', original: '  First line\nSecond line', replacement: 'New text' };
  const parse = (component: unknown) => parseAgentResponse({ ...response, components: [component] }).components[0];
  assert.deepEqual(parse(edit), edit);
  for (const extra of [{ replacement: '' }, { original: 'x'.repeat(16001) }, { action: 'apply' }]) {
    assert.throws(() => parse({ ...edit, ...extra }));
  }
});

test('alert levels and payload sizes are checked, including ordered component references', () => {
  const warning = { id: 'flag', type: 'alert', level: 'warning', title: 'Incomplete results' };
  const item = { type: 'component', id: warning.id };
  const parse = (component: unknown, items: unknown[] = [item]) =>
    parseAgentResponse({ ...response, components: [component], items });
  assert.deepEqual(parse(warning).components, [warning]);
  for (const fields of [{ level: 'urgent' }, { level: undefined }, { body: 'x'.repeat(8001) }, { action: 'run' }]) {
    assert.throws(() => parse({ ...warning, ...fields }));
  }
  assert.throws(() => parse(warning, [item, item]));
  assert.throws(() => parse(warning, [{ ...item, id: 'missing' }]));
});

test('carousels bound the number of cards, require distinct IDs and reject unexpected actions', () => {
  const parse = (cards: unknown[]) => parseAgentResponse({ ...response, components: [{ id: 'options', type: 'carousel', title: 'Options', cards }] });
  const ten = Array.from({ length: 10 }, (_, i) => ({ id: String(i), title: 'Option', body: 'Details' }));
  assert.equal(parse(ten).components.length, 1);
  for (const invalid of [[], [...ten, { ...ten[0], id: 'extra' }], [ten[0], ten[0]], [{ ...ten[0], action: 'run' }]]) {
    assert.throws(() => parse(invalid));
  }
});

test('data tables validate numeric and text cells, dimensions and field limits', () => {
  const block = { type: 'data_table', id: 'plans', title: 'Plans', columns: ['Plan', 'Customers'], rows: [['Pro', 20]] };
  const parse = (fields: Record<string, unknown>) => parseAgentResponse({ ...response, components: [{ ...block, ...fields }] });
  assert.deepEqual(parse({}).components, [block]);
  assert.deepEqual(parse({ rows: [] }).components, [{ ...block, rows: [] }]);
  for (const fields of [{ rows: [['Pro']] }, { rows: [['Pro', 1, 2]] }, { columns: [] }, { columns: Array(11).fill('x') },
    { rows: Array(101).fill(['Pro', 1]) }, { rows: [['x'.repeat(1001), 0]] }, { rows: [['Pro', Infinity]] },
    { rows: [['Pro', { html: '<b>1</b>' }]] }, { type: 'table' }]) {
    assert.throws(() => parse(fields));
  }
});
