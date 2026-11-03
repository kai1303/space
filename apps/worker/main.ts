import { setTimeout } from 'node:timers/promises';
import { createPool } from '@space/postgres/database';
import { PostgresStore } from '@space/postgres/store';
import { MockConnector } from '@space/mock/connector';
import { deliverOne } from '@space/core/worker';
import { RedisChatSignals } from '@space/redis';
const signals = new RedisChatSignals(process.env.REDIS_URL);
await signals.connect();
const pool = createPool(process.env.DATABASE_URL);
const store = new PostgresStore(pool, () => signals.publish());
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopping = true; });
try {
  while (!stopping) {
    try { if (!await deliverOne(store, [new MockConnector()])) await setTimeout(250); }
    catch { console.error('worker_delivery_failed'); await setTimeout(1000); }
  }
} finally { signals.close(); await pool.end(); }
