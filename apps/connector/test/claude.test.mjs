import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSessionStopped } from '../dist/agent-runtime.js';

const executionId = randomUUID();
const request = { schema_version:'1.0', task_id:randomUUID(), execution_id:executionId, session_id:randomUUID(), idempotency_key:executionId, skill:'claude.run', goal:'Hello', context:{thread_id:randomUUID(), messages:[]} };
const textEvents = id => [
 {type:'stream_event',session_id:id,event:{type:'message_start',message:{id:'answer'}}},
 {type:'stream_event',session_id:id,event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}},
 {type:'stream_event',session_id:id,event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Hello'}}},
 {type:'assistant',session_id:id,message:{id:'answer',content:[{type:'text',text:'Hello'}]}},
 {type:'result',subtype:'success',is_error:false,session_id:id,result:'Hello'},
];
async function fixture(t, events = textEvents) {
 const {startClaude} = await import('../dist/claude.js');
 const directory = await mkdtemp(join(tmpdir(),'space-claude-'));
 const storage = {directory,connection:{origin:'http://localhost:3000',workspace_id:'w',installation_id:'i',credential:'credential',provider:'claude'}};
 const calls=[]; let consumed=0;
 const run=({prompt,options})=>{
  const call={options,closed:false,prompt};calls.push(call);
  const iterator=(async function*(){
   for await(const input of prompt){ consumed++;call.input=input;
    for(const event of events(options.resume??options.sessionId,options)){
     options.abortController.signal.throwIfAborted(); yield event;
    }
   }
  })();
  return Object.assign(iterator,{initializationResult:async()=>({}),setMcpServers:async servers=>{call.servers=servers;return {added:Object.keys(servers),removed:[],errors:{}};},mcpServerStatus:async()=>[{name:'space_project',status:'connected'}],close(){call.closed=true;}});
 };
 const start=(overrides={},key='test-key')=>startClaude(key,{...storage,...overrides},()=>{},run);
 const runtime=await start();
 t.after(async()=>{runtime.stop();await rm(directory,{recursive:true,force:true});});
 const invoke=async(overrides={},emit=async()=>{},signal=new AbortController().signal)=>{
  const output=[];await runtime.invoke({...request,...overrides},async e=>{output.push(e);await emit(e);},signal);return output;
 };
 return {runtime,start,invoke,calls,storage,get consumed(){return consumed;}};
}
test('Claude streams bounded ordered output and keeps API credentials and settings local',async t=>{
 const f=await fixture(t);const events=await f.invoke();
 assert.equal(events[0].type,'execution.started');assert.equal(events.at(-1).type,'execution.completed');
 assert.equal(events.at(-1).payload.response.messages[0].text,'Hello');
 assert.deepEqual(events.map(e=>e.sequence),events.map((_,i)=>i+1));
 const o=f.calls.at(-1).options;assert.deepEqual(o.tools,[]);assert.deepEqual(o.settingSources,[]);assert.equal(o.strictMcpConfig,true);
 assert.equal(o.env.ANTHROPIC_API_KEY,'test-key');assert.notEqual(o.env.HOME,process.env.HOME);assert.equal(o.env.CLAUDE_CODE_OAUTH_TOKEN,undefined);
 assert.equal(o.permissionMode,'dontAsk');assert.equal(o.persistSession,false);assert.equal(f.calls.every(c=>c.closed),true);
 assert.ok(!JSON.stringify(events).includes('test-key'));
});
test('Claude waits for durable readiness before inference, resumes after restart, and isolates credentials',async t=>{
 const f=await fixture(t);
 await f.invoke({persistent_session:{resume:false}},async e=>{if(e.payload.session_ready)assert.equal(f.consumed,0);});
 const first=f.calls.at(-1).options;
 f.runtime.stop();const restarted=await f.start();
 await restarted.invoke({...request,persistent_session:{resume:true}},async()=>{},new AbortController().signal);restarted.stop();
 assert.equal(f.calls.at(-1).options.resume,first.sessionId);
 assert.equal(f.calls.at(-1).options.cwd,first.cwd);
 const other=await f.start({},'different-key');
 await assert.rejects(other.invoke({...request,persistent_session:{resume:true}},async()=>{},new AbortController().signal));other.stop();
});
test('Claude missing session state fails without inference and leaves other sessions usable',async t=>{
 const f=await fixture(t);await assert.rejects(f.invoke({persistent_session:{resume:true}}));assert.equal(f.consumed,0);assert.equal(f.runtime.alive(),true);await f.invoke();
});
test('Claude enables only selected project MCP tools and preserves tool order',async t=>{
 const f=await fixture(t,id=>[
  {type:'assistant',session_id:id,message:{id:'intro',content:[{type:'text',text:'Reading'},{type:'tool_use',id:'tool',name:'mcp__space_project__read_text_file',input:{path:'a.txt'}}]}},
  {type:'user',session_id:id,message:{content:[{type:'tool_result',tool_use_id:'tool',content:'file content'}]}},...textEvents(id)
 ]);
 const runtime=await f.start({project:f.storage.directory});const events=[];
 await runtime.invoke(request,async e=>events.push(e),new AbortController().signal);runtime.stop();
 const o=f.calls.at(-1).options;assert.deepEqual(o.tools,[]);assert.ok(o.allowedTools.includes('mcp__space_project__read_text_file'));assert.ok(!o.allowedTools.includes('Bash'));
 assert.deepEqual(f.calls.at(-1).servers.space_project.args.slice(-1),[await realpath(f.storage.directory)]);
 const out=events.at(-1).payload.response;assert.equal(out.tools[0].status,'completed');assert.equal(out.tools[0].result,'file content');
 assert.deepEqual(out.items.map(i=>i.type),['message','tool','message']);
});
test('Claude rejects unsupported tool events and sanitizes failed provider output',async t=>{
 const f=await fixture(t,id=>[{type:'assistant',session_id:id,message:{id:'bad',content:[{type:'tool_use',id:'bad',name:'Bash',input:{command:'secret'}}]}}]);
 const events=[];await assert.rejects(f.invoke({},async e=>events.push(e)),/Claude/);
 assert.equal(events.at(-1).type,'execution.failed');assert.ok(!JSON.stringify(events).includes('secret'));assert.equal(f.runtime.alive(),false);
});
test('Claude rejects oversized output and error results',async t=>{
 for(const value of ['x'.repeat(16001),null]){
  const f=await fixture(t,id=>value===null?[{type:'result',subtype:'error_during_execution',session_id:id,errors:['secret-key']}]:[{type:'assistant',session_id:id,message:{id:'answer',content:[{type:'text',text:value}]}}]);
  await assert.rejects(f.invoke());assert.equal(f.runtime.alive(),false);
 }
});
test('Stop during readiness never submits inference and keeps runtime usable',async t=>{
 const f=await fixture(t),c=new AbortController();
 await assert.rejects(f.invoke({persistent_session:{resume:false}},async e=>{if(e.payload.session_ready){c.abort(new AgentSessionStopped());throw c.signal.reason;}},c.signal),AgentSessionStopped);
 assert.equal(f.consumed,0);assert.equal(f.runtime.alive(),true);assert.equal(f.calls.every(c=>c.closed),true);await f.invoke();
});
test('Claude rejects overlapping turns and stops streaming on cancellation',async t=>{
 const f=await fixture(t),c=new AbortController();let tried=false;
 await assert.rejects(f.invoke({},async e=>{
  if(e.type==='execution.progress'&&!tried){tried=true;await assert.rejects(f.invoke(),/busy/);c.abort(new AgentSessionStopped());}
 },c.signal),AgentSessionStopped);
 assert.equal(f.runtime.alive(),true);assert.equal(f.calls.at(-1).closed,true);await f.invoke();
});

test('bundled Claude SDK initializes project tools without inference and fully stops its processes', {timeout:20000}, async t=>{
 const {startClaude}=await import('../dist/claude.js');
 const directory=await mkdtemp(join(tmpdir(),'space-claude-sdk-'));
 try {
  const runtime=await startClaude('test-key-no-inference',{directory,project:directory,connection:{origin:'http://localhost:3000',workspace_id:'test',installation_id:'test',credential:'test',provider:'claude'}},()=>{});
  assert.equal(runtime.alive(),true);runtime.stop();
 } finally {await rm(directory,{recursive:true,force:true});}
});

test('Claude permission hook denies every tool outside the project allowlist',async t=>{
 const f=await fixture(t);await f.invoke();
 const hooks=f.calls.at(-1).options.hooks.PreToolUse;
 assert.equal(hooks[0].onFailure,'block');
 const deny=await hooks[0].hooks[0]({hook_event_name:'PreToolUse',tool_name:'Bash'});
 assert.equal(deny.hookSpecificOutput.permissionDecision,'deny');
});

test('real SDK streams a loopback Messages API reply and resumes the saved transcript after restart', {timeout:30000}, async()=>{
 const {createServer}=await import('node:http');
 const {query}=await import('@anthropic-ai/claude-agent-sdk');
 const {startClaude}=await import('../dist/claude.js');
 const directory=await mkdtemp(join(tmpdir(),'space-claude-stream-'));
 const project=join(directory,'fixture');await mkdir(project);const note=join(await realpath(project),'note.txt');await writeFile(note,'verified-file-content');
 const bodies=[];
 const http=createServer(async(req,res)=>{
  if(!req.url.startsWith('/v1/messages')){res.writeHead(404).end();return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString());bodies.push(body);
  const id=`msg_${randomUUID()}`,usage={input_tokens:12,output_tokens:3};
  const message={id,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage};
  if(!body.stream){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({...message,content:[{type:'text',text:'Aurora'}],stop_reason:'end_turn'}));return;}
  res.writeHead(200,{'content-type':'text/event-stream'});
  const readFile = JSON.stringify(body.messages).includes('Remember the name Aurora') && !JSON.stringify(body.messages).includes('tool_result');
  const block = readFile ? {type:'tool_use',id:'toolu_read',name:'mcp__space_project__read_text_file',input:{}} : {type:'text',text:''};
  const delta = readFile ? {type:'input_json_delta',partial_json:JSON.stringify({path:note})} : {type:'text_delta',text:'Aurora'};
  for(const event of [{type:'message_start',message},{type:'content_block_start',index:0,content_block:block},{type:'content_block_delta',index:0,delta},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:readFile?'tool_use':'end_turn',stop_sequence:null},usage},{type:'message_stop'}])res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
 });
 await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
 const storage={directory,project,connection:{origin:'http://localhost:3000',workspace_id:'test',installation_id:'test',credential:'test',provider:'claude'}};
 const start=()=>startClaude('test-key-loopback',storage,()=>{},({prompt,options})=>query({prompt,options:{...options,env:{...options.env,ANTHROPIC_BASE_URL:`http://127.0.0.1:${http.address().port}`}}}));
 let runtime;
 try {
  for(const resume of [false,true]){
   runtime=await start(); const events=[];
   await runtime.invoke({...request,goal:resume?'Recall the name':'Remember the name Aurora',persistent_session:{resume}},async event=>events.push(event),AbortSignal.timeout(12000));
   assert.equal(events.at(-1).payload.text,'Aurora');assert.equal(events.at(-1).payload.response.messages.length,1);
   if(!resume){const tool=events.at(-1).payload.response.tools[0];assert.equal(tool.status,'completed');assert.match(tool.result,/verified-file-content/);}
   runtime.stop();
  }
  const followup=bodies.find(body=>JSON.stringify(body.messages).includes('Recall the name'));
  assert.ok(followup.messages.some(m=>m.role==='assistant'&&JSON.stringify(m.content).includes('Aurora')));
 }finally{runtime?.stop();http.closeAllConnections();await new Promise(resolve=>http.close(resolve));await rm(directory,{recursive:true,force:true});}
});

test('Claude finalizes streamed text once when the SDK delivers a single block after thinking',async t=>{
 const f=await fixture(t,id=>textEvents(id).map(e=>e.type==='stream_event'&&'index' in e.event ? {...e,event:{...e.event,index:1}} : e));
 const events=await f.invoke();assert.deepEqual(events.at(-1).payload.response.messages.map(m=>m.text),['Hello']);
});

test('Claude native runtime uses the installed executable and the native login profile',async t=>{
 const f=await fixture(t);
 const auth={command:'/fixture/claude',directory:f.storage.directory,identity:{issuer:'claude-code',subject:'account-one',client_id:'space-claude-local'}};
 const runtime=await f.start({},auth);
 try{
  const events=[];await runtime.invoke(request,async e=>events.push(e),new AbortController().signal);
  const options=f.calls.at(-1).options;
  assert.equal(options.pathToClaudeCodeExecutable,auth.command);
  assert.equal(options.env.ANTHROPIC_API_KEY,undefined);
  assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN,undefined);
  assert.ok(options.env.CLAUDE_CONFIG_DIR.includes('claude-home'));
  assert.equal(events.at(-1).type,'execution.completed');
 }finally{runtime.stop();}
});
