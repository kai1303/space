import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { Pool } from 'pg';
import { EventBus, type EventDelivery } from '@space/events';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { PostgresStore } from '@space/postgres/store';
import { ChatStore } from '@space/postgres/chat';
import { createApi } from '@space/server/api';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
const schema = `todo_reminders_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const reminderStatements = new EventEmitter();
pool.on('connect', client => client.on('notice', notice => {
  if (notice.message === 'test_reminder_statement') reminderStatements.emit('started');
}));
class ProbeBus extends EventBus {
  readonly handlers = new Map<string, Parameters<EventBus['subscribe']>[2]>();
  override async start() {}
  override async subscribe(filter: string, _options: Parameters<EventBus['subscribe']>[1], handler: Parameters<EventBus['subscribe']>[2]) {
    this.handlers.set(filter, handler); return async () => { this.handlers.delete(filter); };
  }
  override async close() {}
  async receive(data: Record<string, unknown>) {
    let acknowledgments = 0, retry: number | undefined;
    const delivery: EventDelivery = {
      event: { id: randomUUID(), schema, kind: 'todo.reminder_due', aggregate_id: String(data.todo_id), data },
      ack: () => { acknowledgments++; }, retry: (delay = 1000) => { retry = delay; },
    };
    const handler = this.handlers.get('todo.reminder_due.*');
    assert.ok(handler, 'the API must consume durable Todo reminders');
    await handler(delivery);
    return { acknowledgments, retry };
  }
}
const bus = new ProbeBus('nats://unused', schema);
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, realtime: { events: bus } });
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool);
  // NOTICE arrives before commit, after the reminder statement has acquired its snapshot.
  await pool.query(`CREATE FUNCTION observe_reminder_statement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF current_query() LIKE 'WITH fired AS (%' THEN RAISE NOTICE 'test_reminder_statement'; END IF;
    RETURN NULL;
  END $$;
  CREATE TRIGGER observe_reminder_statement BEFORE UPDATE ON hub_todos FOR EACH STATEMENT EXECUTE FUNCTION observe_reminder_statement()`);
  await app.ready();
});
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

test('API registers the durable Todo reminder consumer', () => {
  assert.ok(bus.handlers.has('todo.reminder_due.*'), 'the API must consume durable Todo reminders');
});

async function scheduled(remindAt = new Date(Date.now() - 1000).toISOString()) {
  const owner = await bootstrap(pool), id = randomUUID();
  await pool.query('INSERT INTO hub_todos(id,workspace_id,user_id,title,remind_at) VALUES($1,$2,$3,$4,$5)', [id, owner.workspace_id, owner.owner_id, 'Review the plan', remindAt]);
  const row = (await pool.query('SELECT remind_at,reminder_version FROM hub_todos WHERE id=$1', [id])).rows[0];
  return { ...owner, id, data: { todo_id: id, remind_at: row.remind_at.toISOString(), reminder_version: row.reminder_version } };
}
async function fired(id: string) { return (await pool.query('SELECT reminder_fired_at FROM hub_todos WHERE id=$1', [id])).rows[0].reminder_fired_at; }

test('parallel duplicates fire once and enqueue one durable realtime change', async () => {
  const todo = await scheduled();
  await pool.query('DELETE FROM chat_delivery_outbox');
  const results = await Promise.all([bus.receive(todo.data), bus.receive(todo.data)]);
  assert.ok(await fired(todo.id));
  assert.ok(results.every(result => result.acknowledgments === 1));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM chat_delivery_outbox')).rows[0].n, 1);
  const first = await fired(todo.id);
  await bus.receive(todo.data);
  assert.deepEqual(await fired(todo.id), first);
});

test('early reminders defer to database time instead of firing', async () => {
  const todo = await scheduled(new Date(Date.now() + 60000).toISOString());
  const result = await bus.receive(todo.data);
  assert.equal(result.acknowledgments, 0); assert.ok(result.retry! > 50000);
  assert.equal(await fired(todo.id), null);
});

test('canceled and stale generations never fire even when the original timestamp is reused', async () => {
  for (const flag of ['completed', 'archived', 'deleted']) {
    const todo = await scheduled();
    await pool.query(`UPDATE hub_todos SET ${flag}=true WHERE id=$1`, [todo.id]);
    assert.equal((await bus.receive(todo.data)).acknowledgments, 1);
    assert.equal(await fired(todo.id), null);
  }
  const todo = await scheduled();
  await pool.query('UPDATE hub_todos SET remind_at=NULL WHERE id=$1', [todo.id]);
  await pool.query('UPDATE hub_todos SET remind_at=$2 WHERE id=$1', [todo.id, todo.data.remind_at]);
  assert.equal((await bus.receive(todo.data)).acknowledgments, 1);
  assert.equal(await fired(todo.id), null);
  const current = (await pool.query('SELECT reminder_version FROM hub_todos WHERE id=$1', [todo.id])).rows[0];
  await bus.receive({ ...todo.data, reminder_version: current.reminder_version });
  assert.ok(await fired(todo.id));
});

test('delivery overlapping a concurrent schedule edit rechecks the committed generation', async () => {
  const todo = await scheduled(), editor = await pool.connect();
  let delivery: ReturnType<typeof bus.receive> | undefined;
  try {
    await editor.query('BEGIN');
    // Ordinary writes retain their normal transaction locks; no explicit lock is acquired.
    await editor.query('UPDATE hub_todos SET remind_at=NULL WHERE id=$1', [todo.id]);
    await editor.query('UPDATE hub_todos SET remind_at=$2 WHERE id=$1', [todo.id, todo.data.remind_at]);
    const started = once(reminderStatements, 'started', { signal: AbortSignal.timeout(3000) });
    delivery = bus.receive(todo.data);
    await started;
    await editor.query('COMMIT');
    assert.deepEqual(await delivery, { acknowledgments: 1, retry: undefined });
    assert.equal(await fired(todo.id), null, 'the stale generation cannot fire the replacement schedule');
    const current = (await pool.query('SELECT reminder_version FROM hub_todos WHERE id=$1', [todo.id])).rows[0];
    await bus.receive({ ...todo.data, reminder_version: current.reminder_version });
    assert.ok(await fired(todo.id));
  } finally { await editor.query('ROLLBACK'); editor.release(); await delivery; }
});

test('delivery preserves a concurrent title edit and advances its optimistic revision', async () => {
  const todo = await scheduled(), editor = await pool.connect();
  let delivery: ReturnType<typeof bus.receive> | undefined;
  try {
    await editor.query('BEGIN');
    await editor.query("UPDATE hub_todos SET title='Editing' WHERE id=$1", [todo.id]);
    const started = once(reminderStatements, 'started', { signal: AbortSignal.timeout(3000) });
    delivery = bus.receive(todo.data);
    await started;
    const changed = await editor.query("UPDATE hub_todos SET title='Latest title',updated_at=clock_timestamp() WHERE id=$1 RETURNING updated_at::text", [todo.id]);
    await editor.query('COMMIT');
    await delivery;
    const current = (await pool.query('SELECT title,reminder_fired_at,updated_at>$2::timestamptz AS advanced FROM hub_todos WHERE id=$1', [todo.id, changed.rows[0].updated_at])).rows[0];
    assert.equal(current.title, 'Latest title');
    assert.ok(current.reminder_fired_at);
    assert.equal(current.advanced, true, 'reminder firing must not move the optimistic revision backward');
  } finally { await editor.query('ROLLBACK'); editor.release(); await delivery; }
});

test('revoked workspace membership and revoked source channel access prevent delivery', async () => {
  const removed = await scheduled();
  // Primary owners cannot be deactivated; exercise revocation with a regular member.
  await pool.query('UPDATE hub_todos SET user_id=$2 WHERE id=$1', [removed.id, removed.collaborator_id]);
  await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2', [removed.workspace_id, removed.collaborator_id]);
  await bus.receive(removed.data);
  assert.equal(await fired(removed.id), null);
  const source = await scheduled();
  const message = await new ChatStore(pool).send(source.owner_id, source.channel_id, { text: 'Follow up on this', client_message_id: randomUUID() });
  await pool.query('UPDATE hub_todos SET channel_id=$2,message_id=$3 WHERE id=$1', [source.id, source.channel_id, message.id]);
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2', [source.channel_id, source.owner_id]);
  await bus.receive(source.data);
  assert.equal(await fired(source.id), null);
});

test('failed durable notification write rolls back firing and succeeds on redelivery', async () => {
  const todo = await scheduled();
  await pool.query(`CREATE FUNCTION reject_todo_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test delivery unavailable'; END $$`);
  await pool.query('CREATE TRIGGER reject_todo_delivery BEFORE INSERT ON chat_delivery_outbox FOR EACH ROW EXECUTE FUNCTION reject_todo_delivery()');
  try {
    await assert.rejects(bus.receive(todo.data), /test delivery unavailable/);
    assert.equal(await fired(todo.id), null);
  } finally { await pool.query('DROP TRIGGER reject_todo_delivery ON chat_delivery_outbox'); }
  await bus.receive(todo.data);
  assert.ok(await fired(todo.id));
});
