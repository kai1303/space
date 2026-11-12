import { observeOutbox } from '../fixtures/observe-outbox.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { EventBus, type EventDelivery } from '@space/events';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
const schema = `scheduled_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });

// Captures the API's durable consumers so the test can deliver deadline events directly.
class ProbeBus extends EventBus {
  readonly handlers = new Map<string, Parameters<EventBus['subscribe']>[2]>();
  override async start() {}
  override async subscribeTransient() { return () => {}; }
  override async subscribe(filter: string, _options: Parameters<EventBus['subscribe']>[1], handler: Parameters<EventBus['subscribe']>[2]) {
    this.handlers.set(filter, handler); return async () => { this.handlers.delete(filter); };
  }
  override async close() {}
  async due(data: Record<string, unknown>, availableAt?: string) {
    let acknowledgments = 0, retry: number | undefined;
    const delivery: EventDelivery = {
      event: { id: randomUUID(), schema, kind: 'scheduled.message_due', aggregate_id: String(data.scheduled_id), data, ...(availableAt ? { available_at: availableAt } : {}) },
      ack: () => { acknowledgments++; }, retry: (delay = 1000) => { retry = delay; },
    };
    const handler = this.handlers.get('scheduled.message_due.*');
    assert.ok(handler, 'the API must consume scheduled message deadlines');
    await handler(delivery);
    return { acknowledgments, retry };
  }
}
const bus = new ProbeBus('nats://unused', schema);
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, realtime: { events: bus } });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); await observeOutbox(pool); await app.ready(); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
async function seed() { return bootstrap(pool); }
function call(token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
}
async function schedule(owner: Awaited<ReturnType<typeof seed>>, extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  const response = await call(owner.owner_token, 'POST', `/v1/channels/${owner.channel_id}/scheduled-messages`, { id, text: 'Ship notes go out at nine', send_at: inMinutes(5), ...extra });
  assert.equal(response.statusCode, 201, response.body);
  return { id, body: response.json() };
}
// Moves a schedule's time into the past directly, as if the wall clock had reached it.
async function makeDue(id: string) {
  await pool.query(`UPDATE scheduled_messages SET send_at=now()-interval '1 second' WHERE id=$1`, [id]);
  return (await pool.query('SELECT version FROM scheduled_messages WHERE id=$1', [id])).rows[0].version as number;
}
const messagesFrom = async (id: string) => (await pool.query('SELECT id,text,attachments FROM messages WHERE client_message_id=$1', [id])).rows;
const statusOf = async (id: string) => (await pool.query('SELECT status,error,message_id FROM scheduled_messages WHERE id=$1', [id])).rows[0];

test('scheduling stores the message, emits its deadline and lists it for the author only', async () => {
  const owner = await seed();
  const { id, body } = await schedule(owner);
  assert.equal(body.status, 'pending');
  assert.equal(body.channel_name, 'general');
  const event = (await pool.query(`SELECT payload,available_at FROM observed_outbox WHERE kind='scheduled.message_due' AND aggregate_id=$1`, [id])).rows;
  assert.equal(event.length, 1);
  assert.equal(event[0].payload.version, 1);
  assert.equal(event[0].available_at.toISOString(), body.send_at);
  const mine = (await call(owner.owner_token, 'GET', `/v1/workspaces/${owner.workspace_id}/scheduled-messages`)).json();
  assert.deepEqual(mine.items.map((item: { id: string }) => item.id), [id]);
  const theirs = (await call(owner.collaborator_token, 'GET', `/v1/workspaces/${owner.workspace_id}/scheduled-messages`)).json();
  assert.deepEqual(theirs.items, []);
  assert.equal((await messagesFrom(id)).length, 0, 'nothing is posted before the deadline');
});

test('a repeated request returns the same schedule; a different one under the same id conflicts', async () => {
  const owner = await seed();
  const id = randomUUID(), send_at = inMinutes(10);
  const first = await call(owner.owner_token, 'POST', `/v1/channels/${owner.channel_id}/scheduled-messages`, { id, text: 'Hello', send_at });
  const again = await call(owner.owner_token, 'POST', `/v1/channels/${owner.channel_id}/scheduled-messages`, { id, text: 'Hello', send_at });
  assert.equal(first.statusCode, 201); assert.equal(again.statusCode, 201);
  assert.equal(again.json().id, id);
  const changed = await call(owner.owner_token, 'POST', `/v1/channels/${owner.channel_id}/scheduled-messages`, { id, text: 'Different', send_at });
  assert.equal(changed.statusCode, 409);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM scheduled_messages WHERE id=$1', [id])).rows[0].n, 1);
});

test('send times must be at least a minute and at most 120 days ahead', async () => {
  const owner = await seed();
  for (const send_at of [inMinutes(0), inMinutes(-5), inMinutes(121 * 24 * 60), 'tomorrow']) {
    const response = await call(owner.owner_token, 'POST', `/v1/channels/${owner.channel_id}/scheduled-messages`, { id: randomUUID(), text: 'x', send_at });
    assert.equal(response.statusCode, 400, send_at);
  }
});

test('a due event posts once, even when delivered twice or in parallel', async () => {
  const owner = await seed();
  const { id } = await schedule(owner);
  const version = await makeDue(id);
  const results = await Promise.all([bus.due({ scheduled_id: id, version }), bus.due({ scheduled_id: id, version })]);
  assert.deepEqual(results.map(result => result.acknowledgments), [1, 1]);
  const again = await bus.due({ scheduled_id: id, version });
  assert.equal(again.acknowledgments, 1);
  const posted = await messagesFrom(id);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].text, 'Ship notes go out at nine');
  assert.deepEqual(await statusOf(id), { status: 'sent', error: null, message_id: posted[0].id });
});

test('an early event waits for the remaining time instead of posting', async () => {
  const owner = await seed();
  const { id } = await schedule(owner);
  const result = await bus.due({ scheduled_id: id, version: 1 });
  assert.equal(result.acknowledgments, 0);
  assert.ok(result.retry! > 60_000 && result.retry! <= 5 * 60_000 + 1000, String(result.retry));
  assert.equal((await messagesFrom(id)).length, 0);
});

test('rescheduling bumps the version so the old deadline never posts', async () => {
  const owner = await seed();
  const { id } = await schedule(owner);
  const moved = await call(owner.owner_token, 'PATCH', `/v1/scheduled-messages/${id}`, { send_at: inMinutes(30) });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal((await pool.query('SELECT version FROM scheduled_messages WHERE id=$1', [id])).rows[0].version, 2);
  const deadlines = await pool.query(`SELECT (payload->>'version')::int AS version FROM observed_outbox WHERE kind='scheduled.message_due' AND aggregate_id=$1 ORDER BY version`, [id]);
  assert.deepEqual(deadlines.rows.map(row => row.version), [1, 2]);
  await pool.query(`UPDATE scheduled_messages SET send_at=now()-interval '1 second' WHERE id=$1`, [id]);
  const stale = await bus.due({ scheduled_id: id, version: 1 });
  assert.equal(stale.acknowledgments, 1);
  assert.equal((await messagesFrom(id)).length, 0, 'the old generation is a no-op');
});

test('cancelled schedules never post; sent ones cannot be cancelled', async () => {
  const owner = await seed();
  const { id } = await schedule(owner);
  const cancelled = await call(owner.owner_token, 'DELETE', `/v1/scheduled-messages/${id}`);
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.json().status, 'cancelled');
  await pool.query(`UPDATE scheduled_messages SET send_at=now()-interval '1 second' WHERE id=$1`, [id]);
  assert.equal((await bus.due({ scheduled_id: id, version: 2 })).acknowledgments, 1);
  assert.equal((await messagesFrom(id)).length, 0);
  const other = await schedule(owner);
  await bus.due({ scheduled_id: other.id, version: await makeDue(other.id) });
  const late = await call(owner.owner_token, 'DELETE', `/v1/scheduled-messages/${other.id}`);
  assert.equal(late.statusCode, 409);
  assert.equal(late.json().error, 'scheduled_message_sent');
});

test('send now posts through the same deadline path', async () => {
  const owner = await seed();
  const { id } = await schedule(owner);
  const now = await call(owner.owner_token, 'POST', `/v1/scheduled-messages/${id}/send`, {});
  assert.equal(now.statusCode, 200, now.body);
  const row = (await pool.query('SELECT version FROM scheduled_messages WHERE id=$1', [id])).rows[0];
  assert.equal((await bus.due({ scheduled_id: id, version: row.version })).acknowledgments, 1);
  assert.equal((await messagesFrom(id)).length, 1);
});

test('only the author can change a schedule', async () => {
  const owner = await seed();
  const { id } = await schedule(owner);
  for (const [method, url, payload] of [['PATCH', `/v1/scheduled-messages/${id}`, { send_at: inMinutes(20) }], ['DELETE', `/v1/scheduled-messages/${id}`], ['POST', `/v1/scheduled-messages/${id}/send`, {}]] as const) {
    assert.equal((await call(owner.collaborator_token, method, url, payload)).statusCode, 404);
  }
  assert.equal((await statusOf(id)).status, 'pending');
});

test('an author who lost channel access gets a failed schedule, not a post', async () => {
  const owner = await seed();
  const { id } = await schedule(owner);
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2', [owner.channel_id, owner.owner_id]);
  const result = await bus.due({ scheduled_id: id, version: await makeDue(id) });
  assert.equal(result.acknowledgments, 1);
  assert.equal((await messagesFrom(id)).length, 0);
  const row = await statusOf(id);
  assert.equal(row.status, 'failed');
  assert.equal(row.error, 'not_found');
});

async function upload(owner: Awaited<ReturnType<typeof seed>>) {
  const id = randomUUID();
  await pool.query(`INSERT INTO assets(id,workspace_id,channel_id,uploader_id,name,size,type,staging_key,object_key,status)
    VALUES($1,$2,$3,$4,'plan.pdf',1200,'application/pdf',$5,$6,'ready')`, [id, owner.workspace_id, owner.channel_id, owner.owner_id, `staging/${id}`, `objects/${id}`]);
  return id;
}
const expiry = async (id: string) => (await pool.query('SELECT expires_at,message_id FROM assets WHERE id=$1', [id])).rows[0];

test('attachments outlive a far send time, attach when sent, and return to a one-day life when cancelled', async () => {
  const owner = await seed();
  const file = await upload(owner);
  const later = new Date(Date.now() + 10 * 24 * 60 * 60_000).toISOString();
  const { id, body } = await schedule(owner, { text: '', asset_ids: [file], send_at: later });
  assert.deepEqual(body.attachments.map((item: { id: string }) => item.id), [file]);
  assert.ok((await expiry(file)).expires_at.getTime() > Date.parse(later), 'the upload must not expire before it is sent');
  const reuse = await call(owner.owner_token, 'POST', `/v1/channels/${owner.channel_id}/scheduled-messages`, { id: randomUUID(), text: 'again', asset_ids: [file], send_at: inMinutes(5) });
  assert.equal(reuse.statusCode, 409, 'one upload belongs to one schedule');
  await bus.due({ scheduled_id: id, version: await makeDue(id) });
  const [posted] = await messagesFrom(id);
  assert.deepEqual(posted.attachments.map((item: { id: string }) => item.id), [file]);
  assert.equal((await expiry(file)).message_id, posted.id);

  const second = await upload(owner);
  const pending = await schedule(owner, { asset_ids: [second], send_at: later });
  await call(owner.owner_token, 'DELETE', `/v1/scheduled-messages/${pending.id}`);
  const left = (await expiry(second)).expires_at.getTime() - Date.now();
  assert.ok(left <= 24 * 60 * 60_000 + 5_000, 'a cancelled schedule releases the upload to normal cleanup');
});

test('the per-author pending limit bounds stored schedules', async () => {
  const owner = await seed();
  await pool.query(`INSERT INTO scheduled_messages(id,workspace_id,channel_id,user_id,request_hash,text,send_at)
    SELECT gen_random_uuid(),$1,$2,$3,'seed','x',now()+interval '1 day' FROM generate_series(1,100)`, [owner.workspace_id, owner.channel_id, owner.owner_id]);
  const response = await call(owner.owner_token, 'POST', `/v1/channels/${owner.channel_id}/scheduled-messages`, { id: randomUUID(), text: 'one more', send_at: inMinutes(5) });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'too_many_scheduled_messages');
});
