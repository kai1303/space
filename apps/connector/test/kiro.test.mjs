import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startKiro } from '../dist/kiro.js';
import { AgentSessionStopped } from '../dist/codex.js';
const invocation = { schema_version:'1.0', task_id:'11111111-1111-4111-8111-111111111111', execution_id:'22222222-2222-4222-8222-222222222222', idempotency_key:'22222222-2222-4222-8222-222222222222', session_id:'33333333-3333-4333-8333-333333333333', goal:'Hello', skill:'kiro.run', persistent_session:{resume:false} };
async function fixture(behavior = 'normal') {
  const directory = await mkdtemp(join(tmpdir(), 'space-kiro-test-')), log = join(directory,'rpc.jsonl');
  const storage = {directory, connection:{origin:'http://localhost:3000',workspace_id:'w',installation_id:'i',credential:'private',provider:'kiro'},identity:{issuer:'kiro',subject:'user',client_id:'space-kiro'}};
  const launches=[];let loadingResolve;const loading=new Promise(resolve=>{loadingResolve=resolve;});
  const launch=(command,args,options)=>{
    launches.push({command,args,options});
    const child=spawn(process.execPath,['-e',`
      const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
      const send=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
      const behavior=${JSON.stringify(behavior)};
      let buffer='',prompt;
      const modes={currentModeId:behavior==='wrong-mode'?'vibe':'space-chat',availableModes:[{id:'space-chat',name:'Space chat'}]};
      process.stdin.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\\n')){
        const i=buffer.indexOf('\\n'),m=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);
        fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');
        if(m.method==='initialize') send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:behavior!=='no-resume'}}});
        else if(m.method==='session/new') send({id:m.id,result:{sessionId:crypto.randomUUID(),modes}});
        else if(m.method==='session/load') {
          send({method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD REPLAY'}}}});
          if(behavior==='slow-load')setTimeout(()=>send({id:m.id,result:{modes}}),200);else send({id:m.id,result:{modes}});
        } else if(m.method==='session/prompt') {
          prompt=m;
          const update=value=>send({method:'session/update',params:{sessionId:m.params.sessionId,update:value}});
          if(behavior==='cloud-config') { update({sessionUpdate:'tool_call',toolCallId:'config',kind:'other',status:'in_progress',_meta:{kiro:{toolId:'fetch_cloud_config'}}}); update({sessionUpdate:'tool_call_update',toolCallId:'config',status:'completed',rawOutput:{kind:'upToDate'}}); }
          if(behavior==='tool') send({id:'permission',method:'session/request_permission',params:{sessionId:m.params.sessionId,options:[{optionId:'allow',kind:'allow_always'}]}});
          else if(behavior==='tool-update') update({sessionUpdate:'tool_call',toolCallId:'bad',kind:'execute',status:'in_progress'});
          else if(behavior==='malformed') process.stdout.write('not json\\n');
          else if(behavior==='oversized') update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'x'.repeat(16001)}});
          else {
            update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Hello from Kiro'}});
            if(behavior==='wait') {} else setTimeout(()=>send({id:m.id,result:{stopReason:'end_turn'}}),150);
          }
        } else if(m.method==='session/cancel') { if(prompt) send({id:prompt.id,result:{stopReason:'cancelled'}}); }
      }});
    `],options);
    child.stdout.on('data',chunk=>{if(chunk.toString().includes('OLD REPLAY'))loadingResolve();});
    return child;
  };
  const start=(overrides={})=>startKiro({...storage,...overrides},()=>{},launch);
  return {directory,storage,launches,start,loading,requests:async()=> (await readFile(log,'utf8')).trim().split('\n').map(JSON.parse),close:()=>rm(directory,{recursive:true,force:true})};
}
test('Kiro initializes ACP v3 without tools and streams bounded session responses', {timeout:5000},async()=>{
  const f=await fixture();const runtime=await f.start();
  try {
    const launched=f.launches[0]; assert.equal(launched.command,'kiro-cli');assert.deepEqual(launched.args,['acp','--agent-engine=v3']);
    assert.notEqual(launched.options.env.HOME,process.env.HOME);assert.equal(launched.options.env.ACCESS_TOKEN,undefined);
    const profile=JSON.parse(await readFile(join(launched.options.env.HOME,'.kiro','agents','space-chat.json'),'utf8'));
    assert.deepEqual(profile.tools,[]);assert.deepEqual(profile.excludedTools,['*']);assert.equal(profile.includeMcpJson,false);assert.equal(profile.includePowers,false);
    const events=[];await runtime.invoke(invocation,async e=>events.push(e),new AbortController().signal);
    assert.deepEqual(events.map(e=>e.sequence),events.map((_,i)=>i+1));assert.equal(events[0].type,'execution.started');
    assert.ok(events.some(e=>e.payload.session_ready));assert.ok(events.some(e=>e.type==='execution.progress'&&e.payload.text==='Hello from Kiro'));
    assert.equal(events.at(-1).type,'execution.completed');assert.equal(events.at(-1).payload.response.messages[0].text,'Hello from Kiro');
    const calls=await f.requests();assert.ok(calls.find(m=>m.method==='session/prompt').params.prompt[0].text.includes('Task:\nHello'));
    assert.deepEqual(calls[0].params.clientCapabilities,{fs:{readTextFile:false,writeTextFile:false},terminal:false});
  }finally{runtime.stop();await f.close();}
});
test('Kiro resumes across restarts without replaying old messages and isolates identities', {timeout:5000},async()=>{
  const f=await fixture();let runtime=await f.start();
  try{
    await runtime.invoke(invocation,async()=>{},new AbortController().signal);runtime.stop();runtime=await f.start();
    const events=[];await runtime.invoke({...invocation,persistent_session:{resume:true}},async e=>events.push(e),new AbortController().signal);
    assert.equal(events.at(-1).payload.text,'Hello from Kiro');
    const calls=await f.requests(),prompts=calls.filter(m=>m.method==='session/prompt');assert.equal(prompts[0].params.sessionId,prompts[1].params.sessionId);
    runtime.stop();runtime=await f.start({identity:{...f.storage.identity,subject:'different-account'}});
    await assert.rejects(runtime.invoke({...invocation,persistent_session:{resume:true}},async()=>{},new AbortController().signal));
    assert.equal((await f.requests()).filter(m=>m.method==='session/prompt').length,2);
  }finally{runtime.stop();await f.close();}
});
for(const behavior of ['no-resume','wrong-mode'])test(`Kiro refuses incompatible runtime: ${behavior}`,async()=>{
 const f=await fixture(behavior);try{await assert.rejects(f.start());}finally{await f.close();}
});
for(const behavior of ['tool','tool-update','malformed','oversized'])test(`Kiro fails closed on ${behavior}`,{timeout:5000},async()=>{
 const f=await fixture(behavior);const runtime=await f.start();
 try{const events=[];await assert.rejects(runtime.invoke(invocation,async e=>events.push(e),new AbortController().signal));assert.equal(events.some(e=>e.type==='execution.completed'),false);assert.equal(runtime.alive(),false);}finally{runtime.stop();await f.close();}
});
test('stopping a Kiro turn waits for cancellation and leaves the runtime reusable', {timeout:5000},async()=>{
 const f=await fixture('wait');const runtime=await f.start();
 try{
  for(let i=0;i<2;i++){
   const controller=new AbortController();
   await assert.rejects(runtime.invoke({...invocation,session_id:i?'44444444-4444-4444-8444-444444444444':invocation.session_id},async e=>{if(e.payload.text==='Hello from Kiro')controller.abort(new AgentSessionStopped());},controller.signal),AgentSessionStopped);
   assert.equal(runtime.alive(),true);
  }
  assert.equal((await f.requests()).filter(m=>m.method==='session/cancel').length,2);
 }finally{runtime.stop();await f.close();}
});
test('Kiro never starts inference if Space does not acknowledge session readiness', {timeout:5000},async()=>{
 const f=await fixture();const runtime=await f.start();
 try{await assert.rejects(runtime.invoke(invocation,async e=>{if(e.payload.session_ready)throw Error('ack lost');},new AbortController().signal));assert.equal((await f.requests()).some(m=>m.method==='session/prompt'),false);}finally{runtime.stop();await f.close();}
});


test('Stop during session loading drains setup before the runtime is reusable', {timeout:5000},async()=>{
 const f=await fixture('slow-load');const runtime=await f.start();
 try{
  await runtime.invoke(invocation,async()=>{},new AbortController().signal);
  const controller=new AbortController();let settled=false;
  const stopped=assert.rejects(runtime.invoke({...invocation,persistent_session:{resume:true}},async()=>{},controller.signal),AgentSessionStopped).then(()=>{settled=true;});
  await f.loading;controller.abort(new AgentSessionStopped());
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(settled,false,'must wait for the outstanding session/load');
  await stopped;assert.equal(runtime.alive(),true);
  await runtime.invoke({...invocation,session_id:'44444444-4444-4444-8444-444444444444'},async()=>{},new AbortController().signal);
  assert.equal((await f.requests()).filter(m=>m.method==='session/prompt').length,2);
 }finally{runtime.stop();await f.close();}
});

test('Kiro cloud configuration status is bookkeeping, not a model tool request', async()=>{
 const f=await fixture('cloud-config');const runtime=await f.start();
 try{const events=[];await runtime.invoke(invocation,async e=>events.push(e),new AbortController().signal);assert.equal(events.at(-1).type,'execution.completed');assert.equal(runtime.alive(),true);}finally{runtime.stop();await f.close();}
});
