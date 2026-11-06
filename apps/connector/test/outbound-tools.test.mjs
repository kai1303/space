import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseInvocation } from '@space/contracts';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCodex } from '../dist/codex.js';
import { startKiro } from '../dist/kiro.js';
import { startClaude } from '../dist/claude.js';
const id = randomUUID();
const invocation = { schema_version: '1.0', task_id: randomUUID(), execution_id: id, session_id: randomUUID(), idempotency_key: id, goal: 'Work', skill: 'codex.run' };
const outbound = { url: 'https://space.example.com/mcp/outbound', token: 'short-lived-capability', tools: ['c123_search'] };

test('invocations accept a bounded gateway capability and reject unsafe URLs, credentials and tool names', () => {
  assert.deepEqual(parseInvocation({ ...invocation, outbound }).outbound, outbound);
  assert.equal(parseInvocation({ ...invocation, outbound: { ...outbound, url: 'http://127.0.0.1:3000/mcp/outbound' } }).outbound.url, 'http://127.0.0.1:3000/mcp/outbound');
  const maximum = Array.from({ length: 2000 }, (_, index) => `${index}_`.padEnd(128, 'x'));
  assert.deepEqual(parseInvocation({ ...invocation, outbound: { ...outbound, tools: maximum } }).outbound.tools, maximum);
  for (const bad of [
    { url: 'http://remote.example.com/mcp' }, { url: 'https://user:password@space.example.com/mcp' }, { url: 'https://space.example.com/mcp?token=secret' },
    { token: '' }, { token: 'x'.repeat(4097) }, { token: 'header\r\ninjection' }, { tools: ['*'] }, { tools: ['same', 'same'] }, { tools: ['x'.repeat(129)] }, { tools: Array(2001).fill('tool') }, { tools: ['bad name'] }, { extra: true },
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
            if (options.env.SPACE_OUTBOUND_TOKEN) for (const method of ['item/started', 'item/completed']) send({ method, params: { threadId: 'native-thread', turnId: 'turn', item: { type: 'mcpToolCall', id: 'tool', server: 'space_outbound', tool: 'c123_search', arguments: { query: 'hello' }, result: 'found', status: 'completed' } } });
            send({ method: 'turn/completed', params: { threadId: 'native-thread', turnId: 'turn', turn: { id: 'turn', status: 'completed' } } });
          } else if (['session/new', 'session/load'].includes(m.method)) {
            send({ id: m.id, result: { sessionId: 'native-session', modes: { currentModeId: 'space-chat' } } });
            send({ method: '_kiro/mcp/status', params: { sessionId: 'native-session', servers: [{ name: 'space_project', status: 'connected' }, { name: 'space_outbound', status: 'connected' }] } });
          } else if (m.method === 'session/prompt') {
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
    await runtime.invoke({ ...invocation, skill: `${provider}.run`, persistent_session: { resume: index > 0 }, ...(capability ? { outbound: capability } : {}) }, async e => events.push(e), new AbortController().signal);
    const process = calls.at(-1);
    assert.equal(process.options.env.SPACE_OUTBOUND_TOKEN, capability?.token);
    if (capability) {
      assert.equal(process.stopped, true);
      assert.equal(events.at(-1).payload.response.tools[0].name, 'c123_search');
      assert.equal(events.at(-1).payload.response.tools[0].status, 'completed');
      assert.ok(!JSON.stringify(process.args).includes(capability.token));
      assert.ok(!JSON.stringify(events).includes(capability.token));
      if (provider === 'codex') {
        const config = process.messages.find(m => ['thread/start', 'thread/resume'].includes(m.method)).params.config;
        assert.deepEqual(config.mcp_servers.space_outbound.enabled_tools, ['c123_search']);
        assert.equal(config.mcp_servers.space_outbound.bearer_token_env_var, 'SPACE_OUTBOUND_TOKEN');
        assert.ok(!process.args.some(arg => arg.includes('space_outbound')));
      } else {
        const profile = await readFile(join(process.options.env.HOME, '.kiro', 'agents', 'space-chat.json'), 'utf8');
        assert.ok(!profile.includes(capability.token));
        const config = JSON.parse(profile);
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
  for (const [index, capability] of [outbound, { ...outbound, token: 'second-capability' }, undefined].entries()) {
    const events = [];
    await runtime.invoke({ ...invocation, skill: 'claude.run', persistent_session: { resume: index > 0 }, ...(capability ? { outbound: capability } : {}) }, async e => events.push(e), new AbortController().signal);
    const call = calls.at(-1);
    assert.equal(call.closed, true);
    if (capability) {
      assert.equal(call.servers.space_outbound.headers.Authorization, `Bearer ${capability.token}`);
      assert.deepEqual(call.options.allowedTools, ['mcp__space_outbound__c123_search']);
      assert.ok(!JSON.stringify(call.options).includes(capability.token));
      assert.equal(events.at(-1).payload.response.tools[0].name, 'c123_search');
      const hook = call.options.hooks.PreToolUse[0].hooks[0];
      assert.deepEqual(await hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__space_outbound__c123_search' }), {});
      assert.equal((await hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__space_outbound__ungranted' })).hookSpecificOutput.permissionDecision, 'deny');
    } else { assert.equal(call.servers.space_outbound, undefined); assert.deepEqual(call.options.allowedTools, []); }
    if (index > 0) assert.equal(call.options.resume, calls[1].options.sessionId);
  }
});
