import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { ChatStore } from '@space/postgres/chat';
import { PostgresStore } from '@space/postgres/store';

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

test('attachments and mentions retain serializable protection and plain replies use atomic sequencing without explicit locks', async () => {
  const seed = await bootstrap(pool), asset = await readyAsset(seed);
  statements = [];
  const root = await chat.send(seed.owner_id, seed.channel_id, {
    client_message_id: randomUUID(), text: '@collaborator', asset_ids: [asset],
    document: { ops: [{ insert: '@collaborator', attributes: { mention: { kind: 'user', id: seed.collaborator_id, label: 'collaborator' } } }, { insert: '\n' }] },
  });
  await chat.send(seed.collaborator_id, seed.channel_id, { client_message_id: randomUUID(), text: 'Reply', thread_id: root.thread_id });
  assert.deepEqual(statements.filter(text => /\bfor\s+(?:update|share|no key update|key share)\b|pg_advisory|\block\s+table\b/i.test(text)), []);
  assert.equal(statements.filter(text => /begin.*serializable/i.test(text)).length, 1);
  assert.equal(statements.filter(text => /begin.*read committed/i.test(text)).length, 1);
  assert.equal((await pool.query('SELECT message_id FROM assets WHERE id=$1', [asset])).rows[0].message_id, root.id);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM mention_notifications WHERE message_id=$1', [root.id])).rows[0].count, 1);
});

test('concurrent identical retries create one durable message, event and notification', async () => {
  const seed = await bootstrap(pool);
  const input = { client_message_id: randomUUID(), text: '@collaborator', document: { ops: [{ insert: '@collaborator', attributes: { mention: { kind: 'user', id: seed.collaborator_id, label: 'collaborator' } } }, { insert: '\n' }] } };
  const otherInstance = new ChatStore(pool);
  const results = await Promise.all([chat, otherInstance, chat, otherInstance, chat, otherInstance].map(store => store.send(seed.owner_id, seed.channel_id, input)));
  assert.equal(new Set(results.map(message => message.id)).size, 1);
  await assertMessageCount(seed.channel_id, 1);
  for (const table of ['notifications', 'mention_notifications']) {
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE message_id=$1`, [results[0]!.id])).rows[0].count, 1);
  }
});

test('a full channel queue bounds admission and drains after a rejected write', { timeout: 10000 }, async () => {
  const seed = await bootstrap(pool), gate = pauseMessageInsert();
  const input = { client_message_id: randomUUID(), text: 'First' };
  const first = chat.send(seed.owner_id, seed.channel_id, input);
  await gate.reached;
  const conflict = assert.rejects(chat.send(seed.owner_id, seed.channel_id, { ...input, text: 'Different' }), { code: 'idempotency_conflict' });
  const repeats = Array.from({ length: 30 }, () => chat.send(seed.owner_id, seed.channel_id, input));
  try {
    await assert.rejects(chat.send(seed.owner_id, seed.channel_id, input), { code: 'channel_write_busy' });
  } finally { gate.resume(); }
  await conflict;
  const results = await Promise.all([first, ...repeats]);
  assert.equal(new Set(results.map(row => row.id)).size, 1);
  await chat.send(seed.owner_id, seed.channel_id, { ...input, client_message_id: randomUUID() });
  await assertMessageCount(seed.channel_id, 2);
});

test('workspace revision totals retain existing counts and count each committed change', async () => {
  const seed = await bootstrap(pool);
  const key = 'workspace-messages:' + seed.workspace_id;
  await pool.query('INSERT INTO resource_update_revisions(resource,revision) VALUES($1,17)', [key]);
  const read = async () => Number((await pool.query('SELECT revision FROM resource_revision_totals WHERE resource=$1', [key])).rows[0].revision);
  const bump = "INSERT INTO chat_delivery_outbox(workspace_id,channel_id,resource_scope) VALUES($1,$2,'message')";
  const initial = await read();
  const delayed = await pool.connect();
  try {
    await delayed.query('BEGIN');
    await pool.query(bump, [seed.workspace_id, seed.channel_id]);
    await delayed.query(bump, [seed.workspace_id, seed.channel_id]);
    assert.equal(await read(), initial + 1);
    await delayed.query('COMMIT');
    assert.equal(await read(), initial + 2);
    await delayed.query('BEGIN');
    await delayed.query(bump, [seed.workspace_id, seed.channel_id]);
    await delayed.query('ROLLBACK');
    assert.equal(await read(), initial + 2);
  } finally { await delayed.query('ROLLBACK'); delayed.release(); }
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

test('a cancellation on another API can win after the send checked its identity', { timeout: 10000 }, async () => {
  const seed = await bootstrap(pool), gate = pauseMessageInsert();
  const input = { client_message_id: randomUUID(), text: 'Cancelled across APIs' };
  const rejected = assert.rejects(chat.send(seed.owner_id, seed.channel_id, input), { code: 'message_cancelled' });
  try {
    await gate.reached;
    const other = new ChatStore(pool);
    assert.deepEqual(await other.cancelOutgoing(seed.owner_id, seed.channel_id, input.client_message_id), { message: null });
  } finally { gate.resume(); }
  await rejected;
  await assert.rejects(chat.send(seed.owner_id, seed.channel_id, input), { code: 'message_cancelled' });
  await assertMessageCount(seed.channel_id, 0);
});

test('both API writers commit distinct messages in channel replay order', async () => {
  const seed = await bootstrap(pool), other = new ChatStore(pool);
  const senders = [chat, other, chat, other];
  const sent = await Promise.all(senders.map((writer, i) => writer.send(i % 2 ? seed.collaborator_id : seed.owner_id,
    seed.channel_id, { client_message_id: randomUUID(), text: 'Concurrent ' + i })));
  const replay = await chat.events(seed.owner_id, seed.channel_id, '0');
  assert.deepEqual(replay.map(event => event.sequence), ['1', '2', '3', '4']);
  assert.deepEqual(replay.map(event => event.type === 'message.created' ? event.payload.id : null).sort(), sent.map(row => row.id).sort());
  await assertMessageCount(seed.channel_id, 4);
});

test('duplicate reaction changes across API writers return the same revision and emit one event per change', async () => {
  const seed = await bootstrap(pool), other = new ChatStore(pool);
  const root = await chat.send(seed.owner_id, seed.channel_id, {client_message_id: randomUUID(), text: 'Reaction target'});
  for (const active of [true, false]) {
    const [first, second] = await Promise.all([chat, other].map(writer =>
      writer.react(seed.collaborator_id, seed.channel_id, root.id, {emoji: '👍', active})));
    assert.equal(first!.reaction_sequence, second!.reaction_sequence);
    assert.deepEqual(first!.reactions, second!.reactions);
    assert.equal(first!.reactions?.length, active ? 1 : 0);
  }
  const replay = await chat.events(seed.owner_id, seed.channel_id, root.sequence!);
  assert.deepEqual(replay.map(event => event.type), ['message.updated', 'message.updated']);
  const notifications = await pool.query("SELECT id FROM notifications WHERE message_id=$1 AND kind='reaction'", [root.id]);
  assert.equal(notifications.rowCount, 1);
});

test('an edit racing the same message on another API has one winning revision', async () => {
  const seed = await bootstrap(pool), other = new ChatStore(pool);
  const root = await chat.send(seed.owner_id, seed.channel_id, {client_message_id: randomUUID(), text: 'Draft'});
  const results = await Promise.allSettled([chat, other].map((writer, i) =>
    writer.editMessage(seed.owner_id, seed.channel_id, root.id, {
      revision: root.reaction_sequence ?? '0', document: {ops: [{insert: 'Edit ' + i}]},
    })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected')?.reason.code, 'message_changed');
  const replay = await chat.events(seed.owner_id, seed.channel_id, root.sequence!);
  assert.deepEqual(replay.map(event => event.type), ['message.updated']);
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
  const seed = await bootstrap(pool), asset = await readyAsset(seed);
  let conflicts = 0;
  beforeQuery = async text => {
    if (!/^insert into "messages"/i.test(text)) return;
    conflicts++;
    await pool.query('UPDATE channels SET topic=$2 WHERE id=$1', [seed.channel_id, `Competing update ${conflicts}`]);
  };
  try {
    await assert.rejects(chat.send(seed.owner_id, seed.channel_id, { client_message_id: randomUUID(), text: 'Bounded retry', asset_ids: [asset] }), { code: 'session_conflict' });
  } finally { beforeQuery = undefined; }
  assert.equal(conflicts, 5);
  await assertMessageCount(seed.channel_id, 0);
});

test('sent message edits enforce ownership, reject competing saves and replay the saved content once', async () => {
  const seed = await bootstrap(pool);
  const original = await chat.send(seed.owner_id, seed.channel_id, { client_message_id: randomUUID(), text: '😂' });
  const edit = (actor: string, text: string, revision = original.reaction_sequence ?? '0') =>
    chat.editMessage(actor, seed.channel_id, original.id, { document: { ops: [{ insert: text + '\n' }] }, revision });
  await assert.rejects(edit(seed.collaborator_id, 'Other author'), { code: 'not_found' });
  const results = await Promise.allSettled([edit(seed.owner_id, '😂 hello'), edit(seed.owner_id, '😂 hi')]);
  const saved = results.find(result => result.status === 'fulfilled')?.value;
  assert.ok(saved);
  assert.equal(results.find(result => result.status === 'rejected')?.reason.code, 'message_changed');
  assert.equal((await edit(seed.owner_id, saved.text)).reaction_sequence, saved.reaction_sequence);
  const restored = await edit(seed.owner_id, '😂', saved.reaction_sequence);
  assert.equal(restored.sequence, original.sequence);
  assert.equal(restored.thread_id, original.thread_id);
  const events = await pool.query("SELECT payload FROM channel_events WHERE channel_id=$1 AND type='message.updated' ORDER BY sequence", [seed.channel_id]);
  assert.deepEqual(events.rows.map(row => row.payload.text), [saved.text, '😂']);
  assert.deepEqual(events.rows[1].payload.document, restored.document);
  await chat.deleteMessage(seed.owner_id, seed.channel_id, original.id);
  await assert.rejects(edit(seed.owner_id, 'Restored', restored.reaction_sequence), { code: 'not_found' });
});

test('hydrates channel reply bars and replay with current public participants after deletes', async () => {
  const a = await bootstrap(pool), chat = new ChatStore(pool);
  const root = await chat.send(a.owner_id, a.channel_id, {client_message_id:randomUUID(), text:'Root'});
  await pool.query('UPDATE users SET image=$1 WHERE id=$2', ['/profile/photo.png', a.collaborator_id]);
  const reply = await chat.send(a.collaborator_id, a.channel_id, {client_message_id:randomUUID(), text:'First', thread_id:root.thread_id});
  const again = await chat.send(a.collaborator_id, a.channel_id, {client_message_id:randomUUID(), text:'Second', thread_id:root.thread_id});
  const session=randomUUID();
  await pool.query('INSERT INTO agent_sessions(id,workspace_id,installation_id,origin_thread_id,title,managed,created_by) VALUES($1,$2,$3,$4,$5,true,$6)',
    [session,a.workspace_id,a.installation_id,root.thread_id,'Private agent work',a.owner_id]);
  const task=await new PostgresStore(pool).createTask(a.owner_id,{workspace_id:a.workspace_id,thread_id:root.thread_id,installation_id:a.installation_id,goal:'Session reference',skill:'demo.echo'},randomUUID());
  await pool.query('INSERT INTO messages(id,workspace_id,channel_id,thread_id,task_id,installation_id,agent_session_id,text) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [randomUUID(),a.workspace_id,a.channel_id,root.thread_id,task.id,a.installation_id,session,'Private agent work']);
  const readRoot = async () => (await chat.messageHistory(a.owner_id, a.channel_id)).messages.find(m=>m.id===root.id)!;
  const summary = (await readRoot()).reply_summary!;
  assert.equal(summary.count, 2);
  assert.deepEqual(summary.participants, [{...reply.author, image:'/profile/photo.png'}]);
  assert.equal(Date.parse(summary.last_reply_at!), Date.parse(again.created_at));
  await chat.deleteMessage(a.collaborator_id, a.channel_id, again.id);
  const updated = (await readRoot()).reply_summary!;
  assert.equal(updated.count, 1);
  assert.equal(Date.parse(updated.last_reply_at!), Date.parse(reply.created_at));
  const replay = (await chat.events(a.owner_id, a.channel_id, again.sequence!)).at(-1)!;
  assert.equal(replay.type,'message.updated');
  if (replay.type === 'message.updated') assert.deepEqual(replay.payload.reply_summary,updated);
  const dm = await chat.directMessages.open(a.owner_id, a.workspace_id, {user_id:a.collaborator_id});
  const directRoot = await chat.send(a.owner_id, dm.id, {client_message_id:randomUUID(),text:'DM root'});
  await chat.send(a.collaborator_id, dm.id, {client_message_id:randomUUID(),text:'DM reply',thread_id:directRoot.thread_id});
  assert.deepEqual((await chat.messageHistory(a.owner_id, dm.id)).messages[0]!.reply_summary?.participants,summary.participants);
  const outsider = await bootstrap(pool);
  await assert.rejects(chat.messageHistory(outsider.owner_id, dm.id),{code:'not_found'});
  await assert.rejects(chat.events(outsider.owner_id, dm.id, '0'),{code:'not_found'});
});
