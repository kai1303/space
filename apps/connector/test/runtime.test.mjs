import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { startCodex, connectPlatform, claimPairing } from '../dist/runtime.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorStore } from '../dist/storage.js';

test('Codex must initialize before readiness; token is child env only and no turn is sent', async () => {
  let exited;
  const exit = new Promise(resolve => { exited = resolve; });
  const codex = await startCodex('secret-access-token', () => exited(), (command, args, options) => {
    assert.equal(command, 'codex');
    assert.equal(options.env.ACCESS_TOKEN, 'secret-access-token');
    assert.equal(args.join(' ').includes('secret-access-token'), false);
    assert.ok(args.includes('model_providers.openai_chatgpt_plan.supports_websockets=false'));
    return spawn(process.execPath, ['-e', `
      let buffer = '';
      process.stdin.on('data', chunk => { buffer += chunk; while (buffer.includes('\\n')) {
        const line = buffer.slice(0, buffer.indexOf('\\n')); buffer = buffer.slice(buffer.indexOf('\\n')+1);
        const message = JSON.parse(line);
        if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: { userAgent: 'synthetic-codex' } }));
        else if (message.method === 'initialized') process.exit(0);
        else process.exit(42);
      }});
    `], options);
  });
  await exit;
  assert.equal(codex.alive(), false);
  codex.stop();
});

test('Codex rejects initialization errors', async () => {
  await assert.rejects(startCodex('token', () => {}, (_command, _args, options) => spawn(process.execPath, ['-e', `process.stdin.once('data', () => console.log(JSON.stringify({ id: 1, error: { message: 'bad config' } })));`], options)), /initialize/);
});

test('claim persists credential before request and reuses it for retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'space-pair-'));
  try {
    const store = new ConnectorStore(directory);
    let credential;
    await assert.rejects(claimPairing(store, 'http://127.0.0.1:1234', 'a'.repeat(32), async (_url, options) => {
      const body = JSON.parse(options.body);
      credential = body.credential;
      assert.equal((await store.load()).pending.credential, credential);
      throw new Error('network failure');
    }));
    const connection = await claimPairing(store, 'http://127.0.0.1:1234', 'a'.repeat(32), async (_url, options) => {
      assert.equal(JSON.parse(options.body).credential, credential);
      return Response.json({ installation_id: 'install-1', workspace_id: 'workspace-1' });
    });
    assert.equal(connection.credential, credential);
    assert.equal((await store.load()).pending, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Socket.IO carries only platform credential and auth status; revoked credentials stop', async () => {
  const http = createServer();
  const io = new Server(http);
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  let unauthorized;
  const stopped = new Promise(resolve => { unauthorized = resolve; });
  let report;
  const received = new Promise(resolve => { report = resolve; });
  io.of('/agents').on('connection', socket => {
    assert.deepEqual(socket.handshake.auth, { token: 'platform-credential' });
    socket.on('agent.heartbeat', (payload, ack) => {
      report(payload);
      ack({ error: 'unauthorized' });
    });
  });
  const connection = connectPlatform({ origin, credential: 'platform-credential', installation_id: 'install-1', workspace_id: 'workspace-1' }, () => 'required', unauthorized);
  try {
    assert.deepEqual(await received, { auth_status: 'required' });
    await stopped;
  } finally { connection.close(); await new Promise(resolve => io.close(resolve)); }
});

test('graceful server disconnect reconnects and resumes heartbeats', async t => {
  const logs = t.mock.method(console, 'info', () => {});
  const http = createServer();
  const io = new Server(http);
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  let connections = 0;
  let rejections = 0;
  let resumed;
  const heartbeat = new Promise(resolve => { resumed = resolve; });
  io.of('/agents').on('connection', socket => {
    connections++;
    if (connections === 1) { socket.disconnect(true); return; }
    socket.on('agent.heartbeat', (payload, ack) => {
      ack({ data: { installation_id: 'i' } });
      resumed(payload);
    });
  });
  const connection = connectPlatform({ origin: `http://127.0.0.1:${http.address().port}`, credential: 'credential', installation_id: 'i', workspace_id: 'w' }, () => 'ready', () => { rejections++; });
  let timeout;
  try {
    assert.deepEqual(await Promise.race([heartbeat, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('connector did not reconnect')), 3000); })]), { auth_status: 'ready' });
    assert.equal(connections, 2);
    assert.equal(rejections, 0);
    const lines = logs.mock.calls.map(call => call.arguments.join(' '));
    assert.equal(lines.filter(line => line.endsWith('Connected to Space.')).length, 2);
    assert.ok(lines.some(line => line.endsWith('Space closed the connection. Reconnecting.')));
    assert.ok(lines.every(line => line.includes(`[codex http://127.0.0.1:${http.address().port}]`)));
  } finally { clearTimeout(timeout); connection.close(); await new Promise(resolve => io.close(resolve)); }
});

test('a rejected reconnect handshake stops after server disconnect', async t => {
  const logs = t.mock.method(console, 'info', () => {});
  const http = createServer();
  const io = new Server(http);
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  let attempts = 0;
  let rejected;
  const stopped = new Promise(resolve => { rejected = resolve; });
  io.of('/agents').use((_socket, next) => {
    attempts++;
    next(attempts === 1 ? undefined : new Error('unauthorized private-server-detail'));
  });
  io.of('/agents').on('connection', socket => socket.disconnect(true));
  const connection = connectPlatform({ origin: `http://127.0.0.1:${http.address().port}`, credential: 'credential', installation_id: 'i', workspace_id: 'w' }, () => 'required', rejected);
  let timeout;
  try {
    await Promise.race([stopped, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('connector did not reject invalid credential')), 3000); })]);
    assert.equal(attempts, 2);
    const lines = logs.mock.calls.map(call => call.arguments.join(' '));
    assert.ok(lines.some(line => line.endsWith('Space rejected the pairing.')));
    assert.ok(lines.every(line => !line.includes('private-server-detail') && !line.includes('credential')));
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(attempts, 2);
  } finally { clearTimeout(timeout); connection.close(); await new Promise(resolve => io.close(resolve)); }
});


test('a different pairing code generates a fresh pending credential after an uncertain claim', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'space-newpair-'));
  try {
    const store = new ConnectorStore(directory);
    let first;
    await assert.rejects(claimPairing(store, 'http://127.0.0.1:1234', 'a'.repeat(32), async (_url, options) => {
      first = JSON.parse(options.body).credential;
      throw new Error('response lost');
    }));
    await claimPairing(store, 'http://127.0.0.1:1234', 'b'.repeat(32), async (_url, options) => {
      assert.notEqual(JSON.parse(options.body).credential, first);
      return Response.json({ installation_id: 'install-2', workspace_id: 'workspace-1' });
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Kiro pairing sends its provider and rejects mismatched provider responses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'space-provider-'));
  try {
    const store = new ConnectorStore(directory);
    await assert.rejects(claimPairing(store, 'http://localhost:3000', 'k'.repeat(32), async (_url, options) => {
      assert.equal(JSON.parse(options.body).provider, 'kiro');
      return Response.json({ installation_id: 'i', workspace_id: 'w', provider: 'codex' });
    }, 'kiro'), /different agent provider/);
    assert.equal((await store.load()).connection, undefined);
    const connection = await claimPairing(store, 'http://localhost:3000', 'k'.repeat(32), async () => Response.json({ installation_id: 'i', workspace_id: 'w', provider: 'kiro' }), 'kiro');
    assert.equal(connection.provider, 'kiro');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
