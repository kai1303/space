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
