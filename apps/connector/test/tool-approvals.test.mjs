import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';

test('approval waits for exact execution decision and consumes it before releasing tools',async()=>{
 const module=await import('../dist/tool-approvals.js').catch(()=>({}));
 assert.equal(typeof module.toolApprovalClient,'function');
 const socket=new EventEmitter(),calls=[];
 const client=module.toolApprovalClient(socket,async(name,payload)=>{calls.push([name,payload]);return name.endsWith('consume')?'allow':{status:'pending'};});
 const request={task_id:randomUUID(),execution_id:randomUUID()},input={id:randomUUID(),kind:'command',title:'Tests',details:'pnpm test'};
 const controller=new AbortController();let finished=false;
 const pending=client.controls(request).requestApproval(input,controller.signal).then(v=>{finished=true;return v;});
 await new Promise(r=>setImmediate(r));
 socket.emit('agent.tool.decision',{...request,execution_id:randomUUID(),id:input.id,decision:'allow'});
 await new Promise(r=>setImmediate(r));assert.equal(finished,false);
 socket.emit('agent.tool.decision',{...request,id:input.id,decision:'allow'});
 assert.equal(await pending,'allow');assert.equal(calls.at(-1)[0],'agent.tool.consume');
 const stopped=client.controls(request).requestApproval({...input,id:randomUUID()},controller.signal);
 controller.abort();await assert.rejects(stopped);
 client.close();
});

test('approval transport sends only execution identity from a full invocation',async()=>{
 const {toolApprovalClient}=await import('../dist/tool-approvals.js');
 const socket=new EventEmitter();
 const run={task_id:randomUUID(),execution_id:randomUUID(),session_id:randomUUID(),goal:'Update README',skill:'codex.run',persistent_session:{resume:false}};
 const approval={id:randomUUID(),kind:'project',title:'Project access',details:'/tmp/project'};
 const client=toolApprovalClient(socket,async(name,payload)=>{
  if(name==='agent.tool.consume')return 'deny';
  assert.deepEqual(payload,{task_id:run.task_id,execution_id:run.execution_id,approval});
  return {status:'deny'};
 });
 try {assert.equal(await client.controls(run).requestApproval(approval,new AbortController().signal),'deny');}
 finally{client.close();}
});
