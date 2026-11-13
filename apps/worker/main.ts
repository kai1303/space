import { agentImageReader, createAssetStorageFromEnv } from '@space/server/storage';
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
import { ollamaExtractor } from '@space/core/memory-extract';
import { runMemoryExtract } from '@space/postgres/memory-extract';
async function embedTexts(texts: string[]): Promise<number[][]> {
  const response = await fetch(`${process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434'}/api/embed`, { method: 'POST', headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(30_000), body: JSON.stringify({ model: 'all-minilm:22m', input: texts }) });
  if (!response.ok) throw new Error('memory_embedding_failed');
  const vectors = (await response.json() as { embeddings?: number[][] }).embeddings;
  if (vectors?.length !== texts.length || !vectors.every(v => v.length === 384 && v.every(Number.isFinite))) throw new Error('memory_embedding_invalid');
  return vectors;
}
const pool = createPool(process.env.DATABASE_URL);
const store = new PostgresStore(pool);
const storage = createAssetStorageFromEnv();
if (storage) store.attachmentImage = agentImageReader(storage);
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
  // Graph RAG memory: topics and facts. Off unless a local model and the knowledge database are configured.
  const extract = ollamaExtractor(process.env);
  if (extract && process.env.MEMORY_GRAPH_WRITE_URL) {
    const graph = createPool(process.env.MEMORY_GRAPH_WRITE_URL);
    const cap = Number(process.env.MEMORY_EXTRACT_HOURLY_CAP ?? 60);
    // Messages start queuing extraction runs only once a worker that can run them exists.
    await pool.query(`WITH activated AS (
      UPDATE memory_extract_config SET enabled=true, restores_pending=false WHERE NOT enabled RETURNING id
    ) UPDATE memory_extract_threads t SET available_at=now()+interval '60 seconds'
      FROM channels c WHERE EXISTS (SELECT 1 FROM activated) AND c.id=t.channel_id AND c.memory_enabled
        AND c.archived_at IS NULL AND t.done_through=0 AND t.pending_through>0 AND t.attempts=0
        AND NOT t.waiting_for_index AND NOT isfinite(t.available_at)`);
    await bus.subscribe('memory.extract.restore.*', {durable:'memory-restores',queue:'memory-restores',maxPending:2}, handle(async event => {
      await pool.query('SELECT restore_memory_extract_page($1,$2,$3)', [event.aggregate_id, event.data.revision, event.data.after_thread ?? null]);
      return undefined;
    }));
    await bus.subscribe('memory.extract.ready.*', {durable:'memory-extractors',queue:'memory-extractors',maxPending:4}, handle(async event => {
      const id=event.data.thread_id;
      if(typeof id!=='string')throw new Error('thread_id required');
      const deadline=typeof event.data.available_at==='string'?event.data.available_at:undefined;
      const outcome=await runMemoryExtract(pool,graph,extract,embedTexts,id,cap,deadline);
      return outcome.delayMs;
    }));
  }
  console.info('Worker ready');
  await stopping;
} finally { await bus.close(); await pool.end(); }
