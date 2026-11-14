import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseInvocation } from '@space/contracts';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, readFile, realpath, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCodex } from '../dist/codex.js';
import { startKiro } from '../dist/kiro.js';
import { startClaude } from '../dist/claude.js';
const id = randomUUID();
const invocation = { schema_version: '1.0', task_id: randomUUID(), execution_id: id, session_id: randomUUID(), idempotency_key: id, goal: 'Work', skill: 'codex.run' };
const pdfToken = randomUUID() + '.' + 'a'.repeat(43);
const outbound = { url: 'https://space.example.com/mcp/outbound', token: 'short-lived-capability', tools: ['c123_search'] };

test('a paired PDF tool capability has a bounded format', () => {
  assert.equal(parseInvocation({ ...invocation, pdf_tool_token: pdfToken }).pdf_tool_token, pdfToken);
  assert.throws(() => parseInvocation({ ...invocation, pdf_tool_token: 'not-a-capability' }));
});

test('invocations accept a bounded gateway capability and reject unsafe URLs, credentials and tool names', () => {
  assert.deepEqual(parseInvocation({ ...invocation, outbound }).outbound, outbound);
  assert.equal(parseInvocation({ ...invocation, outbound: { ...outbound, url: 'http://127.0.0.1:3000/mcp/outbound' } }).outbound.url, 'http://127.0.0.1:3000/mcp/outbound');
  const maximum = Array.from({ length: 4000 }, (_, index) => `${index}_`.padEnd(128, 'x'));
  assert.deepEqual(parseInvocation({ ...invocation, outbound: { ...outbound, tools: maximum } }).outbound.tools, maximum);
  for (const bad of [
    { url: 'http://remote.example.com/mcp' }, { url: 'https://user:password@space.example.com/mcp' }, { url: 'https://space.example.com/mcp?token=secret' },
    { token: '' }, { token: 'x'.repeat(4097) }, { token: 'header\r\ninjection' }, { tools: ['*'] }, { tools: ['same', 'same'] }, { tools: ['x'.repeat(129)] }, { tools: Array.from({length: 4001}, (_, index) => `tool_${index}`) }, { tools: ['bad name'] }, { extra: true },
  ]) assert.throws(() => parseInvocation({ ...invocation, outbound: { ...outbound, ...bad } }));
});

function fakeLaunch(calls, onStart = () => {}, holdOutboundStartup = false) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null;
    const call = { command, args, options, stopped: false, messages: [], child }; calls.push(call);
    child.kill = () => { call.stopped = true; child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); return true; };
    onStart(call);
    const send = value => child.stdout.write(Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n'));
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      for (const line of chunk.toString().trim().split('\n')) {
        const m = JSON.parse(line); call.messages.push(m);
        queueMicrotask(() => {
          if (m.method === 'initialize') { if (!(holdOutboundStartup && options.env.SPACE_OUTBOUND_TOKEN)) send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }); }
          else if (['thread/start', 'thread/resume'].includes(m.method)) send({ id: m.id, result: { thread: { id: 'native-thread' } } });
          else if (m.method === 'turn/start') {
            send({ id: m.id, result: { turn: { id: 'turn' } } });
            if (options.env.SPACE_FILES_TOKEN) for (const method of ['item/started', 'item/completed']) send({ method, params: { threadId: 'native-thread', turnId: 'turn', item: { type: 'mcpToolCall', id: 'pdf', server: 'space_files', tool: 'read_pdf_page', arguments: { asset_id: id, page: 2 }, result: 'page text', status: 'completed' } } });
            if (options.env.SPACE_OUTBOUND_TOKEN) for (const method of ['item/started', 'item/completed']) send({ method, params: { threadId: 'native-thread', turnId: 'turn', item: { type: 'mcpToolCall', id: 'tool', server: 'space_outbound', tool: 'c123_search', arguments: { query: 'hello' }, result: 'found', status: 'completed' } } });
            send({ method: 'turn/completed', params: { threadId: 'native-thread', turnId: 'turn', turn: { id: 'turn', status: 'completed' } } });
          } else if (['session/new', 'session/load'].includes(m.method)) {
            send({ id: m.id, result: { sessionId: 'native-session', modes: { currentModeId: m.params._meta.kiro.modeId } } });
            send({ method: '_kiro/mcp/status', params: { sessionId: 'native-session', servers: [{ name: 'space_project', status: 'connected' }, { name: 'space_outbound', status: 'connected' }, { name: 'space_files', status: 'connected' }] } });
          } else if (m.method === 'session/prompt') {
            if (options.env.SPACE_FILES_TOKEN) for (const status of ['pending', 'completed']) send({ method: 'session/update', params: { sessionId: 'native-session', update: { sessionUpdate: status === 'pending' ? 'tool_call' : 'tool_call_update', toolCallId: 'pdf', status, rawInput: { asset_id: id, page: 2 }, rawOutput: 'page text', _meta: { kiro: { mcpTool: { serverName: 'space_files', toolName: 'read_pdf_page' } } } } } });
            if (options.env.SPACE_OUTBOUND_TOKEN) for (const status of ['pending', 'completed']) send({ method: 'session/update', params: { sessionId: 'native-session', update: { sessionUpdate: status === 'pending' ? 'tool_call' : 'tool_call_update', toolCallId: 'tool', status, rawInput: { query: 'hello' }, rawOutput: 'found', _meta: { kiro: { mcpTool: { serverName: 'space_outbound', toolName: 'c123_search' } } } } } });
            send({ id: m.id, result: { stopReason: 'end_turn' } });
          }
        });
      }
      done();
    } });
    return child;
  };
}

for (const provider of ['codex', 'kiro']) test(`${provider} scopes gateway credentials and tools to one process per turn while resuming native conversation`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'space-outbound-provider-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = { directory, connection: { origin: 'http://localhost:3000', workspace_id: 'w', installation_id: 'i', credential: 'registration', provider }, identity: { issuer: provider, subject: 'user', client_id: 'space' } };
  const calls = [], launch = fakeLaunch(calls);
  const runtime = provider === 'codex' ? await startCodex('provider-secret', () => {}, launch, storage) : await startKiro(storage, () => {}, launch);
  t.after(() => runtime.stop());
  for (const [index, capability] of [outbound, { ...outbound, token: 'second-capability' }, undefined].entries()) {
    const events = [];
    await runtime.invoke({ ...invocation, skill: `${provider}.run`, persistent_session: { resume: index > 0 }, ...(capability ? { outbound: capability, ...(index === 0 ? { pdf_tool_token: pdfToken } : {}) } : {}) }, async e => events.push(e), new AbortController().signal);
    const process = calls.at(-1);
    assert.equal(process.options.env.SPACE_OUTBOUND_TOKEN, capability?.token);
    assert.equal(process.options.env.SPACE_FILES_TOKEN, index === 0 ? pdfToken : undefined);
    assert.ok(!JSON.stringify(events).includes(pdfToken));
    if (capability) {
      assert.equal(process.stopped, true);
      assert.ok(events.at(-1).payload.response.tools.some(t => t.name === 'c123_search'));
      assert.equal(events.at(-1).payload.response.tools[0].status, 'completed');
      assert.ok(!JSON.stringify(process.args).includes(capability.token));
      assert.ok(!JSON.stringify(events).includes(capability.token));
      if (provider === 'codex') {
        const config = process.messages.find(m => ['thread/start', 'thread/resume'].includes(m.method)).params.config;
        if (index === 0) {
          assert.deepEqual(config.mcp_servers.space_files, { url: 'http://localhost:3000/v1/agent-tools/pdf', bearer_token_env_var: 'SPACE_FILES_TOKEN', enabled_tools: ['read_pdf_page'] });
        } else assert.equal(config.mcp_servers.space_files, undefined);
        assert.deepEqual(config.mcp_servers.space_outbound.enabled_tools, ['c123_search']);
        assert.equal(config.mcp_servers.space_outbound.bearer_token_env_var, 'SPACE_OUTBOUND_TOKEN');
        assert.ok(!process.args.some(arg => arg.includes('space_outbound')));
      } else {
        const profile = await readFile(join(process.options.env.HOME, '.kiro', 'agents', 'space-chat.json'), 'utf8');
        assert.ok(!profile.includes(capability.token));
        const config = JSON.parse(profile);
        assert.equal(config.tools.includes('@space_files/read_pdf_page'), index === 0);
        if (index === 0) assert.equal(config.mcpServers.space_files.headers.Authorization, 'Bearer ${SPACE_FILES_TOKEN}');
        assert.ok(!profile.includes(pdfToken));
        assert.ok(config.tools.includes('@space_outbound/c123_search'));
        assert.equal(config.mcpServers.space_outbound.headers.Authorization, 'Bearer ${SPACE_OUTBOUND_TOKEN}');
        assert.equal(config.mcpServers.space_outbound.timeout, 35000);
      }
    } else assert.equal(events.at(-1).payload.response.tools.length, 0);
    if (index > 0) assert.ok(process.messages.some(m => m.method === (provider === 'codex' ? 'thread/resume' : 'session/load')));
  }
  assert.equal(runtime.alive(), true);
  assert.equal(calls.length, 4);
});

for (const provider of ['codex', 'kiro']) test(`${provider} cancels outbound startup promptly without inference or a surviving capability process`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'space-outbound-cancel-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = { directory, connection: { origin: 'http://localhost:3000', workspace_id: 'w', installation_id: 'i', credential: 'registration', provider }, identity: { issuer: provider, subject: 'user', client_id: 'space' } };
  const calls = []; let started;
  const starting = new Promise(resolve => { started = resolve; });
  const launch = fakeLaunch(calls, call => { if (call.options.env.SPACE_OUTBOUND_TOKEN) started(); }, true);
  const runtime = provider === 'codex' ? await startCodex('provider-key', () => {}, launch, storage) : await startKiro(storage, () => {}, launch);
  t.after(() => { runtime.stop(); for (const call of calls) call.child.kill(); });
  const controller = new AbortController();
  const running = runtime.invoke({ ...invocation, skill: `${provider}.run`, outbound }, async () => {}, controller.signal);
  const rejected = assert.rejects(running);
  await starting; controller.abort();
  let timer;
  try { await Promise.race([rejected, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Startup ignored cancellation')), 250); })]); }
  finally { clearTimeout(timer); }
  assert.equal(calls.at(-1).stopped, true);
  assert.equal(calls.some(call => call.messages.some(m => ['turn/start', 'session/prompt'].includes(m.method))), false);
});

test('Claude binds exact outbound tools and fresh headers over SDK control, then removes them next turn', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'space-outbound-claude-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const run = ({ prompt, options }) => {
    const call = { options, closed: false, servers: {} }; calls.push(call);
    const iterator = (async function* () { for await (const input of prompt) {
      const session_id = input.session_id;
      if (call.servers.space_files) {
        yield { type:'assistant', session_id, message:{ id:'pdf-answer', content:[{type:'tool_use',id:'pdf-tool',name:'mcp__space_files__read_pdf_page',input:{asset_id:id,page:2}}] } };
        yield { type:'user', session_id, message:{content:[{type:'tool_result',tool_use_id:'pdf-tool',content:'page text'}]} };
      }
      if (call.servers.space_outbound) {
        yield { type: 'assistant', session_id, message: { id: 'answer', content: [{ type: 'tool_use', id: 'tool', name: 'mcp__space_outbound__c123_search', input: { query: 'hello' } }] } };
        yield { type: 'user', session_id, message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'found' }] } };
      }
      yield { type: 'result', subtype: 'success', is_error: false, session_id, result: 'Done' };
    } })();
    return Object.assign(iterator, { initializationResult: async () => ({}), setMcpServers: async servers => { call.servers = servers; return { errors: {} }; }, mcpServerStatus: async () => Object.keys(call.servers ?? {}).map(name => ({ name, status: 'connected' })), close: () => { call.closed = true; } });
  };
  const runtime = await startClaude('provider-key', { directory, connection: { origin: 'http://localhost:3000', workspace_id: 'w', installation_id: 'i', credential: 'registration', provider: 'claude' } }, () => {}, run);
  t.after(() => runtime.stop());
  for (const [index, capability] of [null, outbound, { ...outbound, token: 'second-capability' }, undefined].entries()) {
    const events = [];
    await runtime.invoke({ ...invocation, skill: 'claude.run', persistent_session: { resume: index > 0 }, ...(index === 0 ? {pdf_tool_token:pdfToken} : capability ? {outbound:capability} : {}) }, async e => events.push(e), new AbortController().signal);
    const call = calls.at(-1);
    assert.equal(call.closed, true);
    if (index === 0) {
      assert.equal(call.servers.space_files.headers.Authorization,'Bearer '+pdfToken);
      assert.deepEqual(call.options.allowedTools,['mcp__space_files__read_pdf_page']);
      assert.equal(call.servers.space_outbound,undefined);
      assert.deepEqual(events.at(-1).payload.response.tools.map(t=>t.name),['read_pdf_page']);
    } else if (capability) {
      assert.equal(call.servers.space_outbound.headers.Authorization, `Bearer ${capability.token}`);
      assert.deepEqual(call.options.allowedTools, ['mcp__space_outbound__c123_search']);
      assert.equal(call.servers.space_files, undefined);
      assert.ok(!JSON.stringify(events).includes(pdfToken));
      assert.ok(!JSON.stringify(call.options).includes(capability.token));
      assert.ok(events.at(-1).payload.response.tools.some(t => t.name === 'c123_search'));
      const hook = call.options.hooks.PreToolUse[0].hooks[0];
      assert.deepEqual(await hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__space_outbound__c123_search' }), {});
      assert.equal((await hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__space_outbound__ungranted' })).hookSpecificOutput.permissionDecision, 'deny');
    } else { assert.equal(call.servers.space_outbound, undefined); assert.deepEqual(call.options.allowedTools, []); }
    if (index > 0) assert.equal(call.options.resume, calls[1].options.sessionId);
  }
});

for (const provider of ['codex', 'kiro']) test(`${provider} exposes only the attached PDF tool without outbound access and clears it next turn`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'space-pdf-provider-')); t.after(() => rm(directory, {recursive:true,force:true}));
  const storage = { directory, connection:{origin:'http://localhost:3000',workspace_id:'w',installation_id:'i',credential:'registration',provider},identity:{issuer:provider,subject:'user',client_id:'space'} };
  const calls = [], launch = fakeLaunch(calls);
  const runtime = provider === 'codex' ? await startCodex('provider-secret', () => {}, launch, storage) : await startKiro(storage, () => {}, launch);
  t.after(() => runtime.stop());
  for (const pdf_tool_token of [pdfToken, undefined]) {
    const events = [];
    await runtime.invoke({...invocation,skill:`${provider}.run`,...(pdf_tool_token ? {pdf_tool_token} : {})}, async e => events.push(e),new AbortController().signal);
    const process=calls.at(-1);
    assert.equal(process.options.env.SPACE_FILES_TOKEN,pdf_tool_token);
    assert.equal(process.options.env.SPACE_OUTBOUND_TOKEN,undefined);
    assert.deepEqual(events.at(-1).payload.response.tools.map(t=>t.name),pdf_tool_token ? ['read_pdf_page'] : []);
    if (pdf_tool_token) {
      assert.equal(process.stopped,true);
      if(provider==='codex') {
        const servers=process.messages.find(m=>m.method==='thread/start').params.config.mcp_servers;
        assert.deepEqual(Object.keys(servers),['space_files']);
      } else {
        const profile=JSON.parse(await readFile(join(process.options.env.HOME,'.kiro','agents','space-chat.json'),'utf8'));
        assert.deepEqual(profile.tools,['@space_files/read_pdf_page']);
      }
    }
    assert.ok(!JSON.stringify(events).includes(pdfToken));
  }
});

for (const provider of ['codex','kiro','claude']) test(provider+' browser follow-ups retain the conversation but cannot inherit project, coding or PDF tools', async t => {
  const directory=await mkdtemp(join(tmpdir(),'space-browser-agent-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const storage={directory, project:directory, coding:true, connection:{origin:'http://localhost:3000',workspace_id:'w',installation_id:'i',credential:'reg',provider}, identity:{issuer:provider,subject:'user',client_id:'space'}};
  const calls=[], launch=fakeLaunch(calls);
  const claude=({prompt,options})=>{
    const call={options,servers:{}}; calls.push(call);
    return Object.assign((async function*(){for await(const input of prompt) yield {type:'result',subtype:'success',is_error:false,session_id:input.session_id,result:'Done'};})(),{
      initializationResult:async()=>({}),setMcpServers:async servers=>{call.servers=servers;return {errors:{}};},
      mcpServerStatus:async()=>Object.keys(call.servers).map(name=>({name,status:'connected'})),close:()=>{},
    });
  };
  const runtime=provider==='codex'?await startCodex('provider-secret',()=>{},launch,storage):
    provider==='kiro'?await startKiro(storage,()=>{},launch):await startClaude('provider-secret',storage,()=>{},claude);
  t.after(()=>runtime.stop());
  const context={thread_id:randomUUID(),messages:[],handoff:{browser_url:'https://github.com/org/repo',channel_id:randomUUID(),channel_name:'Browser',captured_at:new Date().toISOString(),messages:[]}};
  for (const resume of [false,true]) {
    await runtime.invoke({...invocation,skill:provider+'.run',context,pdf_tool_token:pdfToken,persistent_session:{resume},...(resume?{}:{outbound})},async()=>{},new AbortController().signal);
    const call=calls.at(-1);
    const servers=resume?[]:['space_outbound'];
    if(provider==='claude') {
      assert.deepEqual(Object.keys(call.servers),servers);
      assert.deepEqual(call.options.tools,[]);
      assert.equal(call.options.permissionMode,'dontAsk');
      if(resume) assert.equal(call.options.resume,calls.at(-2).options.sessionId);
    } else {
      assert.equal(call.options.env.SPACE_FILES_TOKEN,undefined);
      assert.equal(call.options.env.SPACE_OUTBOUND_TOKEN,resume?undefined:outbound.token);
      assert.equal(call.stopped,true);
      if(provider==='codex'){
        const start=call.messages.find(m=>m.method===(resume?'thread/resume':'thread/start'));
        assert.deepEqual(Object.keys(start.params.config.mcp_servers),servers);
        if (!resume) assert.deepEqual(start.params.config.mcp_servers.space_outbound.tools,{c123_search:{approval_mode:'approve'}});
        assert.ok(call.args.includes('features.shell_tool=false'));
        assert.ok(!call.args.some(arg=>arg.includes('mcp_servers.space_project')));
      }else{
        assert.ok(call.messages.some(m=>m.method===(resume?'session/load':'session/new')));
        const profile=JSON.parse(await readFile(join(call.options.env.HOME,'.kiro','agents','space-chat.json'),'utf8'));
        assert.deepEqual(Object.keys(profile.mcpServers),servers);
        assert.deepEqual(profile.tools,resume?[]:['@space_outbound/c123_search']);
      }
    }
  }
});

for (const provider of ['codex', 'kiro']) test(provider + ' switches selected project per session and resumes in the original folder', async t => {
  const {selectSessionProject} = await import('../dist/session-project.js');
  const directory = await realpath(await mkdtemp(join(tmpdir(),'space-folders-')));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const storage = {directory, projectKey:randomBytes(32).toString('base64url'), connection:{origin:'http://localhost:3000',workspace_id:'w',installation_id:'i',credential:'test',provider},
    identity:{issuer:provider,subject:'user',client_id:'space'}};
  const calls = [], launch = fakeLaunch(calls);
  const runtime = provider === 'codex' ? await startCodex('test',()=>{},launch,storage) : await startKiro(storage,()=>{},launch);
  t.after(()=>runtime.stop());
  const projects = await Promise.all(['first','second'].map(async name => {
    const path = join(directory,name), id = randomUUID();
    await mkdir(path);
    const {project_token} = await selectSessionProject(storage.connection,id,path,storage.projectKey);
    return {id,path,project_token};
  }));
  const signal = new AbortController().signal;
  const turn = (p, resume) => runtime.invoke({...invocation,skill:provider+'.run',session_id:p.id,
    persistent_session:{resume,project_token:p.project_token}}, async()=>{}, signal,
    {requestApproval:async approval=>{assert.ok(approval.details.includes(p.path));return 'allow';}});
  for (const [index, p] of [projects[0],projects[1],projects[0]].entries()) {
    await turn(p,index===2);
    const call = calls.at(-1);
    const method = provider==='codex' ? 'turn/start' : index===2 ? 'session/load' : 'session/new';
    assert.equal(call.messages.filter(m=>m.method===method).at(-1).params.cwd,p.path);
  }
  await assert.rejects(turn({...projects[0],project_token:projects[1].project_token},true),/selected project/);
  await rm(projects[0].path,{recursive:true});
  await assert.rejects(turn(projects[0],true),/selected project/);
});
