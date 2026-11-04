// Run after pnpm --filter @space/events build. Creates and removes only its own Compose project.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { EventBus } from '../../adapters/events/dist/index.js';
const require = createRequire(new URL('../../adapters/events/package.json', import.meta.url));
const { connect, AckPolicy, DeliverPolicy, nanos } = require('nats');
const project = `space-ha-test-${randomUUID().slice(0, 12)}`;
const composeFile = fileURLToPath(new URL('./compose.nats.yaml', import.meta.url));
const compose = (...args) => execFileSync('docker', ['compose', '-p', project, '-f', composeFile, ...args], { encoding: 'utf8', timeout: 120000 });
const services = ['nats-1', 'nats-2', 'nats-3'];
// Bounded failure-test retry; this is not a product background resource scan.
async function eventually(description, operation) {
  const deadline = Date.now() + 45000;
  let last;
  do {
    try { return await operation(); } catch (error) { last = error; }
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}`, { cause: last });
}
let nc, bus;
process.env.NATS_REPLICAS = '3';
const schema = `rehearsal_${randomUUID().replaceAll('-', '')}`;
const event = number => ({ id: `fixture-${number}`, schema, kind: 'chat.message_created', aggregate_id: 'fixture', data: { number } });
try {
  compose('up', '-d', '--wait');
  const urls = Object.fromEntries(services.map(service => [service, `nats://${compose('port', service, '4222').trim()}`]));
  const seeds = services.map(service => urls[service]);
  nc = await connect({ servers: seeds, ignoreClusterUpdates: true, maxReconnectAttempts: -1, timeout: 2000 });
  let manager = await eventually('initial JetStream metadata quorum', () => nc.jetstreamManager({ timeout: 2000 }));
  bus = new EventBus(seeds.join(','), schema);
  await eventually('EventBus R3 stream creation', () => bus.start());
  const stream = `${bus.stream}_CHAT`;
  for (const suffix of ['CHAT', 'WORK']) {
    const info = await manager.streams.info(`${bus.stream}_${suffix}`);
    assert.equal(info.config.num_replicas, 3);
    assert.equal(info.config.storage, 'file');
  }
  let observed = 0;
  const stop = await bus.subscribe('chat.>', {}, async delivery => { observed++; await delivery.ack(); });
  for (let number = 1; number <= 3; number++) await bus.publish(event(number));
  await eventually('actual EventBus subscriber delivery', async () => assert.equal(observed, 3));
  await stop();
  await manager.consumers.add(stream, {
    durable_name: 'rehearsal', ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All, ack_wait: nanos(1000), num_replicas: 3, max_ack_pending: 1,
  });
  let consumer = await nc.jetstream().consumers.get(stream, 'rehearsal');
  const first = await consumer.next({ expires: 3000 });
  assert.equal(first?.info.streamSequence, 1);
  assert.equal(await first.ackAck(), true);
  const second = await consumer.next({ expires: 3000 });
  assert.equal(second?.info.streamSequence, 2); // Leave unacknowledged across the failure.
  const before = await manager.streams.info(stream);
  const leader = before.cluster.leader;
  assert(services.includes(leader));
  compose('kill', '-s', 'SIGKILL', leader);
  await eventually('new stream leader', async () => {
    const info = await manager.streams.info(stream);
    assert(info.cluster.leader && info.cluster.leader !== leader);
    assert.equal(info.state.messages, 3);
  });
  for (let seq = 1; seq <= 3; seq++) {
    const stored = await manager.streams.getMessage(stream, { seq });
    assert.equal(JSON.parse(stored.string()).data.number, seq);
  }
  await eventually('consumer ACK state survived', async () => {
    assert.equal((await manager.consumers.info(stream, 'rehearsal')).ack_floor.stream_seq, 1);
  });
  consumer = await nc.jetstream().consumers.get(stream, 'rehearsal');
  const replay = await eventually('unacknowledged event replay', async () => {
    const message = await consumer.next({ expires: 2000 });
    assert(message); return message;
  });
  assert.equal(replay.info.streamSequence, 2);
  assert.equal(await replay.ackAck(), true);
  const third = await consumer.next({ expires: 3000 });
  assert.equal(third?.info.streamSequence, 3);
  assert.equal(await third.ackAck(), true);
  await bus.close();
  bus = new EventBus([urls[leader], ...services.filter(service => service !== leader).map(service => urls[service])].join(','), schema);
  await eventually('EventBus bootstrap with unavailable seed', () => bus.start());
  await bus.publish(event(4));
  assert.equal((await manager.streams.info(stream)).state.messages, 4);
  console.log('PASS: R3 EventBus publication, stream leader loss, persisted consumer ACK, unacknowledged replay, unavailable seed bootstrap');
  compose('up', '-d', leader);
  await eventually('all stream and consumer replicas current', async () => {
    for (const info of [await manager.streams.info(stream), await manager.consumers.info(stream, 'rehearsal')]) {
      assert.equal(info.cluster.replicas.length, 2);
      assert(info.cluster.replicas.every(replica => replica.current));
    }
  });
  await bus.close(); bus = undefined;
  await nc.close(); nc = undefined;
  compose('kill', '-s', 'SIGKILL');
  compose('up', '-d', '--wait');
  const restartedSeeds = services.map(service => `nats://${compose('port', service, '4222').trim()}`);
  nc = await eventually('connect after restart', () => connect({ servers: restartedSeeds, ignoreClusterUpdates: true, timeout: 2000 }));
  manager = await eventually('JetStream metadata quorum after restart', () => nc.jetstreamManager({ timeout: 2000 }));
  await eventually('full cluster restart restores committed state', async () => {
    assert.equal((await manager.streams.info(stream)).state.messages, 4);
    assert.equal((await manager.consumers.info(stream, 'rehearsal')).ack_floor.stream_seq, 3);
  });
  consumer = await nc.jetstream().consumers.get(stream, 'rehearsal');
  const fourth = await consumer.next({ expires: 3000 });
  assert.equal(fourth?.info.streamSequence, 4);
  assert.equal(await fourth.ackAck(), true);
  console.log('PASS: all-node SIGKILL/restart restores messages and durable ACK cursor from separate volumes');
} finally {
  await bus?.close().catch(() => {});
  await nc?.close().catch(() => {});
  compose('down', '-v', '--remove-orphans');
}
