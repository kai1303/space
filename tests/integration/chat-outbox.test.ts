import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { ChatStore } from '@space/postgres/chat';
import { migrate } from '@space/postgres/migrate';
import { EventBus, type DomainEvent } from '@space/events';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const schema = `chat_outbox_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
const bus = new EventBus(process.env.TEST_NATS_URL ?? 'nats://127.0.0.1:54222',schema);
const events: DomainEvent[] = [];
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); await bus.start();
  await bus.subscribe('chat.changed.*',{durable:`test-${randomUUID()}`},async message => { events.push(message.event); await message.ack(); });
});
after(async () => { await bus.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
async function received(predicate: (event:DomainEvent) => boolean) {
  const until = Date.now()+5000;
  while (!events.some(predicate)) { assert.ok(Date.now()<until,'committed WAL event must reach broker'); await new Promise(resolve=>setTimeout(resolve,10)); }
}

test('chat writes enqueue durable events in the same transaction and idempotent sends enqueue once', async () => {
  const a = await bootstrap(pool), chat = new ChatStore(pool);
  const input = {client_message_id:randomUUID(),text:'Published from committed WAL'};
  const sent = await chat.send(a.owner_id,a.channel_id,input);
  await chat.send(a.owner_id,a.channel_id,input);
  assert.equal((await pool.query('SELECT count(*) FROM messages WHERE id=$1',[sent.id])).rows[0].count,'1');
  await received(event=>event.data.channel_id===a.channel_id);
  // Assert rollback isolation before the global CDC bridge can see the row.
  const tx = await pool.connect();
  let eventId = '';
  try {
    await tx.query('BEGIN');
    await tx.query("SELECT append_chat_event($1,$2,'task.event','{}')",[a.channel_id,a.thread_id]);
    eventId = (await tx.query("SELECT id FROM event_outbox WHERE kind='chat.changed' ORDER BY created_at DESC LIMIT 1")).rows[0].id;
    assert.ok(eventId);
    assert.equal((await pool.query('SELECT 1 FROM event_outbox WHERE id=$1',[eventId])).rowCount,0);
    await tx.query('ROLLBACK');
  } finally { tx.release(); }
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(events.some(event=>event.id===eventId),false,'rolled back events must never be published');
});

test('membership and credential changes publish authorization invalidations through WAL', async () => {
  const a = await bootstrap(pool);
  const marker = events.length;
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[a.channel_id,a.collaborator_id]);
  await received(event=>events.indexOf(event)>=marker && event.data.channel_id===a.channel_id);
  const afterMembership = events.length;
  await pool.query('DELETE FROM human_credentials WHERE user_id=$1',[a.collaborator_id]);
  await received(event=>events.indexOf(event)>=afterMembership && event.data.channel_id===null);
});
