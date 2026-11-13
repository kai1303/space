// End to end: message → trigger → event_outbox → CDC bridge → NATS JetStream → real worker process → model → graph.
// Needs TEST_DATABASE_URL (wal_level=logical, REPLICATION), TEST_NATS_URL (JetStream) and MEMORY_GRAPH_URL
// (knowledge database writer with memory-graph.sql and memory-extract.sql). The model and embeddings are a fake
// Ollama server, so the test checks the wiring, not model quality.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';

const ready = Boolean(process.env.TEST_DATABASE_URL && process.env.MEMORY_GRAPH_URL);
const schema = `extract_nats_${randomBytes(6).toString('hex')}`;
const natsUrl = process.env.TEST_NATS_URL ?? 'nats://127.0.0.1:54222';
const admin = ready ? new Pool({ connectionString: process.env.TEST_DATABASE_URL }) : undefined;
const url = ready ? new URL(process.env.TEST_DATABASE_URL!) : undefined;
url?.searchParams.set('options', `-c search_path=${schema}`);
const pool = ready ? new Pool({ connectionString: url!.href }) : undefined;
const graph = ready ? new Pool({ connectionString: process.env.MEMORY_GRAPH_URL }) : undefined;
const app = ready ? createApi(new PostgresStore(pool!), { allowDevelopmentTokens: true }) : undefined;
let bridge: { close(): Promise<void> } | undefined, worker: ChildProcess | undefined, ollama: Server | undefined;
const calls: { chat: number; embed: number } = { chat: 0, embed: 0 };
let ollamaUrl = '';

before(async () => {
  if (!ready) return;
  await admin!.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool!);
  ollama = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const input = JSON.parse(body || '{}');
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/embed') { calls.embed++; res.end(JSON.stringify({ embeddings: input.input.map(() => Array.from({ length: 384 }, () => 0.3)) })); return; }
      if (req.url === '/api/chat') {
        calls.chat++;
        const data = JSON.parse(input.messages[1].content) as { messages: { id: string; text: string }[] };
        const latest = data.messages.at(-1)!;
        const fact = latest.text.startsWith('Refund') ? 'Refund the second charge.' : 'Charges are deduped on the idempotency key.';
        res.end(JSON.stringify({ message: { content: JSON.stringify({ topics: [{ name: 'checkout retries', message_ids: [latest.id] }],
          facts: [{ text: fact, kind: 'decision', topic: 'checkout retries', message_ids: [latest.id] }] }) } }));
        return;
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise<void>(resolve => ollama!.listen(0, '127.0.0.1', resolve));
  ollamaUrl = `http://127.0.0.1:${(ollama.address() as { port: number }).port}`;
  const { EventBridge } = await import('@space/event-service/bridge');
  const started = new EventBridge({ databaseUrl: process.env.TEST_DATABASE_URL!, natsUrl, schema });
  await started.start();
  bridge = started;
});
after(async () => {
  if (!ready) return;
  if (worker && worker.exitCode === null) { const ended = once(worker, 'exit'); worker.kill('SIGTERM'); await ended; }
  await bridge?.close();
  await new Promise<void>(resolve => ollama ? ollama.close(() => resolve()) : resolve());
  await app!.close(); await pool!.end(); await graph!.end();
  await admin!.query(`DROP SCHEMA ${schema} CASCADE`); await admin!.end();
});

async function until(fn: () => Promise<boolean>, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await fn()) return; await delay(200); }
  throw new Error('timed out');
}
const post = async (token: string, channel: string, text: string, thread?: string) => {
  const r = await app!.inject({ method: 'POST', url: `/v1/channels/${channel}/messages`, headers: { authorization: `Bearer ${token}` }, payload: { client_message_id: randomUUID(), text, ...(thread ? { thread_id: thread } : {}) } });
  assert.equal(r.statusCode, 201, r.body); return r.json();
};

test('a message reaches the real worker through CDC and NATS, and the worker writes topics and facts', { skip: !ready, timeout: 90000 }, async () => {
  const a = await bootstrap(pool!);
  await pool!.query('UPDATE channels SET memory_enabled=true WHERE id=$1', [a.channel_id]);
  const early = await post(a.owner_token, a.channel_id, 'Before any worker has a model');
  assert.equal((await pool!.query('SELECT count(*)::int AS n FROM memory_extract_threads WHERE thread_id=$1', [early.thread_id])).rows[0].n, 0, 'no model yet: nothing queued');
  const vector = JSON.stringify(Array.from({ length: 384 }, () => 0.1));
  let root: any, fix: any;
  try {
    worker = spawn(process.execPath, [fileURLToPath(new URL('../../apps/worker/dist/main.js', import.meta.url))], {
      env: { ...process.env, DATABASE_URL: url!.href, NATS_URL: natsUrl, OLLAMA_URL: ollamaUrl,
        MEMORY_EXTRACT_MODEL: 'fake', MEMORY_GRAPH_WRITE_URL: process.env.MEMORY_GRAPH_URL, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let log = '';
    worker.stdout!.on('data', chunk => { log += chunk; });
    await until(async () => log.includes('Worker ready'), 20000);
    assert.equal((await pool!.query('SELECT enabled FROM memory_extract_config')).rows[0].enabled, true, 'a worker with a model turns extraction on');

    root = await post(a.owner_token, a.channel_id, 'Customers are charged twice after checkout retries');
    fix = await post(a.owner_token, a.channel_id, 'We dedupe on the idempotency key', root.thread_id);
    // The graph reader is not part of this test, so the store gets the thread and its messages directly.
    await graph!.query('INSERT INTO kb.m_channels(id,workspace_id,name,is_private,memory_enabled,version) VALUES($1,$2,$3,false,true,1)', [a.channel_id, a.workspace_id, 'general']);
    await graph!.query('INSERT INTO kb.m_threads(id,workspace_id,channel_id,version) VALUES($1,$2,$3,1)', [root.thread_id, a.workspace_id, a.channel_id]);
    for (const m of [root, fix]) await graph!.query(`INSERT INTO kb.m_messages(id,workspace_id,thread_id,sequence,revision,created_at,memory,knowledge,body,embedding,version)
      VALUES($1,$2,$3,$4,1,now(),true,false,$5,$6,1)`, [m.id, a.workspace_id, root.thread_id, m.sequence, m.text, vector]);

    // The 60 s debounce is long for a test. Moving the deadline re-emits the event through the outbox, like a new message does.
    await pool!.query("UPDATE memory_extract_threads SET available_at = now() + interval '2 seconds' WHERE thread_id=$1", [root.thread_id]);
    const facts = async () => (await graph!.query('SELECT f.text, t.name FROM kb.m_facts f LEFT JOIN kb.m_topics t ON t.id=f.topic_id WHERE f.thread_id=$1', [root.thread_id])).rows;
    await until(async () => (await facts()).length === 1, 30000);
    assert.deepEqual(await facts(), [{ text: 'Charges are deduped on the idempotency key.', name: 'checkout retries' }]);
    assert.equal(Number((await graph!.query('SELECT count(*) FROM kb.m_fact_evidence e JOIN kb.m_facts f ON f.id=e.fact_id WHERE f.thread_id=$1 AND e.message_id=$2', [root.thread_id, fix.id])).rows[0].count), 1);
    const state = (await pool!.query('SELECT done_through::text, isfinite(available_at) AS scheduled FROM memory_extract_threads WHERE thread_id=$1', [root.thread_id])).rows[0];
    assert.equal(state.done_through, String(fix.sequence), 'progress moved to the last message read');
    assert.equal(state.scheduled, false);
    assert.equal(calls.chat, 1, 'one model call for the whole thread');
    assert.equal((await pool!.query("SELECT count(*)::int AS n FROM event_outbox WHERE kind='memory.extract.ready'")).rows[0].n, 0, 'the bridge drained the outbox');

    // A new reply schedules the next run, which the worker also picks up from the broker.
    const more = await post(a.owner_token, a.channel_id, 'Refund the second charge too', root.thread_id);
    await graph!.query(`INSERT INTO kb.m_messages(id,workspace_id,thread_id,sequence,revision,created_at,memory,knowledge,body,embedding,version)
      VALUES($1,$2,$3,$4,1,now(),true,false,$5,$6,1)`, [more.id, a.workspace_id, root.thread_id, more.sequence, more.text, vector]);
    await pool!.query("UPDATE memory_extract_threads SET available_at = now() + interval '1 second', last_run_at = now() - interval '10 minutes' WHERE thread_id=$1", [root.thread_id]);
    await until(async () => calls.chat === 2, 30000);
    await until(async () => (await graph!.query('SELECT 1 FROM kb.m_fact_evidence e JOIN kb.m_facts f ON f.id=e.fact_id WHERE f.thread_id=$1 AND e.message_id=$2', [root.thread_id, more.id])).rowCount === 1, 15000);
    assert.deepEqual((await facts()).map(row => row.text).sort(), ['Charges are deduped on the idempotency key.', 'Refund the second charge.']);

    // Graph resync removes these derived rows on archive. A restore must run extraction again even
    // if nobody posts a new message, including when both transitions reach the broker together.
    await pool!.query('UPDATE channels SET archived_at=now() WHERE id=$1', [a.channel_id]);
    await graph!.query('DELETE FROM kb.m_facts WHERE thread_id=$1', [root.thread_id]);
    await graph!.query('DELETE FROM kb.m_thread_topics WHERE thread_id=$1', [root.thread_id]);
    await pool!.query('UPDATE channels SET archived_at=NULL WHERE id=$1', [a.channel_id]);
    await until(async () => (await pool!.query('SELECT done_through=0 AND isfinite(available_at) AS ready FROM memory_extract_threads WHERE thread_id=$1', [root.thread_id])).rows[0].ready);
    await pool!.query("UPDATE memory_extract_threads SET available_at=now()+interval '1 second' WHERE thread_id=$1", [root.thread_id]);
    await until(async () => (await facts()).length === 1);
    assert.deepEqual((await facts())[0], { text: 'Refund the second charge.', name: 'checkout retries' });
  } finally {
    await graph!.query('DELETE FROM kb.m_channels WHERE id=$1', [a.channel_id]);
  }
});
