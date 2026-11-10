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
