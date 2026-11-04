import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { io, type Socket } from 'socket.io-client';
import type { ChatEvent } from '@space/contracts';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';

test('24 sockets across two APIs deliver targeted WAL events once and measure local fanout latency', { timeout: 45000 }, async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const schema = `realtime_load_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 16 });
  const stores = [new PostgresStore(pool), new PostgresStore(pool)];
  const apps = stores.map(store => createApi(store, { allowDevelopmentTokens: true, realtime: { maxActorConnections: 16, maxConnections: 32 } }));
  const sockets: Socket[] = [];
  const started = new Map<string, number>();
  const latencies: number[] = [];
  const errors: unknown[] = [];
  let unrelatedAuthentications = 0, measuring = false;

  async function subscriber(address: string, token: string, channel: string) {
    const socket = io(address, { transports: ['websocket'], auth: { token }, reconnection: false, autoConnect: false });
    sockets.push(socket);
    const arrived = new EventEmitter(), counts = new Map<string, number>(), clients = new Set<string>();
    socket.on('chat.error', value => errors.push(value));
    socket.on('chat.events', (frame: { events: ChatEvent[] }, acknowledge: () => void) => {
      for (const event of frame.events) {
        if (event.type !== 'message.created') continue;
        const message = event.payload;
        counts.set(message.id, (counts.get(message.id) ?? 0) + 1);
        if (message.client_message_id) {
          clients.add(message.client_message_id);
          const start = started.get(message.client_message_id);
          if (start !== undefined) latencies.push(performance.now() - start);
          arrived.emit(message.client_message_id);
        }
      }
      acknowledge();
    });
    const connected = new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    socket.connect();
    await connected;
    const subscribed = await socket.timeout(5000).emitWithAck('channel.subscribe', { channel_id: channel, after: '0' });
    assert.ok(subscribed.data, JSON.stringify(subscribed));
    return {
      socket, counts, clients,
      wait: async (client: string) => { if (!clients.has(client)) await once(arrived, client, { signal: AbortSignal.timeout(8000) }); },
    };
  }

  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool);
    const target = await bootstrap(pool), unrelated = await bootstrap(pool);
    for (const store of stores) {
      const authenticate = store.authenticate.bind(store);
      store.authenticate = async token => {
        if (measuring && token === unrelated.owner_token) unrelatedAuthentications++;
        return authenticate(token);
      };
    }
    const addresses = await Promise.all(apps.map(app => app.listen({ host: '127.0.0.1', port: 0 })));
    for (const app of apps) {
      const readiness = await app.inject({ method: 'GET', url: '/readyz' });
      assert.equal(readiness.statusCode, 200, readiness.body);
    }
    const matching = [], others = [];
    for (const address of addresses) {
      for (let i = 0; i < 6; i++) {
        matching.push(await subscriber(address, target.owner_token, target.channel_id));
        others.push(await subscriber(address, unrelated.owner_token, unrelated.channel_id));
      }
    }
    // Delivery barriers cover both workspaces before measuring target-only traffic.
    for (const [seed, clients] of [[target, matching], [unrelated, others]] as const) {
      const client_message_id = randomUUID();
      const result = await clients[0]!.socket.timeout(8000).emitWithAck('message.send', { channel_id: seed.channel_id, client_message_id, text: 'Warmup' });
      assert.ok(result.data?.id, JSON.stringify(result));
      await Promise.all(clients.map(client => client.wait(client_message_id)));
    }
    await delay(300);
    measuring = true;
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const input = { channel_id: target.channel_id, client_message_id: randomUUID(), text: `Measured message ${i}` };
      started.set(input.client_message_id, performance.now());
      const result: { data?: { id: string }; error?: string } = await matching[0]!.socket.timeout(8000).emitWithAck('message.send', input);
      assert.ok(result.data?.id, JSON.stringify(result));
      ids.push(result.data.id);
      await Promise.all(matching.map(client => client.wait(input.client_message_id)));
      const retry: { data?: { id: string }; error?: string } = await matching[6]!.socket.timeout(8000).emitWithAck('message.send', input);
      assert.equal(retry.data?.id, result.data.id, JSON.stringify(retry));
    }
    // Allow queued duplicate or unrelated wakeups to surface after the final ACK.
    await delay(300);
    for (const client of matching) {
      for (const id of ids) assert.equal(client.counts.get(id), 1, `recipient must receive ${id} once`);
      assert.equal(client.counts.size, 11, 'ten measured messages and one warmup');
    }
    for (const client of others) {
      assert.equal(client.counts.size, 1, 'unrelated recipients see only their warmup');
      for (const id of ids) assert.equal(client.counts.has(id), false);
    }
    assert.equal(unrelatedAuthentications, 0);
    assert.equal(latencies.length, 120);
    assert.deepEqual(errors, []);
    assert.ok(sockets.every(socket => socket.connected));
    const sorted = latencies.toSorted((a, b) => a - b);
    const percentile = (p: number) => Number(sorted[Math.ceil(sorted.length * p) - 1]!.toFixed(2));
    console.log(JSON.stringify({ measurement: 'local_realtime_fanout_smoke', api_instances: 2, sockets: sockets.length, matching_recipients: matching.length,
      unrelated_recipients: others.length, messages: ids.length, deliveries: latencies.length, send_to_recipient_ms: { p50: percentile(0.5), p95: percentile(0.95) }, unrelated_authentications: unrelatedAuthentications }));
  } finally {
    measuring = false;
    sockets.forEach(socket => socket.disconnect());
    assert.ok(sockets.every(socket => !socket.connected));
    await Promise.all(apps.map(app => app.close()));
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
