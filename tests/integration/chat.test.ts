import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { io } from 'socket.io-client';
import { RedisSocketAdapter } from '@space/redis';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { ChatStore } from '@space/postgres/chat';
import { WorkspaceStore } from '@space/postgres/workspace';
import { createApi } from '@space/server/api';
import { deliverOne } from '@space/core/worker';
import { MockConnector } from '@space/mock/connector';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const schema = `chat_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 20 });
const adapter = new RedisSocketAdapter(process.env.TEST_REDIS_URL, schema);
const otherAdapter = new RedisSocketAdapter(process.env.TEST_REDIS_URL, schema);
const store = new PostgresStore(pool), app = createApi(store, { allowDevelopmentTokens: true, realtime: { adapter, } });
const second = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, realtime: { adapter: otherAdapter, } });
let address: string, secondAddress: string;
before(async () => {
  await Promise.all([adapter.connect(), otherAdapter.connect()]);
  await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool);
  address = await app.listen({ host: '127.0.0.1', port: 0 });
  secondAddress = await second.listen({ host: '127.0.0.1', port: 0 });
});
after(async () => { await app.close(); await second.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
async function api(token: string, method: 'GET' | 'POST' | 'DELETE', path: string, body?: object, status = 200) {
  const response = await app.inject({ method, url: `/v1${path}`, headers: { authorization: `Bearer ${token}` }, ...(body ? { payload: body } : {}) });
  assert.equal(response.statusCode, status, `${path}: ${response.body}`);
  return status === 204 ? undefined : response.json();
}
async function socket(token: string, base = address) {
  const ws = io(base, { transports: ['websocket'], auth: { token }, reconnection: false, autoConnect: false });
  const frames: Record<string, any>[] = [];
  ws.on('chat.events', (frame, ack) => { frames.push({ type: 'events', ...frame }); ack(); });
  ws.on('chat.error', frame => frames.push({ type: 'error', ...frame }));
  const connected = new Promise<void>((resolve, reject) => { ws.once('connect', resolve); ws.once('connect_error', reject); });
  ws.connect(); await connected;
  const wait = async (type: string, predicate: (frame: Record<string, any>) => boolean = () => true) => {
    const deadline = Date.now() + 5000;
    while (true) {
      const index = frames.findIndex(frame => frame.type === type && predicate(frame));
      if (index >= 0) return frames.splice(index, 1)[0]!;
      assert.ok(Date.now() < deadline, `timed out waiting for ${type}`);
      await delay(10);
    }
  };
  return { ws, frames, wait, send: (frame: Record<string, any>) => {
    const { type, ...input } = frame;
    ws.timeout(2000).emit(type === 'subscribe' ? 'channel.subscribe' : type, input, (error: Error | null, reply: any) => {
      frames.push(error ? { type: 'error', error: error.message } : reply.error ? { type: 'error', error: reply.error } :
        type === 'subscribe' ? { type: 'subscribed', ...reply.data } : { type: 'message.ack', message: reply.data });
    });
  } };
}

test('channel discovery respects public/private membership and management', async () => {
  const a = await bootstrap(pool), outsider = await bootstrap(pool);
  const publicChannel = await api(a.owner_token, 'POST', `/workspaces/${a.workspace_id}/channels`, { name: 'General', private: false }, 201);
  const privateChannel = await api(a.owner_token, 'POST', `/workspaces/${a.workspace_id}/channels`, { name: 'Private', private: true }, 201);
  const visible = await api(a.collaborator_token, 'GET', `/workspaces/${a.workspace_id}/channels`);
  assert.ok(visible.items.some((c: { id: string }) => c.id === publicChannel.id));
  assert.ok(!visible.items.some((c: { id: string }) => c.id === privateChannel.id));
  await api(a.collaborator_token, 'GET', `/channels/${publicChannel.id}/history`, undefined, 404);
  await api(a.collaborator_token, 'POST', `/channels/${privateChannel.id}/join`, {}, 404);
  await api(a.collaborator_token, 'POST', `/channels/${publicChannel.id}/join`, {});
  await api(a.collaborator_token, 'GET', `/channels/${publicChannel.id}/history`);
  await api(a.owner_token, 'POST', `/channels/${privateChannel.id}/members`, { user_id: a.collaborator_id }, 201);
  await api(a.collaborator_token, 'GET', `/channels/${privateChannel.id}/history`);
  await api(outsider.owner_token, 'GET', `/channels/${privateChannel.id}/history`, undefined, 404);
  await api(a.collaborator_token, 'POST', `/channels/${privateChannel.id}/members`, { user_id: outsider.owner_id }, 403);
});

test('human messages and replies persist, reject spoofed identity and deduplicate conflicting retries', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const input = { client_message_id: randomUUID(), text: 'Hello team' };
  const root = await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, input, 201);
  assert.equal(root.author.kind, 'human');
  assert.equal(root.author.id, a.owner_id);
  const retry = await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, input, 201);
  assert.equal(root.id, retry.id);
  await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { ...input, text: 'Changed' }, 409);
  await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { ...input, author: { kind: 'agent', id: a.installation_id } }, 400);
  await api(b.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { ...input, client_message_id: randomUUID() }, 404);
  await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), thread_id: b.thread_id, text: 'Wrong thread' }, 404);
  const reply = await api(a.collaborator_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), thread_id: root.thread_id, text: 'Reply' }, 201);
  assert.equal(reply.thread_id, root.thread_id);
  const history = await api(a.owner_token, 'GET', `/channels/${a.channel_id}/history`);
  assert.equal(history.events.filter((event: any) => event.type === 'message.created').length, 2);
  const messages = await api(a.owner_token, 'GET', `/threads/${root.thread_id}/messages`);
  assert.deepEqual(messages.map((m: any) => m.text), ['Hello team', 'Reply']);
  await migrate(pool);
  assert.equal((await api(a.owner_token, 'GET', `/channels/${a.channel_id}/history`)).events.length, 2);
});

test('formatted messages and replies retain their documents in acknowledgments, replay and stored history', async () => {
  const a = await bootstrap(pool);
  const client = await socket(a.owner_token);
  const document = { ops: [
    { insert: 'Guide', attributes: { bold: true, link: 'https://example.test/guide' } }, { insert: '\n' },
    { insert: 'First item' }, { insert: '\n', attributes: { list: 'bullet' } },
    { insert: 'const ready = true;' }, { insert: '\n', attributes: { 'code-block': true } },
  ] };
  const input = { client_message_id: randomUUID(), text: document.ops.map(op => op.insert).join('').trim(), document };
  try {
    client.send({ type: 'subscribe', channel_id: a.channel_id, after: '0' }); await client.wait('subscribed');
    client.send({ type: 'message.send', channel_id: a.channel_id, ...input });
    const root = (await client.wait('message.ack')).message;
    assert.deepEqual(root.document, document);
    assert.deepEqual((await client.wait('events')).events[0].payload.document, document);
    assert.equal((await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, input, 201)).id, root.id);
    const changed = { ops: [{ insert: input.text + '\n', attributes: { italic: true } }] };
    await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { ...input, document: changed }, 409);
    const replyDocument = { ops: [{ insert: 'Reply', attributes: { code: true } }, { insert: '\n' }] };
    await api(a.collaborator_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), thread_id: root.thread_id, text: 'Reply', document: replyDocument }, 201);
    const history = await api(a.owner_token, 'GET', `/channels/${a.channel_id}/history`);
    assert.deepEqual(history.events.filter((event: any) => event.type === 'message.created').map((event: any) => event.payload.document), [document, replyDocument]);
    const thread = await api(a.owner_token, 'GET', `/threads/${root.thread_id}/messages`);
    assert.deepEqual(thread.map((message: any) => message.document), [document, replyDocument]);
    await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), text: 'Unsafe', document: { ops: [{ insert: 'Unsafe', attributes: { link: 'javascript:alert(1)' } }] } }, 400);
    await migrate(pool);
    assert.deepEqual((await api(a.owner_token, 'GET', `/channels/${a.channel_id}/history`)).events[0].payload.document, document);
  } finally { client.ws.disconnect(); }
});

test('Socket.IO Redis adapter delivers across two API instances and reconnect catches up once', async () => {
  const a = await bootstrap(pool);
  const one = await socket(a.owner_token), two = await socket(a.collaborator_token, secondAddress);
  try {
    for (const client of [one, two]) {
      client.send({ type: 'subscribe', channel_id: a.channel_id, after: '0' });
      await client.wait('subscribed');
    }
    const request = { type: 'message.send', channel_id: a.channel_id, client_message_id: randomUUID(), text: 'Live hello' };
    one.send(request);
    const ack = await one.wait('message.ack');
    const delivered = await two.wait('events');
    assert.equal(delivered.events[0].payload.id, ack.message.id);
    assert.equal(delivered.events[0].payload.author.id, a.owner_id);
    one.send(request);
    assert.equal((await one.wait('message.ack')).message.id, ack.message.id);
    two.ws.disconnect();
    await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), text: 'While offline' }, 201);
    const resumed = await socket(a.collaborator_token, secondAddress);
    try {
      resumed.send({ type: 'subscribe', channel_id: a.channel_id, after: delivered.cursor });
      await resumed.wait('subscribed');
      const recovered = await resumed.wait('events');
      assert.equal(recovered.events.length, 1);
      assert.equal(recovered.events[0].payload.text, 'While offline');
      assert.ok(BigInt(recovered.cursor) > BigInt(delivered.cursor));
    } finally { resumed.ws.disconnect(); }
  } finally { one.ws.disconnect(); two.ws.disconnect(); }
});

test('socket authorization rejects cross-channel subscriptions and revokes active subscriptions', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const client = await socket(a.collaborator_token);
  try {
    client.send({ type: 'subscribe', channel_id: b.channel_id, after: '0' });
    assert.equal((await client.wait('error')).error, 'not_found');
    client.send({ type: 'subscribe', channel_id: a.channel_id, after: '0' });
    await client.wait('subscribed');
    await new WorkspaceStore(pool).removeMember(a.owner_id, a.workspace_id, a.collaborator_id);
    const revoked = new Promise(resolve => client.ws.once('channel.revoked', resolve));
    assert.deepEqual(await Promise.race([revoked, delay(5000).then(() => { throw new Error('channel revocation missing'); })]), { channel_id: a.channel_id, error: 'not_found' });
    assert.equal(client.ws.connected, true);
    assert.ok(!client.frames.some(frame => frame.type === 'events'));
  } finally { client.ws.disconnect(); }
});

test('agent progress and completion arrive live with trusted agent identity in the originating thread', async () => {
  const a = await bootstrap(pool);
  const client = await socket(a.collaborator_token, secondAddress);
  try {
    client.send({ type: 'subscribe', channel_id: a.channel_id, after: '0' });
    await client.wait('subscribed');
    const task = await store.createTask(a.collaborator_id, { workspace_id: a.workspace_id, thread_id: a.thread_id, installation_id: a.installation_id, goal: 'Agent reply', skill: 'demo.echo' }, randomUUID());
    await store.approveTask(a.owner_id, task.id);
    await deliverOne(store, [new MockConnector()]);
    const events: any[] = [];
    while (!events.some(event => event.type === 'message.created')) events.push(...(await client.wait('events')).events);
    const message = events.find(event => event.type === 'message.created').payload;
    assert.equal(message.author.kind, 'agent');
    assert.equal(message.author.id, a.installation_id);
    assert.equal(message.thread_id, a.thread_id);
    assert.equal(message.task_id, task.id);
    assert.ok(events.some(event => event.type === 'task.event' && event.payload.type === 'execution.progress'));
    const history = await api(a.owner_token, 'GET', `/channels/${a.channel_id}/history`);
    assert.equal(history.events.filter((event: any) => event.type === 'message.created').length, 1);
  } finally { client.ws.disconnect(); }
});


test('committed WAL delivers a message without any Redis notification', async () => {
  const repair = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, realtime: { } });
  const base = await repair.listen({ host: '127.0.0.1', port: 0 });
  const a = await bootstrap(pool), client = await socket(a.owner_token, base);
  try {
    client.send({ type: 'subscribe', channel_id: a.channel_id, after: '0' });
    await client.wait('subscribed');
    const saved = await new ChatStore(pool).send(a.owner_id, a.channel_id, { client_message_id: randomUUID(), text: 'Committed, notification lost' });
    assert.equal((await client.wait('events')).events[0].payload.id, saved.id);
  } finally { client.ws.disconnect(); await repair.close(); }
});

test('long thread history pages backward and reconnect replay spans more than one batch', async () => {
  const a = await bootstrap(pool), chat = new ChatStore(pool);
  for (let i = 0; i < 205; i++) await chat.send(a.owner_id, a.channel_id, { client_message_id: randomUUID(), thread_id: a.thread_id, text: `Message ${i}` });
  const latest = await api(a.owner_token, 'GET', `/threads/${a.thread_id}/messages`);
  assert.equal(latest.length, 200); assert.equal(latest.at(-1).text, 'Message 204');
  const older = await api(a.owner_token, 'GET', `/threads/${a.thread_id}/messages?before=${latest[0].id}`);
  assert.equal(older.length, 5); assert.equal(older[0].text, 'Message 0');
  const history = await api(a.owner_token, 'GET', `/channels/${a.channel_id}/history`);
  assert.equal(history.events.length, 100); assert.equal(history.has_more, true);
  const previous = await api(a.owner_token, 'GET', `/channels/${a.channel_id}/history?before=${history.oldest_cursor}`);
  assert.equal(previous.events.length, 100);
  assert.ok(BigInt(previous.cursor) < BigInt(history.oldest_cursor));
  const client = await socket(a.owner_token);
  try {
    client.send({ type: 'subscribe', channel_id: a.channel_id, after: '0' });
    await client.wait('subscribed');
    const events: any[] = [];
    while (events.length < 205) events.push(...(await client.wait('events')).events);
    assert.equal(new Set(events.map(e => e.sequence)).size, 205);
    assert.equal(events.at(-1).payload.text, 'Message 204');
  } finally { client.ws.disconnect(); }
});

test('Socket.IO rejects bad credentials and disallowed origins, validates commands, and detects revoked credentials', async () => {
  await assert.rejects(socket('invalid-token'), /unauthorized/);
  const a = await bootstrap(pool);
  const foreign = io(address, { transports: ['websocket'], auth: { token: a.owner_token }, extraHeaders: { Origin: 'https://untrusted.example' }, reconnection: false });
  try { await new Promise<void>((resolve, reject) => { foreign.once('connect_error', () => resolve()); foreign.once('connect', () => reject(new Error('foreign origin accepted'))); }); }
  finally { foreign.disconnect(); }
  const client = await socket(a.collaborator_token);
  try {
    client.send({ type: 'subscribe', channel_id: a.channel_id, after: '-1' });
    assert.equal((await client.wait('error')).error, 'invalid_cursor');
    client.send({ type: 'message.send', channel_id: a.channel_id, text: 'Spoof', client_message_id: randomUUID(), author: 'agent' });
    assert.equal((await client.wait('error')).error, 'unknown_field');
    client.send({ type: 'subscribe', channel_id: a.channel_id, after: '0' }); await client.wait('subscribed');
    const closed = new Promise(resolve => client.ws.once('disconnect', resolve));
    await pool.query('DELETE FROM human_credentials WHERE user_id=$1', [a.collaborator_id]);
    await Promise.race([closed, delay(3000).then(() => { throw new Error('revoked credential kept connection'); })]);
  } finally { client.ws.disconnect(); }
});


test('a slow subscriber receives an explicit retryable error and is disconnected with bounded buffering', { timeout: 10_000 }, async () => {
  const a = await bootstrap(pool);
  const client = io(address, { transports: ['websocket'], auth: { token: a.owner_token }, reconnection: false });
  try {
    await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    const subscription = await client.timeout(2000).emitWithAck('channel.subscribe', { channel_id: a.channel_id, after: '0' });
    assert.ok(subscription.data);
    const fatal = new Promise<{ error: string }>(resolve => client.once('chat.error', resolve));
    const closed = new Promise(resolve => client.once('disconnect', resolve));
    // Deliberately do not acknowledge chat.events.
    await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), text: 'Slow subscriber' }, 201);
    assert.equal((await fatal).error, 'ack_timeout');
    await closed;
  } finally { client.disconnect(); }
});

test('message pages use immutable sequences for both directions with equal timestamps and scoped bounds', async () => {
  const a = await bootstrap(pool), chat = new ChatStore(pool);
  const saved = [];
  for (let i = 0; i < 125; i++) saved.push(await chat.send(a.owner_id, a.channel_id, { client_message_id: randomUUID(), text: `Page ${i}` }));
  await pool.query('UPDATE messages SET created_at=$1 WHERE channel_id=$2', ['2020-01-01T00:00:00Z', a.channel_id]);
  const latest = await api(a.owner_token, 'GET', `/channels/${a.channel_id}/messages`);
  assert.equal(latest.messages.length, 50);
  assert.equal(latest.messages[0].id, saved[75]!.id);
  assert.equal(latest.has_older, true); assert.equal(latest.has_newer, false);
  assert.equal(latest.older_cursor, latest.messages[0].sequence);
  assert.equal(latest.newer_cursor, latest.messages.at(-1).sequence);
  const middle = await api(a.owner_token, 'GET', `/channels/${a.channel_id}/messages?before=${latest.older_cursor}`);
  const oldest = await api(a.owner_token, 'GET', `/channels/${a.channel_id}/messages?before=${middle.older_cursor}`);
  assert.equal(oldest.messages.length, 25); assert.equal(oldest.has_older, false); assert.equal(oldest.has_newer, true);
  assert.deepEqual([...oldest.messages, ...middle.messages, ...latest.messages].map((m: any) => m.id), saved.map(m => m.id));
  const forward = await api(a.owner_token, 'GET', `/channels/${a.channel_id}/messages?after=${oldest.newer_cursor}&limit=100`);
  assert.deepEqual(forward.messages.map((m: any) => m.id), saved.slice(25).map(m => m.id));
  assert.equal(forward.has_older, true); assert.equal(forward.has_newer, false);
  const other = await chat.send(a.owner_id, a.channel_id, { client_message_id: randomUUID(), text: 'Other thread' });
  const thread = await api(a.owner_token, 'GET', `/threads/${saved[0]!.thread_id}/history?limit=100`);
  assert.deepEqual(thread.messages.map((m: any) => m.id), [saved[0]!.id]);
  assert.equal(thread.has_newer, false);
  assert.equal(thread.event_cursor, other.sequence);
  const before = await api(a.owner_token, 'GET', `/channels/${a.channel_id}/messages?before=0`);
  assert.deepEqual(before.messages, []); assert.equal(before.older_cursor, null); assert.equal(before.newer_cursor, null);
  assert.equal(before.has_older, false); assert.equal(before.has_newer, true);
  const after = await api(a.owner_token, 'GET', `/channels/${a.channel_id}/messages?after=${other.sequence}`);
  assert.deepEqual(after.messages, []); assert.equal(after.has_older, true); assert.equal(after.has_newer, false);
  await assert.rejects(pool.query('UPDATE messages SET sequence=sequence+1000 WHERE id=$1', [saved[0]!.id]), /immutable/);
});

test('message page authorization, empty results, limits and cursors are validated', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const empty = await api(a.owner_token, 'GET', `/channels/${a.channel_id}/messages`);
  assert.deepEqual(empty, { messages: [], older_cursor: null, newer_cursor: null, has_older: false, has_newer: false, event_cursor: '0' });
  for (const path of [`/channels/${a.channel_id}/messages`, `/threads/${a.thread_id}/history`]) {
    await api(b.owner_token, 'GET', path, undefined, 404);
    for (const query of ['before=-1', 'after=01', 'before=1.5', 'after=9223372036854775808', 'before=1&after=2', 'limit=0', 'limit=101', 'limit=1.5', 'limit=no', 'before=', 'unknown=1']) {
      await api(a.owner_token, 'GET', `${path}?${query}`, undefined, 400);
    }
  }
});

test('concurrent retries allocate one immutable message sequence and replay remains separate from message pages', async () => {
  const a = await bootstrap(pool), chat = new ChatStore(pool);
  const input = { client_message_id: randomUUID(), thread_id: a.thread_id, text: 'Retry together' };
  const duplicates = await Promise.all(Array.from({ length: 8 }, () => chat.send(a.owner_id, a.channel_id, input)));
  assert.equal(new Set(duplicates.map(m => m.id)).size, 1);
  assert.ok(duplicates[0]!.sequence);
  assert.equal(new Set(duplicates.map(m => m.sequence)).size, 1);
  const task = await store.createTask(a.collaborator_id, { workspace_id: a.workspace_id, thread_id: a.thread_id, installation_id: a.installation_id, goal: 'Paginated agent', skill: 'demo.echo' }, randomUUID());
  const snapshot = await api(a.owner_token, 'GET', `/channels/${a.channel_id}/messages`);
  assert.ok(BigInt(snapshot.event_cursor) > BigInt(snapshot.newer_cursor));
  await store.approveTask(a.owner_id, task.id);
  await deliverOne(store, [new MockConnector()]);
  const roots = await api(a.owner_token, 'GET', `/channels/${a.channel_id}/messages`);
  assert.deepEqual(roots.messages.map((m: any) => m.author.kind), ['human']);
  assert.equal(roots.messages[0].reply_count, 1);
  const messages = await api(a.owner_token, 'GET', `/threads/${a.thread_id}/history`);
  assert.deepEqual(messages.messages.map((m: any) => m.author.kind), ['human', 'agent']);
  assert.ok(BigInt(messages.messages[1].sequence) > BigInt(messages.messages[0].sequence) + 1n);
  const replay = await chat.events(a.owner_id, a.channel_id, snapshot.event_cursor);
  assert.equal(replay.filter(e => e.type === 'message.created').length, 1);
  for (const event of replay) if (event.type === 'message.created') assert.equal(event.payload.sequence, event.sequence);
  const client = await socket(a.owner_token);
  try {
    client.send({ type: 'subscribe', channel_id: a.channel_id, after: snapshot.event_cursor });
    await client.wait('subscribed');
    const recovered = await client.wait('events');
    assert.equal(recovered.events.filter((e: any) => e.type === 'message.created').length, 1);
    assert.ok(recovered.events.some((e: any) => e.type === 'task.event'));
  } finally { client.ws.disconnect(); }
});

test('message migration preserves original event order, payloads, and rows without changing replay events', async () => {
  const legacySchema = `legacy_${randomBytes(8).toString('hex')}`;
  const legacy = new Pool({ connectionString: url, options: `-c search_path=${legacySchema}` });
  await admin.query(`CREATE SCHEMA ${legacySchema}`);
  try {
    const directory = new URL('../../adapters/postgres/migrations/', import.meta.url);
    const migrations = (await readdir(directory)).filter(file => /^0(0\d|1[0-5])_.*\.sql$/.test(file)).sort();
    for (const file of migrations) await legacy.query(await readFile(new URL(file, directory), 'utf8'));
    await legacy.query('CREATE TABLE schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    await legacy.query('INSERT INTO schema_migrations(version) SELECT generate_series(1,15)');
    // Seed only historical columns: the current bootstrap also maps later migrations.
    const a = { owner_id: randomUUID(), workspace_id: randomUUID(), channel_id: randomUUID(), thread_id: randomUUID() };
    await legacy.query("INSERT INTO users(id,display_name) VALUES($1,'Legacy owner')", [a.owner_id]);
    await legacy.query("INSERT INTO workspaces(id,name) VALUES($1,'Legacy workspace')", [a.workspace_id]);
    await legacy.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [a.workspace_id,a.owner_id]);
    await legacy.query("INSERT INTO channels(id,workspace_id,name,private,created_by) VALUES($1,$2,'general',false,$3)", [a.channel_id,a.workspace_id,a.owner_id]);
    await legacy.query('INSERT INTO channel_members(workspace_id,channel_id,user_id) VALUES($1,$2,$3)', [a.workspace_id,a.channel_id,a.owner_id]);
    await legacy.query('INSERT INTO threads(id,workspace_id,channel_id) VALUES($1,$2,$3)', [a.thread_id,a.workspace_id,a.channel_id]);
    const ids = ['ffffffff-ffff-4fff-8fff-ffffffffffff', '00000000-0000-4000-8000-000000000001'];
    const document = { ops: [{ insert: 'Legacy\n' }] };
    const attachment = { id: randomUUID(), name: 'legacy.txt', type: 'text/plain', size: 5 };
    for (const id of ids) {
      await legacy.query(`INSERT INTO messages(id,workspace_id,channel_id,thread_id,author_type,user_id,client_message_id,request_hash,text,document,attachments,created_at)
        VALUES($1,$2,$3,$4,'human',$5,$6,'legacy','Legacy',$7,$8,'2020-01-01T00:00:00Z')`,
      [id, a.workspace_id, a.channel_id, a.thread_id, a.owner_id, randomUUID(), document, JSON.stringify([attachment])]);
      await legacy.query("SELECT append_chat_event($1,$2,'task.event','{}'::jsonb)", [a.channel_id, a.thread_id]);
    }
    const oldEvents = (await legacy.query('SELECT * FROM channel_events ORDER BY sequence')).rows;
    assert.equal(oldEvents[0].payload.sequence, undefined);
    await migrate(legacy);
    const chat = new ChatStore(legacy);
    const roots = await chat.messageHistory(a.owner_id, a.channel_id);
    assert.deepEqual(roots.messages.map(m => m.id), [ids[0]]);
    assert.equal(roots.messages[0]!.reply_count, 1);
    const after = await chat.threadHistory(a.owner_id, a.thread_id);
    assert.deepEqual(after.messages.map(m => m.id), ids);
    assert.deepEqual(after.messages.map(m => m.sequence), ['1', '3']);
    assert.equal(after.event_cursor, '4');
    assert.deepEqual(after.messages[0]!.document, document);
    assert.deepEqual(after.messages[0]!.attachments, [attachment]);
    assert.deepEqual((await legacy.query('SELECT * FROM channel_events ORDER BY sequence')).rows, oldEvents);
    const next = await new ChatStore(legacy).send(a.owner_id, a.channel_id, { client_message_id: randomUUID(), text: 'After migration' });
    assert.equal(next.sequence, '5');
    await migrate(legacy);
    assert.equal((await new ChatStore(legacy).messageHistory(a.owner_id, a.channel_id)).messages.length, 2);
  } finally { await legacy.end(); await admin.query(`DROP SCHEMA ${legacySchema} CASCADE`); }
});

test('concurrent message snapshots and replay cover every insert without losing bigint precision', async () => {
  const a = await bootstrap(pool), chat = new ChatStore(pool);
  await pool.query('UPDATE channels SET event_sequence=$1 WHERE id=$2', ['9007199254740992', a.channel_id]);
  const requests = Array.from({ length: 20 }, (_, i) => ({ client_message_id: randomUUID(), text: `Racing ${i}` }));
  const [snapshot, outcomes] = await Promise.all([
    chat.messageHistory(a.owner_id, a.channel_id),
    Promise.allSettled(requests.map(input => chat.send(a.owner_id, a.channel_id, input))),
  ]);
  const saved = [];
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === 'fulfilled') saved.push(outcome.value);
    else {
      // Bounded serializable retries may reject a burst; retry the same client identity after it settles.
      assert.equal(outcome.reason.code, 'session_conflict');
      saved.push(await chat.send(a.owner_id, a.channel_id, requests[index]));
    }
  }
  const replay = await chat.events(a.owner_id, a.channel_id, snapshot.event_cursor);
  const covered = new Set([...snapshot.messages.map(m => m.id), ...replay.flatMap(e => e.type === 'message.created' ? [e.payload.id] : [])]);
  assert.equal(covered.size, 20);
  assert.ok(saved.every(m => covered.has(m.id)));
  assert.equal(new Set(saved.map(m => m.sequence)).size, 20);
  assert.deepEqual(saved.map(m => m.sequence!).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1), Array.from({ length: 20 }, (_, i) => (9007199254740993n + BigInt(i)).toString()));
  const forward = await chat.messageHistory(a.owner_id, a.channel_id, { after: '9007199254740993' });
  assert.equal(forward.messages.length, 19);
  assert.equal(forward.older_cursor, '9007199254740994');
});

test('replay and socket subscriptions tolerate reserved sequence gaps from direct SQL retries', async () => {
  const a = await bootstrap(pool), chat = new ChatStore(pool);
  const first = await chat.send(a.owner_id, a.channel_id, { client_message_id: randomUUID(), thread_id: a.thread_id, text: 'First' });
  await pool.query(`INSERT INTO messages(id,workspace_id,channel_id,thread_id,author_type,user_id,client_message_id,request_hash,text)
    SELECT id,workspace_id,channel_id,thread_id,author_type,user_id,client_message_id,request_hash,text FROM messages WHERE id=$1 ON CONFLICT DO NOTHING`, [first.id]);
  const snapshot = await chat.messageHistory(a.owner_id, a.channel_id);
  assert.equal(snapshot.event_cursor, '2'); assert.equal(snapshot.newer_cursor, '1');
  const next = await chat.send(a.owner_id, a.channel_id, { client_message_id: randomUUID(), thread_id: a.thread_id, text: 'After gap' });
  assert.equal(next.sequence, '3');
  assert.deepEqual((await chat.events(a.owner_id, a.channel_id, first.sequence!)).map(e => e.sequence), ['3']);
  assert.deepEqual((await chat.events(a.owner_id, a.channel_id, snapshot.event_cursor)).map(e => e.sequence), ['3']);
  const client = await socket(a.owner_token);
  try {
    client.send({ type: 'subscribe', channel_id: a.channel_id, after: first.sequence }); await client.wait('subscribed');
    const recovered = await client.wait('events');
    assert.equal(recovered.cursor, '3'); assert.equal(recovered.events[0].payload.id, next.id);
  } finally { client.ws.disconnect(); }
});

test('closing one API instance does not disconnect clients on another instance', async () => {
  const temporaryAdapter = new RedisSocketAdapter(process.env.TEST_REDIS_URL, schema);
  await temporaryAdapter.connect();
  const temporary = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, realtime: { adapter: temporaryAdapter, } });
  await temporary.listen({ host:'127.0.0.1',port:0 });
  const a = await bootstrap(pool), client = await socket(a.owner_token,secondAddress);
  try {
    client.send({type:'subscribe',channel_id:a.channel_id,after:'0'}); await client.wait('subscribed');
    await temporary.close();
    await delay(100);
    assert.equal(client.ws.connected,true);
    const saved = await new ChatStore(pool).send(a.owner_id,a.channel_id,{client_message_id:randomUUID(),text:'Other instance is still live'});
    assert.equal((await client.wait('events')).events[0].payload.id,saved.id);
  } finally { client.ws.disconnect(); await temporary.close(); }
});

test('a transient authentication store failure is retryable rather than unauthorized', async () => {
  const temporaryStore = new PostgresStore(pool), original = temporaryStore.authenticate.bind(temporaryStore);
  let unavailable = true;
  temporaryStore.authenticate = async token => { if (unavailable) throw new Error('database connection timeout'); return original(token); };
  const temporary = createApi(temporaryStore,{allowDevelopmentTokens:true});
  const base = await temporary.listen({host:'127.0.0.1',port:0});
  const a = await bootstrap(pool);
  try {
    await assert.rejects(socket(a.owner_token,base),/^Error: internal_error$/);
    unavailable = false;
    const connected = await socket(a.owner_token,base);
    connected.ws.disconnect();
  } finally { await temporary.close(); }
});

test('emoji reactions persist per user, retry safely, replay and enforce channel access', async () => {
  const a = await bootstrap(pool), outsider = await bootstrap(pool);
  const message = await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), text: 'Emoji test 👍🏽' }, 201);
  const path = `/channels/${a.channel_id}/messages/${message.id}/reactions`;
  const first = await api(a.owner_token, 'POST', path, { emoji: '👍🏽', active: true });
  assert.equal(first.reactions[0].count, 1);
  const retry = await api(a.owner_token, 'POST', path, { emoji: '👍🏽', active: true });
  assert.equal(retry.reaction_sequence, first.reaction_sequence);
  await api(a.collaborator_token, 'POST', path, { emoji: '👍🏽', active: true });
  const page = await api(a.owner_token, 'GET', `/channels/${a.channel_id}/messages`);
  assert.equal(page.messages[0].reactions[0].count, 2);
  assert.deepEqual(new Set(page.messages[0].reactions[0].user_ids), new Set([a.owner_id, a.collaborator_id]));
  const client = await socket(a.owner_token);
  try {
    client.send({ type: 'subscribe', channel_id: a.channel_id, after: page.event_cursor });
    await client.wait('subscribed');
    const removed = await api(a.owner_token, 'POST', path, { emoji: '👍🏽', active: false });
    assert.equal(removed.reactions[0].count, 1);
    const replay = await client.wait('events', frame => frame.events.some((e: any) => e.type === 'message.updated'));
    assert.equal(replay.events[0].payload.reactions[0].count, 1);
    assert.equal(replay.events[0].payload.sequence, message.sequence);
    assert.notEqual(replay.events[0].payload.reaction_sequence, message.sequence);
  } finally { client.ws.close(); }
  await api(outsider.owner_token, 'POST', path, { emoji: '👀', active: true }, 404);
  await api(a.owner_token, 'POST', path, { emoji: 'not-an-emoji', active: true }, 400);
  await api(a.owner_token, 'POST', path, { emoji: '👍👀', active: true }, 400);
  await api(a.owner_token, 'POST', path, { emoji: '👀', active: 'yes' }, 400);
  await api(a.owner_token, 'POST', path, { emoji: '👀', active: true, user_id: outsider.owner_id }, 400);
  await api(a.collaborator_token, 'POST', path, { emoji: '👍🏽', active: false });
  const thread = await api(a.owner_token, 'GET', `/threads/${message.thread_id}/history`);
  assert.deepEqual(thread.messages[0].reactions, []);
});

test('channel message pages contain roots with complete reply counts while thread history keeps replies',async()=>{
  const a=await bootstrap(pool), chat=new ChatStore(pool);
  const root=await chat.send(a.owner_id,a.channel_id,{client_message_id:randomUUID(),text:'Channel root'});
  const reply=await chat.send(a.owner_id,a.channel_id,{client_message_id:randomUUID(),thread_id:root.thread_id,text:'Thread reply'});
  assert.equal(root.thread_root_id,root.id);
  assert.equal(root.reply_count,0);
  assert.equal(reply.thread_root_id,root.id);
  assert.equal(reply.reply_count,1);
  const other=await chat.send(a.owner_id,a.channel_id,{client_message_id:randomUUID(),text:'Another root'});
  const page=await chat.messageHistory(a.owner_id,a.channel_id,{limit:'1'});
  assert.deepEqual(page.messages.map(m=>m.id),[other.id]);
  const older=await chat.messageHistory(a.owner_id,a.channel_id,{before:page.older_cursor,limit:'1'});
  assert.deepEqual(older.messages.map(m=>m.id),[root.id]);
  assert.equal(older.messages[0]!.reply_count,1);
  assert.equal(older.has_older,false);
  const thread=await chat.threadHistory(a.owner_id,root.thread_id);
  assert.deepEqual(thread.messages.map(m=>m.id),[root.id,reply.id]);
  const replay=await chat.history(a.owner_id,a.channel_id);
  const event=replay.events.find(e=>e.type==='message.created'&&e.payload.id===reply.id);
  assert.ok(event?.type==='message.created');
  assert.equal(event.payload.thread_root_id,root.id);
});
