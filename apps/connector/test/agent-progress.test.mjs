import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentProgress} from '../dist/agent-progress.js';

test('tool snapshots budget accumulated results and preserve latest details and all statuses',()=>{
 const progress=new AgentProgress();
 for(let i=0;i<12;i++)progress.tool(String(i),'read_text_file','{"path":"file.txt"}','completed','x'.repeat(16000));
 const snapshot=progress.snapshot([{id:'answer',text:'Read twelve files.',status:'streaming'}]);
 assert.equal(snapshot.tools.length,12);assert.equal(snapshot.tools.at(-1).result.length,16000);
 assert.ok(JSON.stringify(snapshot).length<=64000);assert.ok(snapshot.tools.every(tool=>tool.status==='completed'));
});
test('snapshot budgets account for JSON escaping and terminal tools never retain running status',()=>{
 const progress=new AgentProgress();
 for(let i=0;i<8;i++)progress.tool(String(i),'read_text_file','\\'.repeat(8000),'running','\n'.repeat(16000));
 const snapshot=progress.snapshot([],true);assert.ok(JSON.stringify(snapshot).length<=64000);assert.equal(snapshot.activity,undefined);assert.ok(snapshot.tools.every(tool=>tool.status==='interrupted'));
});

test('truncation stays within both the serialized budget and each field character limit',()=>{
 for(let size=7500;size<=7650;size++) {
  const progress=new AgentProgress();
  progress.tool('old','read_text_file','','completed','a'.repeat(15990)+'\n'.repeat(10));
  for(const [index,length] of [size,8000,8000].entries())progress.tool(String(index),'read_text_file','a'.repeat(8000),'completed','x'.repeat(length));
  const snapshot=progress.snapshot([]);
  assert.ok(JSON.stringify(snapshot).length<=64000);assert.ok(snapshot.tools.every(tool=>tool.arguments.length<=8000&&(tool.result?.length??0)<=16000));
 }
});

test('first appearance order survives tool updates and omitted invalid text on failure',()=>{
 const progress=new AgentProgress();progress.message('before');progress.tool('read','read_text_file','{}','running');progress.message('after');
 const messages=[{id:'before',text:'Before.',status:'streaming'},{id:'after',text:'After.',status:'streaming'}];
 assert.deepEqual(progress.snapshot(messages).items,[{type:'message',id:'before'},{type:'tool',id:'read'},{type:'message',id:'after'}]);
 progress.tool('read','read_text_file','{}','completed','Read result');progress.message('before');
 assert.deepEqual(progress.snapshot(messages,true).items,[{type:'message',id:'before'},{type:'tool',id:'read'},{type:'message',id:'after'}]);
 assert.deepEqual(progress.snapshot([],true).items,[{type:'tool',id:'read'}]);
});
