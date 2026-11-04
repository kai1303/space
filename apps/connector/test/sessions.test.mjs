import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCodex, AgentSessionStopped } from '../dist/codex.js';

const session = '33333333-3333-4333-8333-333333333333';
const secondSession = '77777777-7777-4777-8777-777777777777';
const invocation = {
  schema_version: '1.0', task_id: '11111111-1111-4111-8111-111111111111',
  execution_id: '22222222-2222-4222-8222-222222222222', session_id: session,
  idempotency_key: '22222222-2222-4222-8222-222222222222', goal: 'First goal', skill: 'codex.run',
  context: { thread_id: '44444444-4444-4444-8444-444444444444', messages: [{ id: '55555555-5555-4555-8555-555555555555', text: 'Initial supplied context', author_type: 'human' }] },
};
const connection = { origin: 'http://localhost:3000', credential: 'private-credential', installation_id: '11111111-1111-4111-8111-111111111111', workspace_id: '22222222-2222-4222-8222-222222222222' };
const identity = { issuer: 'https://auth.openai.com', subject: 'subject', client_id: 'client' };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'space-session-test-'));
  const log = join(directory, 'rpc.jsonl');
  const launches = [];
  const storage = { directory, connection, identity };
  const launch = (_command, args, options) => {
    launches.push({ args, options });
    return spawn(process.execPath, ['-e', `
      const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
      const send = value => console.log(JSON.stringify(value));
      let buffer = '';
      process.stdin.on('data', chunk => { buffer += chunk; while (buffer.includes('\\n')) {
        const line = buffer.slice(0, buffer.indexOf('\\n')); buffer = buffer.slice(buffer.indexOf('\\n') + 1);
        const message = JSON.parse(line);
        fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(message) + '\\n');
        if (message.method === 'initialize') send({ id: message.id, result: {} });
        else if (message.method === 'thread/start') {
          if (message.params.sandbox !== 'read-only' || message.params.approvalPolicy !== 'never') process.exit(42);
          const id = crypto.randomUUID();
          if (!message.params.ephemeral) fs.writeFileSync(path.join(process.env.CODEX_HOME, id), 'retained');
          send({ id: message.id, result: { thread: { id } } });
        } else if (message.method === 'thread/resume') {
          if (message.params.sandbox !== 'read-only' || message.params.approvalPolicy !== 'never') process.exit(42);
          if (!fs.existsSync(path.join(process.env.CODEX_HOME, message.params.threadId))) process.exit(43);
          send({ id: message.id, result: { thread: { id: message.params.threadId } } });
        } else if (message.method === 'turn/start') {
          const turnId = crypto.randomUUID(), threadId = message.params.threadId;
          if (fs.existsSync(path.join(process.env.CODEX_HOME, threadId))) {
            const mapping = JSON.parse(fs.readFileSync(path.join(message.params.cwd, '..', 'thread.json'), 'utf8'));
            if (mapping.threadId !== threadId) process.exit(44);
          }
          send({ id: message.id, result: { turn: { id: turnId } } });
          send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'answer', delta: 'Retained answer' } });
          send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
        } else if (message.method === 'turn/interrupt') send({ id: message.id, result: {} });
      }});
    `], options);
  };
  const start = (overrides = {}) => startCodex('secret-token', () => {}, launch, { ...storage, ...overrides });
  const requests = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const invoke = async (runtime, resume, overrides = {}) => {
    const events = [];
    await runtime.invoke({ ...invocation, persistent_session: { resume }, ...overrides }, async event => { events.push(event); }, new AbortController().signal);
    return events;
  };
  return { directory, log, launches, storage, launch, start, requests, invoke, close: () => rm(directory, { recursive: true, force: true }) };
}

test('managed sessions create once, resume their thread, and isolate session history and cwd', { timeout: 5000 }, async () => {
  const f = await fixture(); const runtime = await f.start();
  try {
    await f.invoke(runtime, false);
    await f.invoke(runtime, true, { goal: 'Follow-up goal', context: undefined });
    await f.invoke(runtime, false, { session_id: secondSession });
    const calls = await f.requests(), starts = calls.filter(c => c.method === 'thread/start'), resumes = calls.filter(c => c.method === 'thread/resume'), turns = calls.filter(c => c.method === 'turn/start');
    assert.equal(starts.length, 2); assert.equal(resumes.length, 1);
    assert.equal(starts[0].params.ephemeral, false);
    assert.equal(resumes[0].params.threadId, turns[0].params.threadId);
    assert.equal(turns[0].params.threadId, turns[1].params.threadId);
    assert.notEqual(turns[0].params.threadId, turns[2].params.threadId);
    assert.equal(turns[0].params.cwd, turns[1].params.cwd);
    assert.notEqual(turns[0].params.cwd, turns[2].params.cwd);
    assert.match(turns[0].params.input[0].text, /Initial supplied context/);
    assert.match(turns[1].params.input[0].text, /Follow-up goal/);
    assert.doesNotMatch(turns[1].params.input[0].text, /Initial supplied context|First goal/);
    assert.deepEqual(turns[0].params.sandboxPolicy, { type: 'readOnly' });
    assert.equal(turns[0].params.approvalPolicy, 'never');
    assert.ok(f.launches[0].args.includes('features.shell_tool=false'));
    assert.ok(f.launches[0].args.includes('features.plugins=false'));
    const mappingPath = join(turns[0].params.cwd, '..', 'thread.json');
    assert.equal(JSON.parse(await readFile(mappingPath, 'utf8')).threadId, turns[0].params.threadId);
    assert.equal((await stat(mappingPath)).mode & 0o777, 0o600);
    assert.equal((await stat(f.launches[0].options.env.CODEX_HOME)).mode & 0o777, 0o700);
    assert.equal((await stat(turns[0].params.cwd)).mode & 0o777, 0o700);
  } finally { runtime.stop(); await f.close(); }
});

test('connector restart keeps its private home, session cwd and saved thread mapping', { timeout: 5000 }, async () => {
  const f = await fixture(); let runtime = await f.start();
  try {
    await f.invoke(runtime, false); runtime.stop();
    runtime = await f.start();
    await f.invoke(runtime, true, { context: undefined, goal: 'After restart' });
    const calls = await f.requests(), turns = calls.filter(c => c.method === 'turn/start');
    assert.equal(f.launches[0].options.env.HOME, f.launches[1].options.env.HOME);
    assert.notEqual(f.launches[0].options.env.HOME, process.env.HOME);
    assert.equal(turns[0].params.threadId, turns[1].params.threadId);
    assert.equal(turns[0].params.cwd, turns[1].params.cwd);
    assert.equal(calls.filter(c => c.method === 'thread/start').length, 1);
    assert.equal(calls.filter(c => c.method === 'thread/resume').length, 1);
  } finally { runtime.stop(); await f.close(); }
});

test('missing or corrupt managed session state fails safely without starting another thread', { timeout: 5000 }, async () => {
  const f = await fixture(); let runtime = await f.start();
  try {
    const events = [];
    await assert.rejects(runtime.invoke({ ...invocation, persistent_session: { resume: true } }, async e => events.push(e), new AbortController().signal));
    assert.equal(events.at(-1).type, 'execution.failed');
    assert.match(events.at(-1).payload.text, /saved.*session.*unavailable/i);
    assert.equal((await f.requests()).some(c => c.method === 'thread/start'), false);
    assert.equal(runtime.alive(), true, 'missing state must not disable unrelated sessions');
    await f.invoke(runtime, false);
    const turn = (await f.requests()).find(c => c.method === 'turn/start');
    await writeFile(join(turn.params.cwd, '..', 'thread.json'), '{bad');
    await assert.rejects(f.invoke(runtime, true));
    assert.equal((await f.requests()).filter(c => c.method === 'thread/start').length, 1);
  } finally { runtime.stop(); await f.close(); }
});

test('persistent state is namespaced by platform, installation and authenticated OAuth identity', { timeout: 10000 }, async () => {
  const f = await fixture(); let runtime;
  try {
    const variants = [{}, { connection: { ...connection, credential: 'new-pairing-credential' } }, { connection: { ...connection, installation_id: secondSession } }, { connection: { ...connection, origin: 'https://other.example' } }, { connection: { ...connection, workspace_id: secondSession } }, { identity: { ...identity, subject: 'other-account' } }, { identity: { ...identity, issuer: 'https://another-issuer.example' } }, { identity: { ...identity, client_id: 'another-client' } }];
    for (const variant of variants) {
      runtime = await f.start(variant); await f.invoke(runtime, false); runtime.stop();
    }
    const homes = f.launches.map(l => l.options.env.CODEX_HOME);
    assert.equal(new Set(homes).size, variants.length);
    assert.ok(homes.every(home => home.startsWith(f.directory + "/")));
    assert.equal((await f.requests()).filter(c => c.method === 'thread/start').length, variants.length);
  } finally { runtime?.stop(); await f.close(); }
});

test('managed sessions reject existing mappings for fresh requests and symbolic session directories', { timeout: 5000 }, async () => {
  const f = await fixture(); let runtime = await f.start();
  try {
    await f.invoke(runtime, false);
    await assert.rejects(f.invoke(runtime, false));
    runtime.stop(); runtime = await f.start();
    const turn = (await f.requests()).find(c => c.method === 'turn/start');
    const sessionDirectory = join(turn.params.cwd, '..');
    await rm(sessionDirectory, { recursive: true });
    await symlink(f.directory, sessionDirectory);
    await assert.rejects(f.invoke(runtime, true));
    assert.equal((await f.requests()).filter(c => c.method === 'thread/start').length, 1);
  } finally { runtime.stop(); await f.close(); }
});

test('persistent requests without configured private storage fail closed', { timeout: 5000 }, async () => {
  const f = await fixture(); const runtime = await startCodex('token', () => {}, f.launch);
  try {
    await assert.rejects(f.invoke(runtime, false));
  } finally { runtime.stop(); await f.close(); }
});


test('managed inference waits for accepted durable session readiness', { timeout: 5000 }, async () => {
  const f = await fixture(); const runtime = await f.start();
  let marker, release;
  const reached = new Promise(resolve => { marker = resolve; });
  const acknowledged = new Promise(resolve => { release = resolve; });
  const running = runtime.invoke({ ...invocation, persistent_session: { resume: false } }, async event => {
    if (event.payload.session_ready) { marker(); await acknowledged; }
  }, new AbortController().signal);
  try {
    const result = await Promise.race([reached.then(() => 'ready'), running.then(() => 'completed')]);
    assert.equal(result, 'ready');
    const calls = await f.requests();
    assert.equal(calls.some(c => c.method === 'turn/start'), false);
    const start = calls.find(c => c.method === 'thread/start');
    const path = join(start.params.cwd, '..', 'thread.json');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).ready, false);
    release(); await running;
    assert.equal(JSON.parse(await readFile(path, 'utf8')).ready, true);
  } finally { release(); await running.catch(() => {}); runtime.stop(); await f.close(); }
});

test('Stop before session readiness preserves an unused thread for a later fresh request', { timeout: 5000 }, async () => {
  const f = await fixture(); const runtime = await f.start(), controller = new AbortController();
  try {
    await assert.rejects(runtime.invoke({ ...invocation, persistent_session: { resume: false } }, async event => {
      if (event.payload.session_ready) { controller.abort(new AgentSessionStopped()); throw controller.signal.reason; }
    }, controller.signal));
    const calls = await f.requests();
    assert.equal(calls.some(c => c.method === 'turn/start'), false);
    assert.equal(runtime.alive(), true);
    await f.invoke(runtime, false);
    const after = await f.requests(), starts = after.filter(c => c.method === 'thread/start'), resumes = after.filter(c => c.method === 'thread/resume');
    assert.equal(starts.length, 1); assert.equal(resumes.length, 1);
    const turn = after.find(c => c.method === 'turn/start');
    assert.equal(turn.params.threadId, resumes[0].params.threadId);
    assert.equal(turn.params.cwd, starts[0].params.cwd);
  } finally { runtime.stop(); await f.close(); }
});

test('accepted readiness can resume a pre-turn mapping after a crash before its local ready write', { timeout: 5000 }, async () => {
  const f = await fixture(); let runtime = await f.start(); const controller = new AbortController();
  try {
    await assert.rejects(runtime.invoke({ ...invocation, persistent_session: { resume: false } }, async event => {
      if (event.payload.session_ready) { controller.abort(new AgentSessionStopped()); throw controller.signal.reason; }
    }, controller.signal));
    runtime.stop(); runtime = await f.start();
    await f.invoke(runtime, true);
    const calls = await f.requests();
    assert.equal(calls.filter(c => c.method === 'thread/start').length, 1);
    assert.equal(calls.filter(c => c.method === 'thread/resume').length, 1);
    assert.equal(calls.filter(c => c.method === 'turn/start').length, 1);
  } finally { runtime.stop(); await f.close(); }
});

test('older mappings without readiness are treated as possibly used and never freshly replayed', { timeout: 5000 }, async () => {
  const f = await fixture(); const runtime = await f.start();
  try {
    await f.invoke(runtime, false);
    const turn = (await f.requests()).find(c => c.method === 'turn/start');
    const path = join(turn.params.cwd, '..', 'thread.json');
    const mapping = JSON.parse(await readFile(path, 'utf8')); delete mapping.ready;
    await writeFile(path, JSON.stringify(mapping));
    await assert.rejects(f.invoke(runtime, false));
    await f.invoke(runtime, true);
    assert.equal((await f.requests()).filter(c => c.method === 'thread/start').length, 1);
  } finally { runtime.stop(); await f.close(); }
});
