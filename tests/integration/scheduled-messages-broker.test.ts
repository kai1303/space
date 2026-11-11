import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { connect } from 'nats';
import { EventBus, streamName } from '@space/events';
import { EventBridge } from '@space/event-service/bridge';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';

// End to end: committed row → WAL → CDC bridge → NATS schedule → API consumer → posted message.
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
const schema = `sched_broker_${randomBytes(6).toString('hex')}`;
const natsUrl = process.env.TEST_NATS_URL ?? 'nats://127.0.0.1:54222';
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const databaseUrl = new URL(process.env.TEST_DATABASE_URL); databaseUrl.pathname = `/${schema}`;
const pool = new Pool({ connectionString: databaseUrl.toString(), options: `-c search_path=${schema}` });
let bridge: EventBridge | undefined;

before(async () => {
  await admin.query(`CREATE DATABASE ${schema}`);
  await pool.query(`CREATE SCHEMA ${schema}`); await migrate(pool);
  bridge = new EventBridge({ databaseUrl: databaseUrl.toString(), natsUrl, schema });
  await bridge.start();
});
after(async () => {
  const step = (label: string) => { if (process.env.DEBUG_TEARDOWN) console.log('teardown:', label); };
  step('bridge'); await bridge?.close(); step('pool'); await pool.end();
  step('drop'); await admin.query(`DROP DATABASE ${schema} WITH (FORCE)`); await admin.end(); step('nats');
  const connection = await connect({ servers: natsUrl });
  try {
    const manager = await connection.jetstreamManager();
    for (const suffix of ['CHAT', 'WORK', 'SEARCH']) await manager.streams.delete(`${streamName(schema)}_${suffix}`).catch(error => { if (error.code !== '404') throw error; });
  } finally { await connection.close(); }
});

async function waitForPost(id: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = (await pool.query('SELECT id FROM messages WHERE client_message_id=$1', [id])).rows;
    if (rows.length) return rows;
    if (Date.now() > deadline) return rows;
    await delay(250);
  }
}

test('a scheduled message posts at its time through the broker and survives an API restart', { timeout: 30000 }, async () => {
  const owner = await bootstrap(pool);
  // An injected bus belongs to the caller; app.close() leaves it open.
  const events = new EventBus(natsUrl, schema);
  const startApi = async () => {
    const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, realtime: { events } });
    await app.ready(); return app;
  };
  // The API is down when the schedule is written and when it falls due; the broker keeps the obligation.
  const id = randomUUID(), sendAt = new Date(Date.now() + 3000);
  await pool.query(`INSERT INTO scheduled_messages(id,workspace_id,channel_id,user_id,request_hash,text,send_at)
    VALUES($1,$2,$3,$4,'broker','Posted by the broker schedule',$5)`, [id, owner.workspace_id, owner.channel_id, owner.owner_id, sendAt]);
  await delay(4500);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM messages WHERE client_message_id=$1', [id])).rows[0].n, 0, 'no consumer, no post');
  const app = await startApi();
  try {
    const posted = await waitForPost(id, 10000);
    assert.equal(posted.length, 1, 'the retained schedule is delivered once the consumer attaches');
    assert.ok(Date.now() >= sendAt.getTime());
    const row = (await pool.query('SELECT status,message_id FROM scheduled_messages WHERE id=$1', [id])).rows[0];
    assert.deepEqual(row, { status: 'sent', message_id: posted[0].id });

    // A future schedule is held by the broker, not by polling: nothing posts early.
    const later = randomUUID(), at = new Date(Date.now() + 2500);
    await pool.query(`INSERT INTO scheduled_messages(id,workspace_id,channel_id,user_id,request_hash,text,send_at)
      VALUES($1,$2,$3,$4,'broker','Second',$5)`, [later, owner.workspace_id, owner.channel_id, owner.owner_id, at]);
    await delay(1000);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM messages WHERE client_message_id=$1', [later])).rows[0].n, 0, 'not before its time');
    assert.equal((await waitForPost(later, 10000)).length, 1);
  } finally { await app.close(); await events.close(); }
});
