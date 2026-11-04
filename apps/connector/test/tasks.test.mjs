import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { startCodex, connectPlatform } from '../dist/runtime.js';

const invocation = {
  schema_version: '1.0', task_id: '11111111-1111-4111-8111-111111111111',
  execution_id: '22222222-2222-4222-8222-222222222222', session_id: '33333333-3333-4333-8333-333333333333',
  idempotency_key: '22222222-2222-4222-8222-222222222222', goal: 'Say hello', skill: 'codex.run',
  context: { thread_id: '44444444-4444-4444-8444-444444444444', messages: [{ id: '55555555-5555-4555-8555-555555555555', text: 'My name is Kai', author_type: 'human' }] },
};
function launchFake(behavior, inspect = () => {}) {
  return (_command, args, options) => {
    inspect(args, options);
    return spawn(process.execPath, ['-e', `
      const send = value => console.log(JSON.stringify(value));
      let buffer = '';
      process.stdin.on('data', chunk => { buffer += chunk; while (buffer.includes('\\n')) {
        const line = buffer.slice(0, buffer.indexOf('\\n')); buffer = buffer.slice(buffer.indexOf('\\n') + 1);
        const message = JSON.parse(line);
        if (message.method === 'initialize') send({ id: message.id, result: {} });
        else if (message.method === 'thread/start') {
          if (!message.params.ephemeral || message.params.sandbox !== 'read-only' || message.params.approvalPolicy !== 'never') process.exit(42);
          send({ id: message.id, result: { thread: { id: 'thread-1' } } });
        } else if (message.method === 'turn/start') {
          if (!message.params.input[0].text.includes('My name is Kai')) process.exit(43);
          send({ id: message.id, result: { turn: { id: 'turn-1' } } });
          ${behavior}
        } else if (message.method === 'turn/interrupt') { send({ id: message.id, result: {} }); }
      }});
    `], options);
  };
}
const delta = text => `send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer-1', delta: ${JSON.stringify(text)} } });`;
const completed = status => `send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: '${status}', items: [] } } });`;

test('approved Codex invocation streams snapshots, completes only on completed turn, and uses isolated directories', { timeout: 5000 }, async () => {
  let home, cwd;
  const runtime = await startCodex('token', () => {}, launchFake(delta('Hello ') + delta('Kai!') + completed('completed'), (args, options) => {
    home = options.env.CODEX_HOME; cwd = options.cwd;
    assert.notEqual(home, process.env.CODEX_HOME);
    assert.notEqual(cwd, process.cwd());
    assert.ok(args.includes('features.shell_tool=false'));
    assert.ok(args.includes('features.plugins=false'));
  }));
  const events = [];
  try {
    assert.equal(typeof runtime.invoke, 'function');
    await runtime.invoke(invocation, async event => { await new Promise(resolve => setTimeout(resolve, 5)); events.push(event); }, new AbortController().signal);
    assert.equal(events[0].type, 'execution.started');
    assert.equal(events.at(-1).type, 'execution.completed');
    assert.equal(events.at(-1).payload.text, 'Hello Kai!');
    assert.deepEqual(events.at(-1).payload.response.messages, [{ id: 'answer-1', text: 'Hello Kai!', status: 'complete' }]);
    assert.deepEqual(events.map(event => event.sequence), events.map((_, i) => i + 1));
    assert.equal(new Set(events.map(event => event.id)).size, events.length);
    assert.ok(events.length <= 4);
  } finally { runtime.stop(); }
  // Cleanup is asynchronous because the child must exit first.
  const cleanupDeadline = Date.now() + 2000;
  while (Date.now() < cleanupDeadline) {
    try { await access(home); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await assert.rejects(access(home), { code: 'ENOENT' });
});

test('failed Codex turns emit a safe failed event and never complete', { timeout: 5000 }, async () => {
  const runtime = await startCodex('secret-token', () => {}, launchFake(completed('failed')));
  const events = [];
  try {
    assert.equal(typeof runtime.invoke, 'function');
    await assert.rejects(runtime.invoke(invocation, async event => { events.push(event); }, new AbortController().signal));
    assert.equal(events.at(-1).type, 'execution.failed');
    assert.equal(events.some(event => event.type === 'execution.completed'), false);
    assert.equal(JSON.stringify(events).includes('secret-token'), false);
  } finally { runtime.stop(); }
});

test('abort interrupts Codex and prevents terminal publication', { timeout: 5000 }, async () => {
  const runtime = await startCodex('token', () => {}, launchFake(delta('Waiting')));
  const controller = new AbortController();
  const events = [];
  try {
    assert.equal(typeof runtime.invoke, 'function');
    const running = runtime.invoke(invocation, async event => { events.push(event); if (event.type === 'execution.progress') controller.abort(); }, controller.signal);
    await assert.rejects(running);
    assert.equal(events.some(event => event.type === 'execution.completed'), false);
  } finally { runtime.stop(); }
});

test('successive tasks create fresh Codex threads and reset streaming state', { timeout: 5000 }, async () => {
  const runtime = await startCodex('token', () => {}, launchFake(delta('Fresh answer') + completed('completed')));
  try {
    assert.equal(typeof runtime.invoke, 'function');
    for (const execution_id of [invocation.execution_id, '77777777-7777-4777-8777-777777777777']) {
      const events = [];
      await runtime.invoke({ ...invocation, execution_id, idempotency_key: execution_id }, async event => { events.push(event); }, new AbortController().signal);
      assert.equal(events[0].sequence, 1);
      assert.equal(events.at(-1).payload.text, 'Fresh answer');
      assert.equal(events.every(event => event.execution_id === execution_id), true);
    }
  } finally { runtime.stop(); }
});

test('oversized model output fails safely without forwarding it to Space', { timeout: 5000 }, async () => {
  const runtime = await startCodex('token', () => {}, launchFake(delta('x'.repeat(16001)) + completed('completed')));
  const events = [];
  try {
    await assert.rejects(runtime.invoke(invocation, async event => { events.push(event); }, new AbortController().signal));
    assert.equal(events.some(event => event.type === 'execution.completed'), false);
    assert.equal(events.at(-1).type, 'execution.failed');
    assert.ok(events.every(event => event.payload.text.length <= 16000));
  } finally { runtime.stop(); }
});

async function platformFixture(handlers, invoke) {
  const http = createServer();
  const io = new Server(http);
  io.of('/agents').on('connection', socket => {
    socket.on('agent.heartbeat', (_payload, ack) => ack({ data: { installation_id: 'i' } }));
    handlers(socket);
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const platform = connectPlatform({ origin: `http://127.0.0.1:${http.address().port}`, credential: 'credential', installation_id: 'i', workspace_id: 'w' }, () => 'ready', () => {}, invoke);
  const close = async () => { platform.close(); await new Promise(resolve => io.close(resolve)); };
  close.publish = platform.publish;
  return close;
}

test('platform claims one approved task, awaits persisted events, then finishes without overlapping claims', { timeout: 5000 }, async () => {
  let calls = 0, claims = 0, active = false;
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const event = { id: '66666666-6666-4666-8666-666666666666', schema_version: '1.0', execution_id: invocation.execution_id, sequence: 1, type: 'execution.completed', occurred_at: new Date().toISOString(), payload: { text: 'Hello' } };
  const close = await platformFixture(socket => {
    socket.on('agent.task.claim', (_payload, ack) => { assert.equal(active, false); claims++; active = true; ack({ data: invocation }); });
    socket.on('agent.task.event', (payload, ack) => { assert.deepEqual(payload, { event }); setTimeout(() => ack({ data: true }), 20); });
    socket.on('agent.task.finish', (payload, ack) => { assert.deepEqual(payload, {}); active = false; ack({ data: true }); finish(); });
  }, async (request, emit) => { calls++; assert.deepEqual(request, invocation); await emit(event); });
  try { await finished; assert.equal(calls, 1); assert.equal(claims, 1); } finally { await close(); }
});

test('platform disconnection aborts active run and never resumes the uncertain invocation', { timeout: 5000 }, async () => {
  let calls = 0, abort;
  const aborted = new Promise(resolve => { abort = resolve; });
  let serverSocket;
  const close = await platformFixture(socket => {
    serverSocket = socket;
    socket.on('agent.task.claim', (_payload, ack) => ack({ data: invocation }));
  }, async (_request, _emit, signal) => {
    calls++;
    serverSocket.disconnect(true);
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    abort();
    throw new Error('aborted');
  });
  try { await aborted; await new Promise(resolve => setTimeout(resolve, 1200)); assert.equal(calls, 1); } finally { await close(); }
});


test('accepted failed terminal events finish their lease and allow the next task', { timeout: 5000 }, async () => {
  let claims = 0, finishes = 0, calls = 0, finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const close = await platformFixture(socket => {
    socket.on('agent.task.claim', (_payload, ack) => { claims++; ack({ data: claims <= 2 ? { ...invocation, execution_id: claims === 1 ? invocation.execution_id : '77777777-7777-4777-8777-777777777777', idempotency_key: claims === 1 ? invocation.execution_id : '77777777-7777-4777-8777-777777777777' } : null }); });
    socket.on('agent.task.event', (_payload, ack) => ack({ data: true }));
    socket.on('agent.task.finish', (_payload, ack) => { finishes++; ack({ data: true }); if (finishes === 2) finish(); });
    socket.on('agent.task.fail', (_payload, ack) => { ack({ data: true }); });
  }, async (request, emit) => {
    calls++;
    await emit({ id: '66666666-6666-4666-8666-666666666666', schema_version: '1.0', execution_id: request.execution_id, sequence: 1, type: 'execution.failed', occurred_at: new Date().toISOString(), payload: { text: 'Could not complete' } });
    throw new Error('turn failed');
  });
  const timeout = setTimeout(() => finish(), 2500);
  try { await finished; assert.equal(finishes, 2); assert.equal(calls, 2); } finally { clearTimeout(timeout); await close(); }
});

test('unexpected Codex approval requests are denied and fail visibly instead of hanging', { timeout: 5000 }, async () => {
  const runtime = await startCodex('token', () => {}, launchFake(`send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1' } });`));
  const events = [];
  try {
    await assert.rejects(runtime.invoke(invocation, async event => { events.push(event); }, new AbortController().signal));
    assert.equal(events.at(-1).type, 'execution.failed');
  } finally { runtime.stop(); }
});

test('rejected event acknowledgement aborts and fails once without reclaiming the execution', { timeout: 5000 }, async () => {
  let calls = 0, failures = 0, claims = 0, finish, authStatus;
  const failed = new Promise(resolve => { finish = resolve; });
  let receivedSignal;
  const close = await platformFixture(socket => {
    socket.on('agent.task.claim', (_payload, ack) => { claims++; ack({ data: invocation }); });
    socket.on('agent.heartbeat', payload => { authStatus = payload.auth_status; });
    socket.on('agent.task.event', (_payload, ack) => ack({ error: 'lease_lost' }));
    socket.on('agent.task.fail', (payload, ack) => { failures++; assert.deepEqual(payload, {}); ack({ data: true }); finish(); });
    socket.on('agent.task.finish', () => assert.fail('uncertain events cannot finish'));
  }, async (request, emit, signal) => {
    calls++; receivedSignal = signal;
    await emit({ id: '66666666-6666-4666-8666-666666666666', schema_version: '1.0', execution_id: request.execution_id, sequence: 1, type: 'execution.started', occurred_at: new Date().toISOString(), payload: { text: 'Working' } });
  });
  try {
    await failed;
    close.publish();
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(authStatus, 'error');
    assert.equal(receivedSignal.aborted, true);
    assert.equal(calls, 1); assert.equal(claims, 1); assert.equal(failures, 1);
  } finally { await close(); }
});

test('slow persistence coalesces streaming snapshots instead of queuing every model chunk', { timeout: 5000 }, async () => {
  const behavior = `let count = 0; const timer = setInterval(() => { ${delta('x')} if (++count === 100) { clearInterval(timer); ${completed('completed')} } }, 10);`;
  const runtime = await startCodex('token', () => {}, launchFake(behavior));
  const events = [];
  try {
    await runtime.invoke(invocation, async event => { events.push(event); if (event.type === 'execution.progress') await new Promise(resolve => setTimeout(resolve, 450)); }, new AbortController().signal);
    assert.equal(events.at(-1).payload.text, 'x'.repeat(100));
    assert.ok(events.filter(event => event.type === 'execution.progress').length <= 4, 'progress must coalesce behind a slow acknowledgement');
  } finally { runtime.stop(); }
});

test('unexpected tool execution is interrupted even if Codex reports a completed turn', { timeout: 5000 }, async () => {
  const runtime = await startCodex('token', () => {}, launchFake(`send({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'tool-1', type: 'commandExecution', command: 'cat /private/file' } } }); ${completed('completed')}`));
  const events = [];
  try {
    await assert.rejects(runtime.invoke(invocation, async event => { events.push(event); }, new AbortController().signal));
    assert.equal(events.at(-1).type, 'execution.failed');
    assert.equal(JSON.stringify(events).includes('/private/file'), false);
  } finally { runtime.stop(); }
});

test('claims wait for a persisted ready heartbeat on startup and reconnect', { timeout: 7000 }, async () => {
  const http = createServer();
  const io = new Server(http);
  let connections = 0, prematureClaims = 0, claims = 0, ready;
  const completed = new Promise(resolve => { ready = resolve; });
  io.of('/agents').on('connection', socket => {
    const generation = ++connections;
    let acknowledged = false;
    socket.on('agent.heartbeat', (payload, ack) => {
      assert.equal(payload.auth_status, 'ready');
      setTimeout(() => { acknowledged = true; ack({ data: { installation_id: 'i' } }); }, 1200);
    });
    socket.on('agent.task.claim', (_payload, ack) => {
      claims++;
      if (!acknowledged) { prematureClaims++; ack({ error: 'agent_not_ready' }); return; }
      ack({ data: null });
      if (generation === 1) setTimeout(() => socket.disconnect(true), 50);
      else ready();
    });
    socket.on('agent.task.fail', (_payload, ack) => ack({ data: true }));
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const platform = connectPlatform({ origin: `http://127.0.0.1:${http.address().port}`, credential: 'credential', installation_id: 'i', workspace_id: 'w' }, () => 'ready', () => {}, async () => assert.fail('no task returned'));
  const timeout = setTimeout(() => ready(), 5000);
  try { await completed; assert.equal(prematureClaims, 0); assert.equal(connections, 2); assert.ok(claims >= 2); }
  finally { clearTimeout(timeout); platform.close(); await new Promise(resolve => io.close(resolve)); }
});

test('explicit agent_not_ready before claiming a task refreshes readiness without halting', { timeout: 5000 }, async () => {
  let claims = 0, fails = 0, finished;
  const ready = new Promise(resolve => { finished = resolve; });
  const close = await platformFixture(socket => {
    socket.on('agent.task.claim', (_payload, ack) => {
      claims++;
      if (claims === 1) ack({ error: 'agent_not_ready' });
      else { ack({ data: null }); finished(); }
    });
    socket.on('agent.task.fail', (_payload, ack) => { fails++; ack({ data: true }); });
  }, async () => assert.fail('no task returned'));
  const timeout = setTimeout(() => finished(), 2000);
  try { await ready; assert.ok(claims >= 2); assert.equal(fails, 0); }
  finally { clearTimeout(timeout); await close(); }
});

test('terminal persistence stops queued renewals so completed tasks do not halt the connector', { timeout: 10000 }, async () => {
  let claims = 0, renewals = 0, finishes = 0, reports = [], finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const close = await platformFixture(socket => {
    socket.on('agent.heartbeat', payload => reports.push(payload.auth_status));
    socket.on('agent.task.claim', (_payload, ack) => { claims++; ack({ data: claims === 1 ? invocation : null }); if (claims > 1) finish(); });
    socket.on('agent.task.event', (_payload, ack) => setTimeout(() => ack({ data: true }), 5400));
    socket.on('agent.task.renew', (_payload, ack) => { renewals++; ack({ error: 'execution_not_running' }); });
    socket.on('agent.task.finish', (_payload, ack) => { finishes++; ack({ data: true }); });
    socket.on('agent.task.fail', (_payload, ack) => ack({ data: true }));
  }, async (request, emit) => {
    await emit({ id: '66666666-6666-4666-8666-666666666666', schema_version: '1.0', execution_id: request.execution_id, sequence: 1, type: 'execution.completed', occurred_at: new Date().toISOString(), payload: { text: 'Complete' } });
  });
  const timeout = setTimeout(() => finish(), 7500);
  try { await finished; assert.equal(renewals, 0); assert.equal(finishes, 1); assert.ok(claims >= 2); assert.equal(reports.includes('error'), false); }
  finally { clearTimeout(timeout); await close(); }
});

test('a missing lease during an active turn still aborts and fails the run', { timeout: 8000 }, async () => {
  let renewals = 0, signal, finish;
  const failed = new Promise(resolve => { finish = resolve; });
  const close = await platformFixture(socket => {
    socket.on('agent.task.claim', (_payload, ack) => ack({ data: invocation }));
    socket.on('agent.task.renew', (_payload, ack) => { renewals++; ack({ error: 'lease_lost' }); });
    socket.on('agent.task.fail', (_payload, ack) => { ack({ data: true }); finish(); });
  }, async (_request, _emit, activeSignal) => {
    signal = activeSignal;
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw new Error('aborted');
  });
  try { await failed; assert.equal(renewals, 1); assert.equal(signal.aborted, true); }
  finally { await close(); }
});

test('idle connectors wait for a socket work notification instead of polling claims', { timeout: 5000 }, async () => {
  let claims = 0, peer, first, next;
  const initial = new Promise(resolve => { first = resolve; });
  const notified = new Promise(resolve => { next = resolve; });
  const close = await platformFixture(socket => {
    peer = socket;
    socket.on('agent.task.claim', (_payload, ack) => {
      claims++; ack({ data: null });
      if (claims === 1) first(); else next();
    });
  }, async () => assert.fail('empty queue must not invoke Codex'));
  try {
    await initial;
    await new Promise(resolve => setTimeout(resolve, 1250));
    assert.equal(claims, 1, 'idle connector must not repeatedly claim');
    peer.emit('agent.tasks.available');
    await notified;
    assert.equal(claims, 2);
  } finally { await close(); }
});
