import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createServer, connect, type Socket as NetSocket } from 'node:net';
import { connect as connectNats } from 'nats';
import { streamName } from '@space/events';
import { migrate } from '@space/postgres/migrate';

const rootUrl = process.env.TEST_DATABASE_URL!;
const natsUrl = process.env.TEST_NATS_URL ?? 'nats://127.0.0.1:54222';
const schema = `events_${randomBytes(6).toString('hex')}`;
const isolatedUrl = new URL(rootUrl); isolatedUrl.pathname = `/${schema}`;
const databaseUrl = isolatedUrl.toString();
const admin = new Pool({ connectionString: rootUrl });
const database = new Pool({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
let bus: any, bridge: any;
before(async () => { await admin.query(`CREATE DATABASE ${schema}`); await database.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await bridge?.close(); await bus?.close();
  const connection = await connectNats({ servers: natsUrl });
  try { const manager = await connection.jetstreamManager(); for (const suffix of ['CHAT','WORK']) await manager.streams.delete(`${streamName(schema)}_${suffix}`).catch(error => { if (error.code !== '404') throw error; }); }
  finally { await connection.close(); }
  await pool.end(); await database.end(); await admin.query(`DROP DATABASE ${schema}`); await admin.end(); });
function deadline<T>(work: Promise<T>, ms = 10000): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('event delivery timed out')), ms); })]).finally(() => clearTimeout(timer));
}
test('CDC publishes only committed rows and durable consumers recover broker-owned unacked deliveries', { timeout: 30000 }, async () => {
  const events = await import('../../adapters/events/dist/index.js').catch(() => null);
  const cdc = await import('../../apps/events/dist/bridge.js').catch(() => null);
  assert.ok(events && cdc, 'event bus and CDC bridge must exist');
  bus = new events.EventBus(natsUrl, schema); await bus.start();
  bridge = new cdc.EventBridge({ databaseUrl, natsUrl, schema }); await bridge.start();
  const id = randomUUID();
  let received!: (event: any) => void;
  const first = new Promise<any>(resolve => { received = resolve; });
  const unsubscribe = await bus.subscribe('chat.changed.*', { durable: 'recovery', maxPending: 1 }, async ({ event }: any) => { received(event); });
  const tx = await pool.connect();
  await tx.query('BEGIN');
  await tx.query("INSERT INTO event_outbox(id,kind,aggregate_id,payload) VALUES($1,'chat.changed','one',$2)", [id, { committed: true }]);
  const beforeCommit: any[] = [];
  const stopProbe = await bus.subscribe('chat.changed.*', {}, async ({ event, ack }: any) => { beforeCommit.push(event); ack(); });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(beforeCommit.length, 0);
  await tx.query('COMMIT'); tx.release();
  assert.equal((await deadline(first)).id, id);
  await unsubscribe();
  let redelivered!: (event: any) => void;
  const second = new Promise<any>(resolve => { redelivered = resolve; });
  const stopRecovery = await bus.subscribe('chat.changed.*', { durable: 'recovery', maxPending: 1 }, async ({ event, ack }: any) => { redelivered(event); ack(); });
  assert.equal((await deadline(second)).id, id);
  await stopRecovery(); await stopProbe();
  await bridge.close(); bridge = undefined;
  const outageId = randomUUID();
  await pool.query("INSERT INTO event_outbox(id,kind,aggregate_id,payload) VALUES($1,'task.remote.ready','one','{}')", [outageId]);
  let resolveResumed!: (event: any) => void;
  const resumed = new Promise<any>(resolve => { resolveResumed = resolve; });
  const stopResume = await bus.subscribe('task.remote.ready.one', { durable: 'resume' }, async ({ event, ack }: any) => { ack(); resolveResumed(event); });
  bridge = new cdc.EventBridge({ databaseUrl, natsUrl, schema }); await bridge.start();
  assert.equal((await deadline(resumed)).id, outageId);
  await stopResume();
  const statsConnection = await connectNats({ servers: natsUrl });
  try {
    const manager = await statsConnection.jetstreamManager();
    assert.equal((await manager.streams.info(`${streamName(schema)}_WORK`)).state.messages, 0, 'ACK must release work storage');
  } finally { await statsConnection.close(); }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM event_outbox WHERE id=$1', [outageId])).rows[0].n, 0);
});

test('broker outage retains committed events through reconnect and advances only after durable publication', { timeout: 40000 }, async () => {
  await bridge.close();
  let offline = false;
  const sockets = new Set<NetSocket>();
  const upstream = new URL(natsUrl);
  const proxy = createServer(socket => {
    if (offline) { socket.destroy(); return; }
    const remote = connect(Number(upstream.port), upstream.hostname);
    sockets.add(socket); sockets.add(remote);
    socket.pipe(remote); remote.pipe(socket);
    socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy());
    socket.on('close', () => { sockets.delete(socket); remote.destroy(); });
    remote.on('close', () => { sockets.delete(remote); socket.destroy(); });
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const port = (proxy.address() as { port: number }).port;
  const { EventBridge } = await import('../../apps/events/dist/bridge.js');
  bridge = new EventBridge({ databaseUrl, natsUrl: `nats://127.0.0.1:${port}`, schema });
  try {
    await bridge.start();
    const beforeEventLsn = (await database.query('SELECT pg_current_wal_lsn() AS lsn')).rows[0].lsn;
    offline = true; for (const socket of sockets) socket.destroy();
    const id = randomUUID();
    let resolveReceived!: (event: any) => void;
    const received = new Promise<any>(resolve => { resolveReceived = resolve; });
    await bus.subscribe('task.remote.ready.two', { durable: 'outage' }, async ({ event, ack }: any) => { ack(); resolveReceived(event); });
    await pool.query("INSERT INTO event_outbox(id,kind,aggregate_id,payload) VALUES($1,'task.remote.ready','two','{}')", [id]);
    // Cross the client's former unsafe ten-second standby timer while the broker is unavailable.
    await new Promise(resolve => setTimeout(resolve, 11000));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM event_outbox WHERE id=$1', [id])).rows[0].n, 1);
    assert.equal((await database.query('SELECT confirmed_flush_lsn <= $2::pg_lsn AS safe FROM pg_replication_slots WHERE slot_name=$1', [bridge.slot, beforeEventLsn])).rows[0].safe, true, 'unpublished work must not advance the durable WAL checkpoint past the event');
    offline = false;
    assert.equal((await deadline(received, 15000)).id, id);
  } finally {
    await bridge.close(); bridge = undefined;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});

test('two processes bind one durable push queue and shutdown waits for active handlers', { timeout: 10000 }, async () => {
  const { EventBus } = await import('@space/events');
  const first = new EventBus(natsUrl, schema, 'first');
  const second = new EventBus(natsUrl, schema, 'second');
  await first.start(); await second.start();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let received = 0;
  const handler = async ({ ack }: any) => { received++; entered(); await waiting; ack(); };
  let stopFirst: (() => Promise<void>) | undefined, stopSecond: (() => Promise<void>) | undefined;
  try {
    [stopFirst, stopSecond] = await Promise.all([first,second].map(client => client.subscribe('task.remote.ready.queue', { durable: 'shared-queue', queue: 'shared-queue', maxPending: 1 }, handler)));
    await first.publish({ id: randomUUID(), schema, kind: 'task.remote.ready', aggregate_id: 'queue', data: {} });
    await deadline(started);
    let stopped = false;
    const stopping = Promise.all([stopFirst!(), stopSecond!()]).then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(stopped, false, 'shutdown must await an active handler before releasing delivery');
    release(); await stopping;
    assert.equal(received, 1);
  } finally { release(); await stopFirst?.(); await stopSecond?.(); await first.close(); await second.close(); }
});

test('future retry releases maxPending for immediate work and survives consumer restart', { timeout: 15000 }, async () => {
  const { EventBus } = await import('@space/events');
  const initial = new EventBus(natsUrl, schema);
  await initial.start();
  const futureId = randomUUID(), immediateId = randomUUID();
  let rescheduled!: () => void, immediate!: () => void;
  const deferred = new Promise<void>(resolve => { rescheduled = resolve; });
  const immediateReceived = new Promise<void>(resolve => { immediate = resolve; });
  const stop = await initial.subscribe('asset.deadline.scheduler', { durable: 'scheduler-test', maxPending: 1 }, async delivery => {
    if (delivery.event.id === futureId) { await delivery.retry(3000); rescheduled(); }
    else { await delivery.ack(); immediate(); }
  });
  try {
    await initial.publish({ id: futureId, schema, kind: 'asset.deadline', aggregate_id: 'scheduler', data: {} });
    await deadline(deferred);
    await initial.publish({ id: immediateId, schema, kind: 'asset.deadline', aggregate_id: 'scheduler', data: {} });
    await deadline(immediateReceived, 1000);
  } finally { await stop(); await initial.close(); }
  const resumed = new EventBus(natsUrl, schema);
  await resumed.start();
  let delivered!: (id: string) => void;
  const future = new Promise<string>(resolve => { delivered = resolve; });
  try {
    await resumed.subscribe('asset.deadline.scheduler', { durable: 'scheduler-test', maxPending: 1 }, async delivery => { await delivery.ack(); delivered(delivery.event.id); });
    assert.equal(await deadline(future, 7000), futureId);
  } finally { await resumed.close(); }
});

test('committed transaction publishes with bounded parallelism under broker latency', { timeout: 20000 }, async () => {
  const { EventBridge } = await import('@space/event-service/bridge');
  const { EventBus } = await import('@space/events');
  const receiver = new EventBus(natsUrl, schema); await receiver.start();
  const sockets = new Set<NetSocket>(), timers = new Set<NodeJS.Timeout>();
  const upstream = new URL(natsUrl);
  const proxy = createServer(socket => {
    const remote = connect(Number(upstream.port), upstream.hostname);
    sockets.add(socket); sockets.add(remote);
    socket.pipe(remote);
    remote.on('data', chunk => {
      const timer = setTimeout(() => { timers.delete(timer); if (!socket.destroyed) socket.write(chunk); }, 50);
      timers.add(timer);
    });
    socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy());
    socket.on('close', () => { sockets.delete(socket); remote.destroy(); });
    remote.on('close', () => { sockets.delete(remote); socket.destroy(); });
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const port = (proxy.address() as { port: number }).port;
  bridge = new EventBridge({ databaseUrl, natsUrl: `nats://127.0.0.1:${port}`, schema });
  let stop: (() => Promise<void>) | undefined;
  try {
    await bridge.start();
    const ids = new Set<string>();
    let complete!: () => void;
    const delivered = new Promise<void>(resolve => { complete = resolve; });
    stop = await receiver.subscribe('delivery.deadline.batch', { durable: 'batch-latency', maxPending: 32 }, async ({ event, ack }: any) => { ack(); ids.add(event.id); if (ids.size === 100) complete(); });
    const started = performance.now();
    await pool.query("INSERT INTO event_outbox(kind,aggregate_id,payload) SELECT 'delivery.deadline','batch',jsonb_build_object('n',n) FROM generate_series(1,100) n");
    await deadline(delivered, 2000);
    const elapsed = performance.now() - started;
    console.log(`100-event committed transaction with 50ms injected broker latency: ${Math.round(elapsed)}ms`);
    await bridge.close(); bridge = undefined;
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM event_outbox WHERE aggregate_id='batch'")).rows[0].n, 0);
  } finally {
    await bridge?.close(); bridge = undefined; await stop?.(); await receiver.close();
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});

test('failed CDC startup releases resources and close remains safe to repeat', async () => {
  const { EventBridge } = await import('@space/event-service/bridge');
  const missing = `${schema}_missing`;
  const failed = new EventBridge({ databaseUrl, natsUrl, schema: missing });
  const nc = await connectNats({ servers: natsUrl });
  try {
    await assert.rejects(failed.start(), /does not exist/);
    await failed.close(); await failed.close();
  } finally {
    const manager = await nc.jetstreamManager();
    for (const suffix of ['CHAT','WORK']) await manager.streams.delete(`${streamName(missing)}_${suffix}`);
    await nc.close();
  }
});
