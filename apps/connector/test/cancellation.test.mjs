import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Server } from 'socket.io';
import { startCodex, AgentSessionStopped } from '../dist/codex.js';
import { connectPlatform } from '../dist/runtime.js';

const invocation = {
  schema_version: '1.0', task_id: '11111111-1111-4111-8111-111111111111',
  execution_id: '22222222-2222-4222-8222-222222222222', session_id: '33333333-3333-4333-8333-333333333333',
  idempotency_key: '22222222-2222-4222-8222-222222222222', goal: 'First turn', skill: 'codex.run', persistent_session: { resume: false },
};
function nextInvocation(id, resume = true) { return { ...invocation, execution_id: id, idempotency_key: id, persistent_session: { resume } }; }
const event = (request, sequence, type) => ({ id: '66666666-6666-4666-8666-666666666666', schema_version: '1.0', execution_id: request.execution_id, sequence, type, occurred_at: new Date().toISOString(), payload: { text: 'Working' } });

test('explicit Stop interrupts and drains the exact Codex turn before resuming or claiming another session', { timeout: 7000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'space-cancel-test-')), log = join(directory, 'child.jsonl');
  const http = createServer(), io = new Server(http);
  const acceptedEvents = [], statuses = [];
  let claims = 0, finishes = 0, failures = 0, launches = 0, complete;
  const completed = new Promise(resolve => { complete = resolve; });
  const second = nextInvocation('77777777-7777-4777-8777-777777777777');
  const third = { ...nextInvocation('88888888-8888-4888-8888-888888888888', false), session_id: '99999999-9999-4999-8999-999999999999' };
  io.of('/agents').on('connection', socket => {
    socket.on('agent.heartbeat', (payload, ack) => { statuses.push(payload.auth_status); ack({ data: { installation_id: 'i' } }); });
    socket.on('agent.task.claim', (_payload, ack) => { const requests = [invocation, second, third]; ack({ data: requests[claims++] ?? null }); if (claims === 4) complete(); });
    socket.on('agent.task.event', ({ event }, ack) => {
      if (event.execution_id === invocation.execution_id && event.type === 'execution.progress' && !event.payload.session_ready) { ack({ error: 'agent_session_stopped' }); return; }
      acceptedEvents.push(event); ack({ data: true });
    });
    socket.on('agent.task.finish', (_payload, ack) => { finishes++; ack({ data: true }); });
    socket.on('agent.task.fail', (_payload, ack) => { failures++; ack({ data: true }); complete(); });
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const connection = { origin: `http://127.0.0.1:${http.address().port}`, credential: 'credential', installation_id: 'i', workspace_id: 'w' };
  const codex = await startCodex('token', () => {}, (_command, _args, options) => {
    launches++;
    return spawn(process.execPath, ['-e', `
      const fs = require('node:fs'), crypto = require('node:crypto');
      const log = value => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(value) + '\\n');
      const send = value => console.log(JSON.stringify(value));
      let buffer = '', turns = 0, interrupted = false, previous;
      process.stdin.on('data', chunk => { buffer += chunk; while (buffer.includes('\\n')) {
        const line = buffer.slice(0, buffer.indexOf('\\n')); buffer = buffer.slice(buffer.indexOf('\\n') + 1);
        const message = JSON.parse(line);
        if (message.method === 'initialize') send({ id: message.id, result: {} });
        else if (message.method === 'thread/start' || message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: message.params.threadId ?? crypto.randomUUID() } } });
        else if (message.method === 'turn/start') {
          const threadId = message.params.threadId, turnId = crypto.randomUUID();
          if (++turns > 1 && !interrupted) process.exit(44);
          log({ type: 'turn', threadId, turnId });
          send({ id: message.id, result: { turn: { id: turnId } } });
          const params = { threadId, turnId, itemId: 'answer', delta: 'Current answer' };
          send({ method: 'item/agentMessage/delta', params });
          if (turns === 1) previous = params;
          else {
            send({ method: 'item/agentMessage/delta', params: { ...previous, delta: 'STALE OLD TURN' } });
            send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
          }
        } else if (message.method === 'turn/interrupt') {
          log({ type: 'interrupt', ...message.params });
          setTimeout(() => { log({ type: 'interrupt-ack' }); send({ id: message.id, result: {} }); }, 60);
          setTimeout(() => {
            interrupted = true; log({ type: 'interrupted' });
            send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: message.params.turnId, status: 'interrupted' } } });
          }, 120);
        }
      }});
    `], options);
  }, { directory, connection, identity: { issuer: 'issuer', subject: 'subject', client_id: 'client' } });
  const platform = connectPlatform(connection, () => codex.alive() ? 'ready' : 'error', () => {}, codex.invoke);
  try {
    await completed;
    assert.equal(finishes, 2); assert.equal(failures, 0); assert.equal(launches, 1);
    assert.equal(codex.alive(), true);
    assert.equal(statuses.includes('error'), false);
    assert.equal(acceptedEvents.some(e => e.execution_id === invocation.execution_id && e.type === 'execution.completed'), false);
    assert.equal(JSON.stringify(acceptedEvents).includes('STALE OLD TURN'), false);
    const records = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(r => r.type), ['turn', 'interrupt', 'interrupt-ack', 'interrupted', 'turn', 'turn']);
    const turns = records.filter(r => r.type === 'turn');
    assert.equal(turns[0].threadId, turns[1].threadId);
    assert.notEqual(turns[0].threadId, turns[2].threadId);
    assert.equal(records[1].turnId, turns[0].turnId);
  } finally { platform.close(); codex.stop(); await new Promise(resolve => io.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});

test('explicit Stop from renewal waits for invoke cleanup and continues without halting or failing the cleared delivery', { timeout: 8000 }, async () => {
  const http = createServer(), io = new Server(http);
  let claims = 0, finishes = 0, failures = 0, cleaned = false, complete, reason;
  const statuses = [], completed = new Promise(resolve => { complete = resolve; });
  io.of('/agents').on('connection', socket => {
    socket.on('agent.heartbeat', (payload, ack) => { statuses.push(payload.auth_status); ack({ data: { installation_id: 'i' } }); });
    socket.on('agent.task.claim', (_payload, ack) => {
      claims++;
      if (claims === 1) ack({ data: invocation });
      else if (claims === 2) { assert.equal(cleaned, true); ack({ data: nextInvocation('77777777-7777-4777-8777-777777777777') }); }
      else { ack({ data: null }); complete(); }
    });
    socket.on('agent.task.renew', (_payload, ack) => ack({ error: 'agent_session_stopped' }));
    socket.on('agent.task.event', (_payload, ack) => ack({ data: true }));
    socket.on('agent.task.finish', (_payload, ack) => { finishes++; ack({ data: true }); });
    socket.on('agent.task.fail', (_payload, ack) => { failures++; ack({ data: true }); complete(); });
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const platform = connectPlatform({ origin: `http://127.0.0.1:${http.address().port}`, credential: 'credential', installation_id: 'i', workspace_id: 'w' }, () => 'ready', () => {}, async (request, emit, signal) => {
    if (request.execution_id === invocation.execution_id) {
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); reason = signal.reason;
      await new Promise(resolve => setTimeout(resolve, 80)); cleaned = true; throw signal.reason;
    }
    await emit(event(request, 1, 'execution.completed'));
  });
  try { await completed; assert.equal(reason?.name, 'AgentSessionStopped'); assert.equal(finishes, 1); assert.equal(failures, 0); assert.equal(statuses.includes('error'), false); }
  finally { platform.close(); await new Promise(resolve => io.close(resolve)); }
});

test('Stop reported while finishing a completed turn preserves readiness for the next claim', { timeout: 5000 }, async () => {
  const http = createServer(), io = new Server(http);
  let claims = 0, finishes = 0, failures = 0, complete;
  const completed = new Promise(resolve => { complete = resolve; });
  io.of('/agents').on('connection', socket => {
    socket.on('agent.heartbeat', (_payload, ack) => ack({ data: { installation_id: 'i' } }));
    socket.on('agent.task.claim', (_payload, ack) => { claims++; ack({ data: claims < 3 ? nextInvocation(claims === 1 ? invocation.execution_id : '77777777-7777-4777-8777-777777777777') : null }); if (claims === 3) complete(); });
    socket.on('agent.task.event', (_payload, ack) => ack({ data: true }));
    socket.on('agent.task.finish', (_payload, ack) => { finishes++; ack(finishes === 1 ? { error: 'agent_session_stopped' } : { data: true }); });
    socket.on('agent.task.fail', (_payload, ack) => { failures++; ack({ data: true }); complete(); });
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const platform = connectPlatform({ origin: `http://127.0.0.1:${http.address().port}`, credential: 'credential', installation_id: 'i', workspace_id: 'w' }, () => 'ready', () => {}, async (request, emit) => { await emit(event(request, 1, 'execution.completed')); });
  try { await completed; assert.equal(finishes, 2); assert.equal(failures, 0); }
  finally { platform.close(); await new Promise(resolve => io.close(resolve)); }
});


test('unconfirmed deliberate interruption stops app-server and prevents subsequent inference', { timeout: 5000 }, async () => {
  const codex = await startCodex('token', () => {}, (_command, _args, options) => spawn(process.execPath, ['-e', `
    const send = value => console.log(JSON.stringify(value)); let buffer = '';
    process.stdin.on('data', chunk => { buffer += chunk; while (buffer.includes('\\n')) {
      const line = buffer.slice(0, buffer.indexOf('\\n')); buffer = buffer.slice(buffer.indexOf('\\n') + 1);
      const message = JSON.parse(line);
      if (message.method === 'initialize') send({id:message.id,result:{}});
      if (message.method === 'thread/start') send({id:message.id,result:{thread:{id:'thread'}}});
      if (message.method === 'turn/start') {
        send({id:message.id,result:{turn:{id:'turn'}}});
        send({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn',itemId:'answer',delta:'Working'}});
      }
      if (message.method === 'turn/interrupt') send({id:message.id,error:{code:-1,message:'unconfirmed'}});
    }});
  `], options));
  const controller = new AbortController(), events = [];
  const request = { ...invocation, persistent_session: undefined };
  try {
    await assert.rejects(codex.invoke(request, async event => { events.push(event); if (event.type === 'execution.progress') { controller.abort(new AgentSessionStopped()); throw controller.signal.reason; } }, controller.signal), /interruption was not confirmed/);
    assert.equal(codex.alive(), false);
    await assert.rejects(codex.invoke(request, async () => {}, new AbortController().signal));
    assert.equal(events.some(event => event.type === 'execution.completed'), false);
  } finally { codex.stop(); }
});
