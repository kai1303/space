import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { ChatStore } from '@space/postgres/chat';
import { migrate } from '@space/postgres/migrate';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const schema = `chat_outbox_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
const pending = async () => (await pool.query('SELECT * FROM chat_delivery_outbox ORDER BY id')).rows;

test('enqueues message delivery atomically and rolls it back with the transaction', async () => {
  assert.ok((await pool.query("SELECT to_regclass('chat_delivery_outbox') AS name")).rows[0].name, 'migration must create a durable chat outbox');
  const a = await bootstrap(pool);
  await pool.query('DELETE FROM chat_delivery_outbox');
  const chat = new ChatStore(pool), input = { client_message_id: randomUUID(), text: 'Stored before publisher starts' };
  await chat.send(a.owner_id, a.channel_id, input);
  assert.deepEqual((await pending()).map(row => row.channel_id), [a.channel_id]);
  await chat.send(a.owner_id, a.channel_id, input);
  assert.equal((await pending()).length, 1, 'idempotent send must not enqueue duplicate delivery');
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query("SELECT append_chat_event($1,$2,'task.event','{}')", [a.channel_id,a.thread_id]);
    assert.equal((await tx.query('SELECT count(*) FROM chat_delivery_outbox')).rows[0].count,'2');
    assert.equal((await pending()).length,1,'uncommitted work must not be published');
    await tx.query('ROLLBACK');
  } finally { tx.release(); }
  assert.equal((await pending()).length,1);
});

test('failed publishing retains work; a restarted publisher retries and drains it', async () => {
  const { relayChatOutbox } = await import('@space/postgres/chat-outbox');
  await pool.query('DELETE FROM chat_delivery_outbox');
  const a = await bootstrap(pool);
  await pool.query('DELETE FROM chat_delivery_outbox');
  await new ChatStore(pool).send(a.owner_id,a.channel_id,{client_message_id:randomUUID(),text:'Retry publication'});
  await assert.rejects(relayChatOutbox(pool, async () => { throw new Error('Redis unavailable'); }), /Redis unavailable/);
  assert.equal((await pending()).length,1);
  const calls: (string | null)[][] = [];
  assert.equal(await relayChatOutbox(pool, async channels => { calls.push(channels); }),1);
  assert.deepEqual(calls,[[a.channel_id]]);
  assert.equal((await pending()).length,0);
});

test('concurrent publishers skip claimed rows and new messages commit while publication waits', async () => {
  const { relayChatOutbox } = await import('@space/postgres/chat-outbox');
  const a = await bootstrap(pool), chat = new ChatStore(pool);
  await pool.query('DELETE FROM chat_delivery_outbox');
  await chat.send(a.owner_id,a.channel_id,{client_message_id:randomUUID(),text:'First'});
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const first = relayChatOutbox(pool, async () => { entered(); await blocked; });
  try {
    await started;
    assert.equal(await relayChatOutbox(pool,async () => assert.fail('must not claim a locked row')),0);
    await chat.send(a.owner_id,a.channel_id,{client_message_id:randomUUID(),text:'Second'});
    assert.equal(await relayChatOutbox(pool,async () => {}),1);
  } finally { release(); await first; }
  assert.equal((await pending()).length,0);
});

test('membership and credential changes enqueue invalidations without an HTTP notification hook', async () => {
  const a = await bootstrap(pool);
  await pool.query('DELETE FROM chat_delivery_outbox');
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[a.channel_id,a.collaborator_id]);
  assert.deepEqual((await pending()).map(row=>row.channel_id),[a.channel_id]);
  await pool.query('DELETE FROM human_credentials WHERE user_id=$1',[a.collaborator_id]);
  assert.ok((await pending()).some(row=>row.channel_id===null));
});

test('publication followed by a crash is retried at least once without dropping the pending row', async () => {
  const { relayChatOutbox } = await import('@space/postgres/chat-outbox');
  const a = await bootstrap(pool);
  await pool.query('DELETE FROM chat_delivery_outbox');
  await new ChatStore(pool).send(a.owner_id,a.channel_id,{client_message_id:randomUUID(),text:'Crash after publish'});
  const deliveries: (string | null)[][] = [];
  await assert.rejects(relayChatOutbox(pool,async channels => { deliveries.push(channels); throw new Error('process interrupted before deletion'); }));
  await relayChatOutbox(pool,async channels => { deliveries.push(channels); });
  assert.deepEqual(deliveries,[[a.channel_id],[a.channel_id]]);
  assert.equal((await pending()).length,0);
});

test('socket sends commit during adapter unavailability and a new API process drains their pending delivery', async () => {
  const { RedisSocketAdapter } = await import('@space/redis');
  const { createApi } = await import('@space/server/api');
  const { PostgresStore } = await import('@space/postgres/store');
  const { io } = await import('socket.io-client');
  class UnavailableAdapter extends RedisSocketAdapter { override get isReady() { return false; } }
  const unavailable = new UnavailableAdapter(process.env.TEST_REDIS_URL, schema);
  await unavailable.connect();
  const server = createApi(new PostgresStore(pool),{allowDevelopmentTokens:true,realtime:{adapter:unavailable,reconcileMs:60_000,outboxMs:50}});
  const base = await server.listen({host:'127.0.0.1',port:0});
  const a = await bootstrap(pool);
  await pool.query('DELETE FROM chat_delivery_outbox');
  const client = io(base,{transports:['websocket'],auth:{token:a.owner_token},reconnection:false});
  try {
    await new Promise<void>((resolve,reject)=>{client.once('connect',resolve);client.once('connect_error',reject);});
    const ack = await client.timeout(2000).emitWithAck('message.send',{channel_id:a.channel_id,client_message_id:randomUUID(),text:'Committed while Redis is unavailable'});
    assert.ok(ack.data.id);
    await new Promise(resolve=>setTimeout(resolve,150));
    assert.equal((await pending()).length,1);
  } finally { client.disconnect(); await server.close(); }
  const replacementAdapter = new RedisSocketAdapter(process.env.TEST_REDIS_URL,schema);
  await replacementAdapter.connect();
  const replacement = createApi(new PostgresStore(pool),{allowDevelopmentTokens:true,realtime:{adapter:replacementAdapter,reconcileMs:60_000,outboxMs:50}});
  try {
    await replacement.listen({host:'127.0.0.1',port:0});
    const deadline = Date.now()+3000;
    while ((await pending()).length) {
      assert.ok(Date.now()<deadline,'replacement API must drain previously committed work');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  } finally { await replacement.close(); }
});
