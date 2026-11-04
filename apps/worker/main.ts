import { MemoryStore } from '@space/postgres/memory';
import { createAgentMemoryReader } from '@space/server/memory';
import { NavigatorStore } from '@space/postgres/navigator';
import { createNavigatorProviders } from '@space/core/navigator-providers';
import { createPool } from '@space/postgres/database';
import { PostgresStore } from '@space/postgres/store';
import { MockConnector } from '@space/mock/connector';
import { deliverOne } from '@space/core/worker';
import { AgUiConnector } from '@space/core/ag-ui';
import { EventBus, type EventDelivery } from '@space/events';
const pool = createPool(process.env.DATABASE_URL);
const store = new PostgresStore(pool);
store.memoryReader = createAgentMemoryReader(new MemoryStore(pool));
const connectors = [new MockConnector(), ...(process.env.AG_UI_URL ? [new AgUiConnector({ url: process.env.AG_UI_URL, token: process.env.AG_UI_TOKEN })] : [])];
const navigator = new NavigatorStore(pool, createNavigatorProviders(process.env));
const schema = (await pool.query<{schema:string}>('SELECT current_schema() AS schema')).rows[0]!.schema;
if (process.env.NODE_ENV === 'production' && !process.env.NATS_URL) throw new Error('NATS_URL required');
const bus = new EventBus(process.env.NATS_URL ?? 'nats://127.0.0.1:54222', schema);
const stopping = new Promise<void>(resolve => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => resolve());
});
function handle(work:(event:EventDelivery['event'])=>Promise<number|undefined>) {
  return async (delivery:EventDelivery) => {
    const available = delivery.event.available_at ?? delivery.event.data.available_at;
    const delay = typeof available === 'string' ? Date.parse(available)-Date.now() : 0;
    if (delay > 0) { await delivery.retry(delay); return; }
    // Broker progress preserves a slow handler's delivery without querying a resource queue.
    const heartbeat = setInterval(() => { Promise.resolve(delivery.progress?.()).catch(() => console.error('worker_progress_failed')); }, 10_000);
    try { const remaining=await work(delivery.event); if(remaining && remaining>0)await delivery.retry(remaining);else await delivery.ack(); }
    catch { console.error('worker_operation_failed'); await delivery.retry(1000); }
    finally { clearInterval(heartbeat); }
  };
}
try {
  await bus.start();
  await bus.subscribe('task.remote.ready.*', {durable:'remote-workers',queue:'remote-workers',maxPending:8}, handle(async event => {
    const id=event.data.delivery_id;
    if(typeof id!=='string')throw new Error('delivery_id required');
    if(!await deliverOne(store,connectors,10_000,id)) {
      const due=await pool.query<{delay_ms:number}>("SELECT ceil(extract(epoch FROM (available_at-now()))*1000)::float8 AS delay_ms FROM outbox WHERE id=$1 AND state='pending' AND available_at>now()",[id]);
      return due.rows[0]?.delay_ms;
    }
    return undefined;
  }));
  await bus.subscribe('navigator.ready.*', {durable:'navigator-workers',queue:'navigator-workers',maxPending:8}, handle(async event => {
    const id=event.data.thread_id;
    if(typeof id!=='string')throw new Error('thread_id required');
    if(!await navigator.processOne(id)) {
      const due=await pool.query<{delay_ms:number}>("SELECT ceil(extract(epoch FROM (available_at-now()))*1000)::float8 AS delay_ms FROM navigator_threads WHERE thread_id=$1 AND available_at>now() AND available_at<'infinity'::timestamptz",[id]);
      return due.rows[0]?.delay_ms;
    }
    return undefined;
  }));
  console.info('Worker ready');
  await stopping;
} finally { await bus.close(); await pool.end(); }
