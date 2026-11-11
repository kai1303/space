import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';
import { runMemoryExtract } from '@space/postgres/memory-extract';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
const schema = `memory_extract_${randomBytes(6).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

const post = async (token: string, channel: string, text: string, thread?: string) => {
  const r = await app.inject({ method: 'POST', url: `/v1/channels/${channel}/messages`, headers: { authorization: `Bearer ${token}` }, payload: { client_message_id: randomUUID(), text, ...(thread ? { thread_id: thread } : {}) } });
  assert.equal(r.statusCode, 201, r.body); return r.json();
};
const state = async (thread: string) => (await pool.query('SELECT pending_through::text, done_through::text, attempts, available_at > now() AS waiting, isfinite(available_at) AS scheduled FROM memory_extract_threads WHERE thread_id=$1', [thread])).rows[0];
const events = async (thread: string) => Number((await pool.query("SELECT count(*) FROM event_outbox WHERE kind='memory.extract.ready' AND payload->>'thread_id'=$1", [thread])).rows[0].count);
const due = (thread: string) => pool.query("UPDATE memory_extract_threads SET available_at=now() - interval '1 second' WHERE thread_id=$1", [thread]);

test('messages in memory-on channels queue one debounced extraction per thread; others queue nothing', async () => {
  const a = await bootstrap(pool);
  const off = await post(a.owner_token, a.channel_id, 'Before the switch');
  assert.equal(await state(off.thread_id), undefined, 'memory off: nothing queued');
  await pool.query('UPDATE channels SET memory_enabled=true WHERE id=$1', [a.channel_id]);
  const root = await post(a.owner_token, a.channel_id, 'Customers are charged twice');
  for (let i = 0; i < 5; i++) await post(a.owner_token, a.channel_id, `Reply ${i}`, root.thread_id);
  const s = await state(root.thread_id);
  assert.equal(s.waiting, true, 'debounced into the future');
  assert.ok(await events(root.thread_id) >= 1, 'a broker event carries the deadline');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM memory_extract_threads WHERE thread_id=$1', [root.thread_id])).rows[0].n, 1, 'a burst is one row');
});

// The knowledge database part needs MEMORY_GRAPH_URL (writer, memory-graph.sql and memory-extract.sql applied).
test('a run writes topics and facts with evidence, replays change nothing, failures back off, and the cap holds', { skip: !process.env.MEMORY_GRAPH_URL }, async () => {
  const graph = new Pool({ connectionString: process.env.MEMORY_GRAPH_URL });
  const a = await bootstrap(pool);
  await pool.query('UPDATE channels SET memory_enabled=true WHERE id=$1', [a.channel_id]);
  const root = await post(a.owner_token, a.channel_id, 'Customers are charged twice after checkout retries');
  const fix = await post(a.owner_token, a.channel_id, 'We will dedupe on the idempotency key', root.thread_id);
  const vector = JSON.stringify(Array.from({ length: 384 }, () => 0.1));
  try {
    await graph.query('INSERT INTO kb.m_channels(id,workspace_id,name,is_private,memory_enabled,version) VALUES($1,$2,$3,false,true,1)', [a.channel_id, a.workspace_id, 'general']);
    await graph.query('INSERT INTO kb.m_threads(id,workspace_id,channel_id,version) VALUES($1,$2,$3,1)', [root.thread_id, a.workspace_id, a.channel_id]);
    for (const m of [root, fix]) await graph.query(`INSERT INTO kb.m_messages(id,workspace_id,thread_id,sequence,revision,created_at,memory,knowledge,body,embedding,version)
      VALUES($1,$2,$3,$4,1,now(),true,false,$5,$6,1)`, [m.id, a.workspace_id, root.thread_id, m.sequence, m.text, vector]);
    const embed = async (texts: string[]) => texts.map(() => Array.from({ length: 384 }, () => 0.2));
    let calls = 0;
    const model = async (input: { messages: { id: string }[] }) => {
      calls++;
      return JSON.stringify({ topics: [{ name: 'checkout retries' }], facts: [
        { text: 'Duplicate charges are fixed by deduping on the idempotency key.', kind: 'decision', topic: 'checkout retries', message_ids: [input.messages.at(-1)!.id] },
        { text: 'Invented.', kind: 'fact', message_ids: [randomUUID()] },
      ] });
    };

    assert.equal((await runMemoryExtract(pool, graph, model, embed, root.thread_id)).status, 'later', 'not due yet');
    await due(root.thread_id);
    assert.equal((await runMemoryExtract(pool, graph, model, embed, root.thread_id)).status, 'done');
    const facts = (await graph.query('SELECT f.text, f.kind, t.name FROM kb.m_facts f LEFT JOIN kb.m_topics t ON t.id=f.topic_id WHERE f.thread_id=$1', [root.thread_id])).rows;
    assert.deepEqual(facts, [{ text: 'Duplicate charges are fixed by deduping on the idempotency key.', kind: 'decision', name: 'checkout retries' }], 'invented evidence was dropped');
    assert.equal(Number((await graph.query('SELECT count(*) FROM kb.m_fact_evidence e JOIN kb.m_facts f ON f.id=e.fact_id WHERE f.thread_id=$1 AND e.message_id=$2', [root.thread_id, fix.id])).rows[0].count), 1);
    assert.equal((await state(root.thread_id)).scheduled, false, 'nothing left to read');

    await due(root.thread_id);
    assert.equal((await runMemoryExtract(pool, graph, model, embed, root.thread_id)).status, 'idle', 'a replayed event does no model call');
    assert.equal(calls, 1);

    await graph.query('DELETE FROM kb.m_messages WHERE id=$1', [fix.id]);
    assert.equal(Number((await graph.query('SELECT count(*) FROM kb.m_fact_evidence WHERE message_id=$1', [fix.id])).rows[0].count), 0, 'evidence follows its message');

    const later = await post(a.owner_token, a.channel_id, 'Also refund the second charge', root.thread_id);
    await due(root.thread_id);
    const broken = async () => { throw new Error('model down'); };
    const failed = await runMemoryExtract(pool, graph, broken, embed, root.thread_id);
    assert.equal(failed.status, 'retry');
    assert.ok((failed.delayMs ?? 0) > 0, 'backs off');
    assert.equal((await state(root.thread_id)).attempts, 1);
    for (let i = 0; i < 6; i++) { await due(root.thread_id); await runMemoryExtract(pool, graph, broken, embed, root.thread_id); }
    assert.equal((await state(root.thread_id)).scheduled, false, 'after 6 failures it waits for the next message');
    assert.ok(later.id);

    await pool.query("UPDATE memory_extract_threads SET attempts=0 WHERE thread_id=$1", [root.thread_id]);
    await due(root.thread_id);
    const capped = await runMemoryExtract(pool, graph, model, embed, root.thread_id, 0);
    assert.equal(capped.status, 'capped');
    assert.ok((capped.delayMs ?? 0) > 0, 'moved to the next hour');
  } finally {
    await graph.query('DELETE FROM kb.m_channels WHERE id=$1', [a.channel_id]);
    await graph.end();
  }
});
