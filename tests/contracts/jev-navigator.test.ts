import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { NavigationContext } from '@space/contracts';
import { JevNavigatorProvider } from '@space/core/jev-navigator';
import { createNavigatorProviders } from '@space/core/navigator-providers';
const context:NavigationContext={pendingMessageIds:['m3'],messages:[{id:'m1',text:'We need a launch summary.'},{id:'m2',text:'Should we ask Writer to prepare it?'},{id:'m3',text:'Yes, please do that.'}],candidates:[{installation_id:'writer',name:'Writer',skill:'writing.summarize',description:'Summarize conversations'},{installation_id:'debug',name:'Debug',skill:'engineering.investigate',description:'Investigate failures'}],rules:[]};
function response(values:Record<string,number>={}){return {model:'jev-1.14.0',answers:Object.fromEntries(Object.entries({requests_agent_work:.97,task_clear:.98,continues_existing_work:.05,capability_0:.95,capability_1:.02,...values}).map(([id,noul])=>[id,{type:'noul',noul}])),usage:{input_tokens:450,output_tokens:30}};}
async function fixture(t:{after:(fn:()=>void)=>void},handler:(req:IncomingMessage,res:ServerResponse)=>void){const s=createServer(handler);await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));t.after(()=>{s.closeAllConnections();s.close();});return `http://127.0.0.1:${(s.address() as {port:number}).port}/v1/systemone`;}
function provider(body:unknown){return new JevNavigatorProvider({apiKey:'fixture-key',fetch:async()=>new Response(JSON.stringify(body))});}

test('native Jev sends history and last human message separately, with independent typed questions',async t=>{
 let request:any;
 const endpoint=await fixture(t,(req,res)=>{assert.equal(req.url,'/v1/systemone');assert.equal(req.headers.authorization,'Bearer fixture-key');let body='';req.on('data',c=>body+=c);req.on('end',()=>{request=JSON.parse(body);res.end(JSON.stringify(response()));});});
 const p=new JevNavigatorProvider({endpoint,apiKey:'fixture-key'});const result=await p.decide(context,1,new AbortController().signal);
 assert.equal(result.decision.action,'suggest');assert.deepEqual(result.decision.capabilities,['writing.summarize']);assert.deepEqual(result.decision.evidenceMessageIds,['m3']);
 assert.equal(result.decision.assessment?.requestsAgentWork,.97);assert.equal(result.decision.assessment?.targetMessageId,'m3');
 assert.deepEqual(request.state.last_message,{id:'m3',text:'Yes, please do that.'});assert.deepEqual(request.state.history,context.messages.slice(0,2));
 assert.ok(Object.values(request.questions).every((q:any)=>q.type==='noul'));assert.match(request.questions.requests_agent_work.instructions,/last_message/);assert.ok(request.questions.requests_agent_work.criteria.false.includes('discuss'));
 assert.equal(request.messages,undefined);assert.equal(request.max_tokens,undefined);assert.equal(result.inputTokens,450);assert.equal(result.outputTokens,30);
 assert.ok(p.estimateTokens(context,1)>=Buffer.byteLength(JSON.stringify(request)));
});
test('only clear new execution requests suggest, even when several capabilities are relevant',async()=>{
 const result=await provider(response({capability_0:.9,capability_1:.8})).decide({...context,messages:[{id:'m3',text:'Investigate the outage, then summarize the verified root cause.'}]},1,new AbortController().signal);
 assert.equal(result.decision.action,'suggest');assert.deepEqual(result.decision.capabilities,['writing.summarize','engineering.investigate']);
 assert.equal(result.decision.assessment?.version,'execution-intent-v1');
});
test('discussion and existing work without active sessions stay quiet while uncertain requests escalate',async()=>{
 const cases:Record<string,number>[]=[{requests_agent_work:.02},{continues_existing_work:.9}];
 for(const values of cases)assert.equal((await provider(response(values)).decide(context,1,new AbortController().signal)).decision.action,'ignore');
 const uncertain:Record<string,number>[]=[{requests_agent_work:.5},{task_clear:.5},{task_clear:.1},{continues_existing_work:.4},{capability_0:.5,capability_1:.4}];
 for(const values of uncertain)assert.equal((await provider(response(values)).decide(context,1,new AbortController().signal)).decision.action,'escalate');
 const unavailable=await provider(response({capability_0:.02,capability_1:.01})).decide(context,1,new AbortController().signal);
 assert.equal(unavailable.decision.action,'clarify');
});
test('targets only the last pending human message and rejects missing, agent or ambiguous targets before HTTP',async()=>{
 let calls=0;const p=new JevNavigatorProvider({apiKey:'fixture',fetch:async()=>{calls++;return new Response(JSON.stringify(response()));}});
 for(const invalid of [{...context,messages:context.messages.map(m=>({...m,truncated:true}))},{...context,pendingMessageIds:['missing']},{...context,messages:[...context.messages,{id:'m3',text:'duplicate'}]},{...context,messages:context.messages.map(m=>m.id==='m3'?{...m,author:{kind:'agent' as const,id:'writer'}}:m)}])await assert.rejects(p.decide(invalid,1,new AbortController().signal));
 await assert.rejects(p.decide(context,2,new AbortController().signal));assert.equal(calls,0);
});
test('malformed probabilities, missing answers, invalid usage and secrets in errors fail closed',async()=>{
 const bad=response();delete (bad.answers as any).capability_0;
 for(const body of [response({requests_agent_work:1.1}),response({capability_0:-1}),response({task_clear:NaN}),bad,{...response(),usage:{input_tokens:-1,output_tokens:0}},{secret:'secret-response'}])await assert.rejects(provider(body).decide(context,1,new AbortController().signal),e=>!String(e).includes('secret-response'));
});
test('provider configuration is explicit, default remains rules-compatible, and Jev cannot occupy Level 2',()=>{
 assert.deepEqual(createNavigatorProviders({}),{});assert.deepEqual(createNavigatorProviders({TYPESAFE_API_KEY:'unused'}),{});
 assert.throws(()=>createNavigatorProviders({NAVIGATOR_L1_PROVIDER:'jev'}));
 const configured=createNavigatorProviders({NAVIGATOR_L1_PROVIDER:'jev',TYPESAFE_API_KEY:'fixture',NAVIGATOR_L2_URL:'https://example.test/chat/completions',NAVIGATOR_L2_MODEL:'reasoning'});
 assert.ok(configured.level1 instanceof JevNavigatorProvider);assert.equal(configured.level2?.model,'reasoning');
 assert.throws(()=>createNavigatorProviders({NAVIGATOR_L2_PROVIDER:'jev',TYPESAFE_API_KEY:'fixture'}));
});

test('native transport bounds requests, timeouts, responses and rejects credential redirects',async t=>{
 let calls=0;const hanging=new JevNavigatorProvider({apiKey:'fixture',timeoutMs:25,fetch:()=>{calls++;return new Promise(()=>{});}});
 await assert.rejects(hanging.decide(context,1,new AbortController().signal));assert.equal(calls,1);
 const p=new JevNavigatorProvider({apiKey:'fixture',fetch:async()=>{calls++;return new Response('x'.repeat(65537));}});
 await assert.rejects(p.decide({...context,messages:[{id:'m3',text:'x'.repeat(40000)}]},1,new AbortController().signal));assert.equal(calls,1);
 await assert.rejects(p.decide(context,1,AbortSignal.abort()));assert.equal(calls,1);
 await assert.rejects(p.decide(context,1,new AbortController().signal));assert.equal(calls,2);
 let redirected=0;const target=await fixture(t,(_req,res)=>{redirected++;res.end(JSON.stringify(response()));});
 const endpoint=await fixture(t,(_req,res)=>{res.writeHead(307,{location:target});res.end();});
 await assert.rejects(new JevNavigatorProvider({endpoint,apiKey:'fixture'}).decide(context,1,new AbortController().signal));assert.equal(redirected,0);
 for(const endpoint of ['http://example.test/v1/systemone','https://user:secret@example.test/v1/systemone','https://example.test/chat/completions','https://example.test/v1/systemone?key=secret'])assert.throws(()=>new JevNavigatorProvider({endpoint,apiKey:'fixture'}));
});

test('thresholds are validated and capability questions deduplicate shared skills',async()=>{
 for(const options of [{yesThreshold:.5},{noThreshold:.5},{yesThreshold:NaN},{noThreshold:-.1}])assert.throws(()=>new JevNavigatorProvider({apiKey:'fixture',...options}));
 let received:any;const p=new JevNavigatorProvider({apiKey:'fixture',fetch:async(_url,init)=>{received=JSON.parse(String(init?.body));return new Response(JSON.stringify(response()));}});
 await p.decide({...context,candidates:[...context.candidates,{...context.candidates[0]!,installation_id:'second-writer'}]},1,new AbortController().signal);
 assert.equal(received.state.available_capabilities.length,2);assert.equal(Object.keys(received.questions).length,5);
});

test('bounded history may omit earlier pending messages while retaining the last human target',async()=>{
 const result=await provider(response()).decide({...context,pendingMessageIds:['outside-history-window','m3']},1,new AbortController().signal);
 assert.equal(result.decision.action,'suggest');assert.equal(result.decision.assessment?.targetMessageId,'m3');
});

test('Jev receives working memory as reference data while keeping the last message as its target', async () => {
  let request:any;
  const p=new JevNavigatorProvider({apiKey:'fixture',fetch:async(_url,init)=>{request=JSON.parse(init!.body as string);return new Response(JSON.stringify(response()));}});
  const workingMemory={root:null,checkpoint:{revision:1,through_sequence:'1',content:'# Decision\nPrepare a launch summary.',summary:'Prepare a launch summary',source_message_ids:['m1'],producer_id:'fixture',producer_name:'Writer',created_at:new Date().toISOString()}};
  await p.decide({...context,workingMemory},1,new AbortController().signal);
  assert.deepEqual(request.state.working_memory,workingMemory);
  assert.equal(request.state.last_message.id,'m3');
  assert.deepEqual(request.state.history,context.messages.slice(0,2));
});

test('Jev receives bounded pending proposals and work status as reference data',async()=>{
 let request:any;let calls=0;
 const p=new JevNavigatorProvider({apiKey:'fixture',fetch:async(_url,init)=>{calls++;request=JSON.parse(String(init?.body));return new Response(JSON.stringify(response()));}});
 const workState={pendingProposals:[{id:'proposal',goal:'Summarize the launch',capabilities:['writing.summarize']}],tasks:[{id:'task',goal:'Investigate outage',skill:'engineering.investigate',status:'completed'}],sessions:[{id:'session',title:'Outage investigation',skill:'engineering.investigate',state:'ended'}]};
 await p.decide({...context,workState},1,new AbortController().signal);
 assert.deepEqual(request.state.work_state,workState);
 assert.equal(request.questions.assistance_useful,undefined);assert.equal(request.questions.needs_deeper_reasoning,undefined);
 assert.match(request.questions.task_clear.instructions,/proposal/);
 await assert.rejects(p.decide({...context,workState:{...workState,tasks:Array(9).fill(workState.tasks[0])}},1,new AbortController().signal));
 assert.equal(calls,1);
});

test('existing work with active sessions escalates for follow-up classification even without new execution intent', async () => {
 const workState={pendingProposals:[],tasks:[],sessions:[{id:'session',title:'Write summary',skill:'writing.summarize',state:'active'}]};
 const result=await provider(response({requests_agent_work:.02,continues_existing_work:.98})).decide({...context,workState},1,new AbortController().signal);
 assert.equal(result.decision.action,'escalate');
 assert.deepEqual(result.decision.capabilities,[]);
 assert.equal((await provider(response({requests_agent_work:.02,continues_existing_work:.05})).decide({...context,workState},1,new AbortController().signal)).decision.action,'ignore');
});
