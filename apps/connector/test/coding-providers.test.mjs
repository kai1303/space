import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startCodex } from '../dist/codex.js';
import { startClaude } from '../dist/claude.js';
import { startKiro } from '../dist/kiro.js';
import { AgentSessionStopped } from '../dist/agent-runtime.js';

const request = provider => {const execution_id=randomUUID();return {schema_version:'1.0',task_id:randomUUID(),execution_id,idempotency_key:execution_id,session_id:randomUUID(),skill:`${provider}.run`,goal:'Edit README, test and commit.'};};
async function storage(t, provider) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'space-coding-provider-'))), project=join(directory,'project');await mkdir(project);
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return {directory,project,coding:true,connection:{origin:'http://localhost',workspace_id:'w',installation_id:'i',credential:'c',provider},identity:{issuer:provider,subject:'s',client_id:'c'}};
}
async function codexFixture(t, behavior='normal') {
  const store=await storage(t,'codex'), log=join(store.directory,'rpc.jsonl');let launchOptions,launchArgs,launchedChild;
  const runtime=await startCodex('test-token',()=>{},(_cmd,args,options)=>{
    launchArgs=args;launchOptions=options;
    return launchedChild=spawn(process.execPath,['-e',`
      const fs=require('node:fs');const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
      let turn,approved=0;
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},line+'\\n');
        const scope={threadId:'thread',turnId:'turn'};
        if(m.method==='initialize')send({id:m.id,result:{userAgent:'fixture'}});
        else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'thread'}}});
        else if(m.method==='turn/start'){
          turn=m;send({id:m.id,result:{turn:{id:'turn'}}});
          send({method:'item/started',params:{...scope,item:{id:'shell',type:'commandExecution',command:'git status',cwd:m.params.cwd,status:'inProgress'}}});
          send({id:'foreign',method:'item/commandExecution/requestApproval',params:{...scope,turnId:'another-turn',itemId:'shell',command:'bad'}});
          send({id:'permission',method:'item/commandExecution/requestApproval',params:{...scope,itemId:'shell',command:'git status',cwd:m.params.cwd}});
          if(${JSON.stringify(behavior)}==='permissions'){
            send({id:'files',method:'item/fileChange/requestApproval',params:{...scope,itemId:'file',reason:'Update README',grantRoot:m.params.cwd}});
            send({id:'grant',method:'item/permissions/requestApproval',params:{...scope,itemId:'grant',cwd:m.params.cwd,permissions:{network:{enabled:true}}}});
          }
        } else if(['permission','files','grant'].includes(m.id)){
          if(${JSON.stringify(behavior)}==='wait')return;
          if(${JSON.stringify(behavior)}==='permissions'&&++approved<3)return;
          send({method:'item/completed',params:{...scope,item:{id:'shell',type:'commandExecution',command:'git status',cwd:turn.params.cwd,status:m.result?.decision==='accept'?'completed':'declined',aggregatedOutput:'On branch main'}}});
          if(${JSON.stringify(behavior)}==='long')for(let i=0;i<50;i++)send({method:'item/completed',params:{...scope,item:{id:'message-'+i,type:'agentMessage',text:'x'.repeat(1000)}}});
          for(let i=0;i<35;i++) send({method:'item/completed',params:{...scope,item:{id:'read-'+i,type:'commandExecution',command:'cat README.md',cwd:turn.params.cwd,status:'completed',aggregatedOutput:'Read '+i}}});
          send({method:'item/completed',params:{...scope,item:{id:'edit',type:'fileChange',status:'completed',changes:[{path:'README.md',kind:{type:'update'},diff:'--- a/README.md\\n+++ b/README.md\\n@@ -1 +1 @@\\n-old\\n+new'}]}}});
          send({method:'turn/completed',params:{...scope,turn:{id:'turn',status:'completed'}}});
        } else if(m.method==='turn/interrupt') {send({id:m.id,result:{}});send({method:'turn/completed',params:{...scope,turn:{id:'turn',status:'interrupted'}}});}
      });
    `],options);
  },store);
  t.after(()=>runtime.stop());
  return {runtime,store,killProvider:()=>launchedChild.kill(),get launchArgs(){return launchArgs;},get launchOptions(){return launchOptions;},calls:async()=> (await readFile(log,'utf8')).trim().split('\n').map(JSON.parse)};
}

test('Codex coding scopes approvals and native execution, streams terminal/patch results, and survives tool bursts', async t=>{
  const f=await codexFixture(t), approvals=[], events=[];
  await f.runtime.invoke(request('codex'),async e=>events.push(e),new AbortController().signal,{requestApproval:async input=>{approvals.push(input);return 'allow';}});
  assert.deepEqual(approvals.map(a=>a.kind),['project','command']);
  const calls=await f.calls(), thread=calls.find(m=>m.method==='thread/start'),turn=calls.find(m=>m.method==='turn/start');
  assert.equal(thread.params.cwd,f.store.project);assert.equal(thread.params.sandbox,'workspace-write');assert.equal(turn.params.approvalPolicy,'on-request');
  assert.deepEqual(turn.params.sandboxPolicy.writableRoots,[f.store.project]);assert.equal(turn.params.sandboxPolicy.networkAccess,false);
  assert.equal(calls.find(m=>m.id==='foreign'&&!m.method).result.decision,'decline');
  assert.equal(calls.find(m=>m.id==='permission'&&!m.method).result.decision,'accept');
  assert.ok(f.launchArgs.includes('features.shell_tool=true'));assert.notEqual(f.launchOptions.env.HOME,process.env.HOME);
  const response=events.at(-1).payload.response;assert.equal(events.at(-1).type,'execution.completed');assert.equal(response.tools.length,30);
  assert.equal(response.outputs.changes[0].path,'README.md');assert.match(response.outputs.changes[0].patch,/\+new/);assert.equal(response.tools.at(-1).name,'apply_patch');assert.match(response.tools.at(-1).result,/\+new/);assert.ok(response.tools.some(tool=>tool.result==='Read 34'));
});

test('Codex coding without controls or with denied project never starts inference', async t=>{
  for(const controls of [undefined,{requestApproval:async()=> 'deny'}]){
    const f=await codexFixture(t);await assert.rejects(f.runtime.invoke(request('codex'),async()=>{},new AbortController().signal,controls));
    assert.equal((await f.calls()).some(m=>m.method==='turn/start'),false);
  }
});

test('Codex Stop cancels a pending approval and interrupts only its current turn', async t=>{
  const f=await codexFixture(t,'wait'),controller=new AbortController();let reached;
  const waiting=new Promise(resolve=>reached=resolve);
  const invocation=f.runtime.invoke(request('codex'),async()=>{},controller.signal,{requestApproval:async (input,signal)=>{
    if(input.kind==='project')return 'allow';reached();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }});
  await waiting;controller.abort(new AgentSessionStopped());await assert.rejects(invocation,AgentSessionStopped);
  assert.equal(f.runtime.alive(),true);assert.equal((await f.calls()).find(m=>m.id==='permission'&&!m.method).result.decision,'decline');
});

async function claudeFixture(t, behavior='normal') {
  const store=await storage(t,'claude'),calls=[];
  const runtime=await startClaude('test-key',store,()=>{},({prompt,options})=>{
    calls.push(options);
    const iterator=(async function*(){for await(const _ of prompt){
      const id=options.sessionId, hook=options.hooks.PreToolUse[0].hooks[0];
      assert.equal((await hook({hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command:'git status'}})).hookSpecificOutput.permissionDecision,'ask');
      assert.equal((await hook({hook_event_name:'PreToolUse',tool_name:'Read',tool_input:{file_path:'README.md'}})).hookSpecificOutput.permissionDecision,'ask');
      assert.equal((await hook({hook_event_name:'PreToolUse',tool_name:'Agent',tool_input:{}})).hookSpecificOutput.permissionDecision,'deny');
      assert.equal((await hook({hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command:'sleep 100',run_in_background:true}})).hookSpecificOutput.permissionDecision,'deny');
      const allowed=await options.canUseTool('Bash',{command:'git status'},{signal:options.abortController.signal,toolUseID:'shell'});
      assert.equal(allowed.behavior,'allow');assert.equal(allowed.updatedPermissions,undefined);
      assert.equal((await options.canUseTool('Unknown',{}, {signal:options.abortController.signal})).behavior,'deny');
      if(behavior!=='normal') {
        const count=behavior==='overflow'?129:35;
        for(let i=0;i<count;i++) yield {type:'assistant',uuid:'start-'+i,session_id:id,message:{id:'start-'+i,content:[{type:'tool_use',id:'parallel-'+i,name:'Read',input:{file_path:'file-'+i}}]}};
        for(let i=0;i<count;i++) yield {type:'user',session_id:id,message:{content:[{type:'tool_result',tool_use_id:'parallel-'+i,content:'Result '+i}]}};
        if(behavior==='unknown-result')yield {type:'user',session_id:id,message:{content:[{type:'tool_result',tool_use_id:'never-started',content:'Untrusted'}]}};
        if(behavior==='unknown-tool')yield {type:'assistant',uuid:'unknown',session_id:id,message:{id:'unknown',content:[{type:'tool_use',id:'unknown',name:'Agent',input:{}}]}};
        yield {type:'result',subtype:'success',is_error:false,session_id:id,result:'Done'};
        continue;
      }
      yield {type:'assistant',uuid:'a',session_id:id,message:{id:'a',content:[{type:'tool_use',id:'shell',name:'Bash',input:{command:'git status'}}]}};
      yield {type:'user',session_id:id,message:{content:[{type:'tool_result',tool_use_id:'shell',content:'On branch main'}]}};
      yield {type:'assistant',uuid:'b',session_id:id,message:{id:'b',content:[{type:'tool_use',id:'edit',name:'Edit',input:{file_path:'README.md',old_string:'old',new_string:'new'}}]}};
      yield {type:'user',session_id:id,tool_use_result:{filePath:'README.md',structuredPatch:[{oldStart:1,oldLines:1,newStart:1,newLines:1,lines:['-old','+new']}]},message:{content:[{type:'tool_result',tool_use_id:'edit',content:'Updated README.md'}]}};
      yield {type:'result',subtype:'success',is_error:false,session_id:id,result:'Done'};
    }})();
    return Object.assign(iterator,{initializationResult:async()=>({}),setMcpServers:async()=>({errors:{}}),mcpServerStatus:async()=>[],close(){}});
  });
  t.after(()=>runtime.stop());return {runtime,store,calls};
}
test('Claude native tools always ask, reject unknown/background tools, use project cwd and preserve isolated auth',async t=>{
  const f=await claudeFixture(t), approvals=[],events=[];
  await f.runtime.invoke(request('claude'),async e=>events.push(e),new AbortController().signal,{requestApproval:async i=>{approvals.push(i);return 'allow';}});
  assert.deepEqual(approvals.map(a=>a.kind),['project','command']);
  const options=f.calls.at(-1);assert.equal(options.cwd,f.store.project);assert.equal(options.permissionMode,'default');assert.ok(options.tools.includes('Bash'));
  assert.notEqual(options.env.HOME,process.env.HOME);assert.deepEqual(options.settingSources,[]);
  assert.match(events.at(-1).payload.response.outputs.changes[0].patch,/\+new/);assert.equal(events.at(-1).payload.response.tools[0].name,'Bash');assert.equal(events.at(-1).payload.response.tools[0].result,'On branch main');
});
test('Claude coding fails closed before inference when no owner approval channel exists',async t=>{
  const f=await claudeFixture(t);await assert.rejects(f.runtime.invoke(request('claude'),async()=>{},new AbortController().signal));assert.equal(f.calls.length,1);
});

async function kiroFixture(t, offered='allow_once', behavior='normal') {
  const store=await storage(t,'kiro'),log=join(store.directory,'rpc.jsonl');let env,launchedChild;
  const runtime=await startKiro(store,()=>{},(_command,_args,options)=>{
    env=options.env;
    return launchedChild=spawn(process.execPath,['-e',`
      const fs=require('node:fs');const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');let prompt;
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},line+'\\n');
        const update=u=>send({method:'session/update',params:{sessionId:'native-session',update:u}});
        if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
        else if(m.method==='session/new')send({id:m.id,result:{sessionId:'native-session',modes:{currentModeId:'space-coding'}}});
        else if(m.method==='session/prompt'){
          prompt=m;update({sessionUpdate:'tool_call',toolCallId:'shell',kind:'execute',status:'pending',rawInput:{command:'git status'},_meta:{kiro:{toolId:'execute_bash'}}});
          const p={sessionId:'native-session',toolCall:{toolCallId:'shell',kind:'execute',title:'Run git status',rawInput:{command:'git status'}},options:[{optionId:'this-call',kind:${JSON.stringify(offered)}},{optionId:'reject',kind:'reject_once'}],_meta:{kiro:{consent:{capability:'shell',resource:'git status',workspaceRoot:m.params.cwd}}}};
          send({id:'foreign',method:'session/request_permission',params:{...p,sessionId:'other-session'}});
          send({id:'permission',method:'session/request_permission',params:p});
        } else if(m.id==='permission'){
          update({sessionUpdate:'tool_call_update',toolCallId:'shell',status:m.result.outcome.optionId==='this-call'?'completed':'failed',rawOutput:'On branch main'});
          if(${JSON.stringify(behavior)}==='long')for(let i=0;i<45;i++){update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Message '+i}});update({sessionUpdate:'tool_call',toolCallId:'read-'+i,kind:'read',status:'completed',rawInput:{path:'README.md'},rawOutput:'read'});}
          update({sessionUpdate:'tool_call',toolCallId:'edit',kind:'edit',status:'completed',rawInput:{path:'README.md'},content:[{type:'diff',path:'README.md',oldText:'old',newText:'new'}]});
          send({id:prompt.id,result:{stopReason:'end_turn'}});
        }
      });
    `],options);
  });
  t.after(()=>runtime.stop());return {runtime,store,env,killProvider:()=>launchedChild.kill(),calls:async()=> (await readFile(log,'utf8')).trim().split('\n').map(JSON.parse)};
}
test('Kiro uses coding profile, native telemetry and only the offered allow_once option',async t=>{
  const f=await kiroFixture(t),approvals=[],events=[];
  await f.runtime.invoke(request('kiro'),async e=>events.push(e),new AbortController().signal,{requestApproval:async input=>{approvals.push(input);return 'allow';}});
  const profile=JSON.parse(await readFile(join(f.env.HOME,'.kiro/agents/space-coding.json'),'utf8'));
  assert.ok(profile.tools.includes('execute_bash'));assert.ok(profile.permissions.rules.some(r=>r.capability==='shell'&&r.effect==='ask'));
  assert.ok(!profile.permissions.rules.some(r=>r.capability==='shell'&&r.effect==='allow'));
  assert.deepEqual(approvals.map(a=>a.kind),['project','command']);
  const calls=await f.calls();assert.equal(calls.find(m=>m.id==='foreign'&&!m.method).result.outcome.optionId,'reject');assert.equal(calls.find(m=>m.id==='permission'&&!m.method).result.outcome.optionId,'this-call');
  assert.equal(calls.filter(m=>m.method==='session/new').at(-1).params.cwd,f.store.project);
  assert.equal(events.at(-1).payload.response.tools[0].result,'On branch main');assert.match(events.at(-1).payload.response.outputs.changes[0].patch,/\+new/);
});
test('Kiro never substitutes allow_always when one-time approval is absent',async t=>{
  const f=await kiroFixture(t,'allow_always'), approvals=[];
  await f.runtime.invoke(request('kiro'),async()=>{},new AbortController().signal,{requestApproval:async input=>{approvals.push(input);return 'allow';}});
  assert.deepEqual(approvals.map(a=>a.kind),['project']);assert.equal((await f.calls()).find(m=>m.id==='permission'&&!m.method).result.outcome.optionId,'reject');
});


test('long coding turns retain a bounded recent message window alongside tool bursts',async t=>{
  const f=await codexFixture(t,'long'),events=[];
  await f.runtime.invoke(request('codex'),async e=>events.push(e),new AbortController().signal,{requestApproval:async()=> 'allow'});
  assert.equal(events.at(-1).type,'execution.completed');
  const response=events.at(-1).payload.response;
  assert.equal(response.messages.at(-1).id,'message-49');
  assert.ok(response.messages.length<=30);assert.ok(response.messages.map(m=>m.text).join('\n\n').length<=16000);
  assert.ok(JSON.stringify(response).length<=64000);
});


test('Kiro coding message identities remain unique after the recent window rolls over',async t=>{
  const f=await kiroFixture(t,'allow_once','long'),events=[];
  await f.runtime.invoke(request('kiro'),async e=>events.push(e),new AbortController().signal,{requestApproval:async()=> 'allow'});
  const response=events.at(-1).payload.response;
  assert.equal(events.at(-1).type,'execution.completed');assert.equal(response.messages.length,30);
  assert.equal(new Set(response.messages.map(m=>m.id)).size,30);
  assert.equal(response.messages.at(-1).id,'answer-45');assert.equal(response.messages.at(-1).text,'Message 44');
});

test('Kiro coding without approval controls never submits a prompt',async t=>{
  const f=await kiroFixture(t);await assert.rejects(f.runtime.invoke(request('kiro'),async()=>{},new AbortController().signal));
  assert.equal((await f.calls()).some(m=>m.method==='session/prompt'),false);
});


for (const [provider, fixture] of [['codex',codexFixture],['kiro',kiroFixture]]) test(`${provider} exits promptly when provider dies during initial project approval`, {timeout:3000}, async t=>{
  const f=await fixture(t);let reached,aborted=false;
  const waiting=new Promise(resolve=>reached=resolve);
  const invocation=f.runtime.invoke(request(provider),async()=>{},new AbortController().signal,{requestApproval:async(input,signal)=>{
    assert.equal(input.kind,'project');reached();
    return new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}));
  }});
  const rejected=assert.rejects(invocation);
  await waiting;f.killProvider();await rejected;
  assert.equal(aborted,true);assert.equal(f.runtime.alive(),false);
  assert.equal((await f.calls()).some(m=>['session/prompt','turn/start'].includes(m.method)),false);
});


test('Codex grants native file requests once and permission profiles only for the current turn',async t=>{
  const f=await codexFixture(t,'permissions'),approvals=[];
  await f.runtime.invoke(request('codex'),async()=>{},new AbortController().signal,{requestApproval:async input=>{approvals.push(input);return 'allow';}});
  assert.deepEqual(approvals.map(a=>a.kind),['project','command','file_change','permissions']);
  const calls=await f.calls();
  assert.deepEqual(calls.find(m=>m.id==='files'&&!m.method).result,{decision:'accept'});
  assert.deepEqual(calls.find(m=>m.id==='grant'&&!m.method).result,{permissions:{network:{enabled:true}},scope:'turn'});
});


test('Claude preserves the newest timeline when 35 parallel calls complete after eviction',async t=>{
  const f=await claudeFixture(t,'parallel'),events=[];
  await f.runtime.invoke(request('claude'),async e=>events.push(e),new AbortController().signal,{requestApproval:async()=> 'allow'});
  const response=events.at(-1).payload.response;
  assert.equal(events.at(-1).type,'execution.completed');assert.equal(response.tools.length,30);
  assert.equal(response.tools[0].id,'parallel-5');assert.equal(response.tools.at(-1).id,'parallel-34');
  assert.ok(response.tools.every(tool=>tool.status==='completed'&&tool.result===`Result ${tool.id.slice(9)}`));
  assert.ok(JSON.stringify(response).length<=64000);
});
for(const behavior of ['unknown-result','unknown-tool','overflow'])test(`Claude parallel telemetry still fails closed on ${behavior}`,async t=>{
  const f=await claudeFixture(t,behavior),events=[];
  await assert.rejects(f.runtime.invoke(request('claude'),async e=>events.push(e),new AbortController().signal,{requestApproval:async()=> 'allow'}));
  assert.equal(events.at(-1).type,'execution.failed');assert.equal(f.runtime.alive(),false);
});
