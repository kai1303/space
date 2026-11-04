import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { ChatStore } from '@space/postgres/chat';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required');
const schema = `chat_send_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 12 });
const sender = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=5000`, max: 12 });
const chat = new ChatStore(sender);
let statements: string[] = [];
let beforeQuery: ((text: string) => Promise<void>) | undefined;
sender.on('connect', client => {
  const query = client.query.bind(client);
  client.query = ((...args: any[]) => {
    const text = typeof args[0] === 'string' ? args[0] : args[0].text;
    statements.push(text);
    const pending = beforeQuery?.(text);
    return pending ? pending.then(() => (query as any)(...args)) : (query as any)(...args);
  }) as typeof client.query;
});
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await sender.end(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

async function readyAsset(seed: Awaited<ReturnType<typeof bootstrap>>) {
  const id = randomUUID();
  await pool.query(`INSERT INTO assets(id,workspace_id,channel_id,uploader_id,name,size,type,staging_key,object_key,status)
    VALUES($1,$2,$3,$4,'test.txt',1,'text/plain',$1::uuid::text||'/staging',$1::uuid::text||'/object','ready')`, [id, seed.workspace_id, seed.channel_id, seed.owner_id]);
  return id;
}

function pauseMessageInsert() {
  let arrive!: () => void, resume!: () => void;
  const reached = new Promise<void>(resolve => { arrive = resolve; });
  const released = new Promise<void>(resolve => { resume = resolve; });
  beforeQuery = async text => {
    if (!/^insert into "messages"/i.test(text)) return;
    beforeQuery = undefined;
    arrive();
    await released;
  };
  return { reached, resume };
}

async function assertMessageCount(channel: string, expected: number) {
  for (const table of ['messages', 'message_identities', 'channel_events']) {
    assert.equal(Number((await pool.query(`SELECT count(*) FROM ${table} WHERE channel_id=$1`, [channel])).rows[0].count), expected, table);
  }
}

test('send with mentions, attachments and replies uses serializable transactions without explicit locks', async () => {
  const seed = await bootstrap(pool), asset = await readyAsset(seed);
  statements = [];
  const root = await chat.send(seed.owner_id, seed.channel_id, {
    client_message_id: randomUUID(), text: '@collaborator', asset_ids: [asset],
    document: { ops: [{ insert: '@collaborator', attributes: { mention: { kind: 'user', id: seed.collaborator_id, label: 'collaborator' } } }, { insert: '\n' }] },
  });
  await chat.send(seed.collaborator_id, seed.channel_id, { client_message_id: randomUUID(), text: 'Reply', thread_id: root.thread_id });
  assert.deepEqual(statements.filter(text => /\bfor\s+(?:update|share|no key update|key share)\b|pg_advisory|\block\s+table\b/i.test(text)), []);
  assert.equal(statements.filter(text => /begin.*serializable/i.test(text)).length, 2);
  assert.equal((await pool.query('SELECT message_id FROM assets WHERE id=$1', [asset])).rows[0].message_id, root.id);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM mention_notifications WHERE message_id=$1', [root.id])).rows[0].count, 1);
});

test('concurrent identical retries create one durable message, event and notification', async () => {
  const seed = await bootstrap(pool);
  const input = { client_message_id: randomUUID(), text: '@collaborator', document: { ops: [{ insert: '@collaborator', attributes: { mention: { kind: 'user', id: seed.collaborator_id, label: 'collaborator' } } }, { insert: '\n' }] } };
  const results = await Promise.all(Array.from({ length: 6 }, () => chat.send(seed.owner_id, seed.channel_id, input)));
  assert.equal(new Set(results.map(message => message.id)).size, 1);
  await assertMessageCount(seed.channel_id, 1);
  for (const table of ['notifications', 'mention_notifications']) {
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE message_id=$1`, [results[0]!.id])).rows[0].count, 1);
  }
});

test('the workspace identity constraint resolves concurrent conflicting sends across channels', async () => {
  const seed = await bootstrap(pool);
  const other = await new ChatStore(pool).createChannel(seed.owner_id, seed.workspace_id, { name: 'Other', private: false });
  const input = { client_message_id: randomUUID(), text: 'Same identity' };
  const results = await Promise.allSettled([chat.send(seed.owner_id, seed.channel_id, input), chat.send(seed.owner_id, other.id, input)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'idempotency_conflict');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM messages WHERE workspace_id=$1', [seed.workspace_id])).rows[0].count, 1);
});

test('concurrent attachment reuse has one winner and rolls back the rejected message event', async () => {
  const seed = await bootstrap(pool), asset = await readyAsset(seed);
  const results = await Promise.allSettled(Array.from({ length: 2 }, () => chat.send(seed.owner_id, seed.channel_id, { client_message_id: randomUUID(), text: 'Attach once', asset_ids: [asset] })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'asset_unavailable');
  await assertMessageCount(seed.channel_id, 1);
});

test('deleting an attachment after its read aborts the send and all durable side effects', { timeout: 10000 }, async () => {
  const seed = await bootstrap(pool), asset = await readyAsset(seed), gate = pauseMessageInsert();
  const sending = chat.send(seed.owner_id, seed.channel_id, { client_message_id: randomUUID(), text: 'Deleted attachment', asset_ids: [asset] });
  const rejected = assert.rejects(sending, { code: 'asset_unavailable' });
  try { await gate.reached; await pool.query('DELETE FROM assets WHERE id=$1', [asset]); } finally { gate.resume(); }
  await rejected;
  await assertMessageCount(seed.channel_id, 0);
});

test('an attachment expiring during send cannot be bound using the transaction start time', { timeout: 10000 }, async () => {
  const seed = await bootstrap(pool), asset = await readyAsset(seed);
  const expires = new Date(Date.now() + 1500);
  await pool.query('UPDATE assets SET expires_at=$2 WHERE id=$1', [asset, expires]);
  const gate = pauseMessageInsert();
  const sending = chat.send(seed.owner_id, seed.channel_id, { client_message_id: randomUUID(), text: 'Expiry race', asset_ids: [asset] });
  const rejected = assert.rejects(sending, { code: 'asset_unavailable' });
  try { await gate.reached; await delay(Math.max(0, expires.getTime() - Date.now() + 20)); } finally { gate.resume(); }
  await rejected;
  await assertMessageCount(seed.channel_id, 0);
  assert.equal((await pool.query('SELECT message_id FROM assets WHERE id=$1', [asset])).rows[0].message_id, null);
});

test('archiving after the authorization snapshot forces a fresh check before send commits', { timeout: 10000 }, async () => {
  const seed = await bootstrap(pool), gate = pauseMessageInsert();
  const sending = chat.send(seed.owner_id, seed.channel_id, { client_message_id: randomUUID(), text: 'Archive race' });
  const rejected = assert.rejects(sending, { code: 'channel_archived' });
  try { await gate.reached; await pool.query('UPDATE channels SET archived_at=now() WHERE id=$1', [seed.channel_id]); } finally { gate.resume(); }
  await rejected;
  await assertMessageCount(seed.channel_id, 0);
});

test('membership revocation denies subsequent sends and replay of a previously authorized identity', async () => {
  const seed = await bootstrap(pool), input = { client_message_id: randomUUID(), text: 'Authorized before revocation' };
  await chat.send(seed.collaborator_id, seed.channel_id, input);
  await new ChatStore(pool).removeMember(seed.owner_id, seed.channel_id, seed.collaborator_id);
  await assert.rejects(chat.send(seed.collaborator_id, seed.channel_id, input), { code: 'not_found' });
  await assert.rejects(chat.send(seed.collaborator_id, seed.channel_id, { ...input, client_message_id: randomUUID() }), { code: 'not_found' });
  await assertMessageCount(seed.channel_id, 1);
});

test('overlapping membership revocations preserve a complete send or rejection and deny later sends', { timeout: 15000 }, async () => {
  for (const workspace of [false, true]) {
    const seed = await bootstrap(pool), gate = pauseMessageInsert();
    const input = { client_message_id: randomUUID(), text: 'Concurrent revocation', thread_id: seed.thread_id };
    const sending = Promise.allSettled([chat.send(seed.collaborator_id, seed.channel_id, input)]);
    try {
      await gate.reached;
      if (workspace) await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2', [seed.workspace_id, seed.collaborator_id]);
      else await new ChatStore(pool).removeMember(seed.owner_id, seed.channel_id, seed.collaborator_id);
    } finally { gate.resume(); }
    const [result] = await sending;
    // Overlapping operations can serialize in either order; no partial send may survive.
    if (result!.status === 'rejected') assert.equal(result!.reason.code, 'not_found');
    await assertMessageCount(seed.channel_id, result!.status === 'fulfilled' ? 1 : 0);
    await assert.rejects(chat.send(seed.collaborator_id, seed.channel_id, input), { code: 'not_found' });
  }
});

test('repeated serialization conflicts exhaust the bounded retry budget without partial messages', { timeout: 10000 }, async () => {
  const seed = await bootstrap(pool);
  let conflicts = 0;
  beforeQuery = async text => {
    if (!/^insert into "messages"/i.test(text)) return;
    conflicts++;
    await pool.query('UPDATE channels SET topic=$2 WHERE id=$1', [seed.channel_id, `Competing update ${conflicts}`]);
  };
  try {
    await assert.rejects(chat.send(seed.owner_id, seed.channel_id, { client_message_id: randomUUID(), text: 'Bounded retry' }), { code: 'session_conflict' });
  } finally { beforeQuery = undefined; }
  assert.equal(conflicts, 5);
  await assertMessageCount(seed.channel_id, 0);
});
