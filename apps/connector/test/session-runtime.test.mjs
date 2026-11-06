import test from 'node:test';import assert from 'node:assert/strict';
import {sessionRuntime} from '../dist/session-runtime.js';
test('sessions execute independently, reject overlap and capacity, and reuse provider context',async()=>{
 const pending=new Map();let created=0;
 const pool=await sessionRuntime(async()=>{created++;return {alive:()=>true,stop(){},invoke:async r=>new Promise(resolve=>pending.set(r.session_id,resolve))};},2);
 const request=id=>({session_id:id});const emit=async()=>{};const signal=new AbortController().signal;
 const a=pool.invoke(request('a'),emit,signal),b=pool.invoke(request('b'),emit,signal);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(pending.size,2);
 await assert.rejects(pool.invoke(request('a'),emit,signal),/busy/);
 await assert.rejects(pool.invoke(request('c'),emit,signal),/capacity/);
 pending.get('a')();await a;const next=pool.invoke(request('a'),emit,signal);assert.equal(created,2);pending.get('a')();await next;
 pending.get('b')();await b;pool.stop();
});
