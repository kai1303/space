import { observeOutbox } from '../fixtures/observe-outbox.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';
import { graphMemoryIndex } from '@space/server/memory-index';
import { readChannelMemory, readThreadMemory, useMemoryIndex } from '@space/postgres/layered-memory';
import { runMemoryExtract } from '@space/postgres/memory-extract';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
const schema = `memory_extract_${randomBytes(6).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); await observeOutbox(pool); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

const post = async (token: string, channel: string, text: string, thread?: string) => {
  const r = await app.inject({ method: 'POST', url: `/v1/channels/${channel}/messages`, headers: { authorization: `Bearer ${token}` }, payload: { client_message_id: randomUUID(), text, ...(thread ? { thread_id: thread } : {}) } });
  assert.equal(r.statusCode, 201, r.body); return r.json();
};
const state = async (thread: string) => (await pool.query('SELECT pending_through::text, done_through::text, attempts, available_at > now() AS waiting, isfinite(available_at) AS scheduled FROM memory_extract_threads WHERE thread_id=$1', [thread])).rows[0];
const events = async (thread: string) => Number((await pool.query("SELECT count(*) FROM observed_outbox WHERE kind='memory.extract.ready' AND payload->>'thread_id'=$1", [thread])).rows[0].count);
const due = (thread: string) => pool.query("UPDATE memory_extract_threads SET available_at=now() - interval '1 second' WHERE thread_id=$1", [thread]);

test('messages in memory-on channels queue one debounced extraction per thread; others queue nothing', async () => {
  const a = await bootstrap(pool);
  const off = await post(a.owner_token, a.channel_id, 'Before the switch');
  assert.equal(await state(off.thread_id), undefined, 'memory off: nothing queued');
  await pool.query('UPDATE channels SET memory_enabled=true WHERE id=$1', [a.channel_id]);
  const noModel = await post(a.owner_token, a.channel_id, 'No worker has a model yet');
  assert.equal(await state(noModel.thread_id), undefined, 'no model: nothing queued');
  assert.equal(await events(noModel.thread_id), 0, 'and no event for the broker');
  await pool.query('UPDATE memory_extract_config SET enabled=true');
  const root = await post(a.owner_token, a.channel_id, 'Customers are charged twice');
  for (let i = 0; i < 5; i++) await post(a.owner_token, a.channel_id, `Reply ${i}`, root.thread_id);
  const s = await state(root.thread_id);
  assert.equal(s.waiting, true, 'debounced into the future');
  assert.ok(await events(root.thread_id) >= 1, 'a broker event carries the deadline');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM memory_extract_threads WHERE thread_id=$1', [root.thread_id])).rows[0].n, 1, 'a burst is one row');
});

test('restore queues completed extraction once, including restores while the model is off', async () => {
  const a = await bootstrap(pool);
  await pool.query("UPDATE memory_extract_config SET enabled=true");
  await pool.query("UPDATE channels SET memory_enabled=true WHERE id=$1", [a.channel_id]);
  const root = await post(a.owner_token, a.channel_id, 'A past decision');
  await pool.query("UPDATE memory_extract_threads SET done_through=pending_through, available_at='infinity' WHERE thread_id=$1", [root.thread_id]);
  await pool.query("UPDATE memory_extract_config SET enabled=false");
  const resets = () => pool.query("SELECT payload FROM observed_outbox WHERE kind='memory.extract.restore' AND aggregate_id=$1 ORDER BY id", [a.channel_id]);
  await pool.query("UPDATE channels SET archived_at=now() WHERE id=$1", [a.channel_id]);
  await pool.query("UPDATE channels SET archived_at=NULL WHERE id=$1", [a.channel_id]);
  assert.equal((await resets()).rowCount, 0, 'a restore with no model leaves no broker backlog');
  await pool.query("UPDATE memory_extract_config SET enabled=true");
  const events = await resets();
  assert.equal(events.rowCount, 1, 'model activation wakes the pending restore');
  const { revision } = events.rows[0].payload;
  const process = () => pool.query('SELECT restore_memory_extract_page($1,$2)', [a.channel_id, revision]);
  await process();
  const progress = async () => (await pool.query('SELECT generation::text, done_through::text, isfinite(available_at) AS scheduled FROM memory_extract_threads WHERE thread_id=$1', [root.thread_id])).rows[0];
  assert.deepEqual(await progress(), { generation: '2', done_through: '0', scheduled: true });
  await process();
  assert.equal((await progress()).generation, '2', 'redelivery cannot invalidate a running extraction');

  // Activate while the channel transaction is still open. Exactly one side must publish the new revision.
  await pool.query('UPDATE memory_extract_config SET enabled=false');
  await pool.query('UPDATE channels SET memory_enabled=false WHERE id=$1', [a.channel_id]);
  const restoring = await pool.connect(), activating = await pool.connect();
  try {
    await restoring.query('BEGIN');
    await restoring.query('UPDATE channels SET memory_enabled=true WHERE id=$1', [a.channel_id]);
    await activating.query("SELECT set_config('application_name',$1,false)", ['test_restore_activation_' + a.channel_id]);
    const activated = activating.query('UPDATE memory_extract_config SET enabled=true');
    // The queries use independent connections. Wait until PostgreSQL accepted the activation command.
    const deadline = Date.now() + 5000;
    for (;;) {
      const { rows: [seen] } = await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND query='UPDATE memory_extract_config SET enabled=true') AS active", ['test_restore_activation_' + a.channel_id]);
      if (seen.active) break;
      assert.ok(Date.now() < deadline, 'activation reached PostgreSQL');
      await delay(10);
    }
    await restoring.query('COMMIT');
    await activated;
  } finally { await restoring.query('ROLLBACK'); restoring.release(); activating.release(true); }
  const resumed = await resets();
  assert.equal(resumed.rowCount, 2, 'an overlapping enablement cannot lose the wakeup');
  const nextRevision = String(BigInt(revision) + 1n);
  await pool.query(`WITH extra AS (
    INSERT INTO threads(id,workspace_id,channel_id) SELECT gen_random_uuid(),$1,$2 FROM generate_series(1,127) RETURNING *
  ) INSERT INTO memory_extract_threads(thread_id,workspace_id,channel_id,available_at)
    SELECT id,workspace_id,channel_id,'infinity' FROM extra`, [a.workspace_id, a.channel_id]);
  await pool.query('SELECT restore_memory_extract_page($1,$2)', [a.channel_id, nextRevision]);
  const { rows: [page] } = await pool.query('SELECT pending, after_thread FROM memory_extract_restores WHERE channel_id=$1', [a.channel_id]);
  assert.ok(page.pending && page.after_thread, 'one full page has a continuation');
  await pool.query('SELECT restore_memory_extract_page($1,$2,$3)', [a.channel_id, nextRevision, page.after_thread]);
  assert.equal((await pool.query('SELECT pending FROM memory_extract_restores WHERE channel_id=$1', [a.channel_id])).rows[0].pending, false, 'an exact page completes on the empty tail');
});

// The knowledge database part needs MEMORY_GRAPH_URL (writer, memory-graph.sql and memory-extract.sql applied).
test('a run writes topics and facts with evidence, replays change nothing, failures back off, and the cap holds', { skip: !process.env.MEMORY_GRAPH_URL }, async () => {
  const graph = new Pool({ connectionString: process.env.MEMORY_GRAPH_URL });
  const a = await bootstrap(pool);
  await pool.query('UPDATE channels SET memory_enabled=true WHERE id=$1', [a.channel_id]);
  await pool.query('UPDATE memory_extract_config SET enabled=true');
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
      return JSON.stringify({ topics: [{ name: 'checkout retries', message_ids: [input.messages[0]!.id] }], facts: [
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

    useMemoryIndex(graphMemoryIndex(process.env.MEMORY_GRAPH_URL));
    const db = new PostgresStore(pool).db;
    const thread = () => readThreadMemory(db, a.channel_id, root.thread_id);
    const header = async () => (await readChannelMemory(db, a.channel_id)).channel?.top_topics;
    assert.deepEqual((await thread()).topics, ['checkout retries']);
    assert.deepEqual(await header(), ['checkout retries']);

    // Simulate a graph commit whose matching Space progress update was interrupted.
    await pool.query("UPDATE memory_extract_threads SET done_through=0, topics='[]', available_at=now() WHERE thread_id=$1", [root.thread_id]);
    assert.equal((await runMemoryExtract(pool, graph, model, embed, root.thread_id)).status, 'done');
    assert.equal(calls, 1, 'reuses the committed topic evidence');
    assert.deepEqual(await header(), ['checkout retries']);

    await pool.query("UPDATE messages SET text='Revised root' WHERE channel_id=$1 AND id=$2", [a.channel_id, root.id]);
    assert.deepEqual((await thread()).topics, [], 'a stale source revision hides the topic before graph catch-up');
    assert.equal((await thread()).facts[0]?.topic, null, 'a surviving fact cannot reveal a stale topic label');
    assert.deepEqual(await header(), [], 'the channel header also checks revisions');
    await graph.query('UPDATE kb.m_messages SET revision=2 WHERE id=$1', [root.id]);
    await due(root.thread_id);
    assert.equal((await runMemoryExtract(pool, graph, model, embed, root.thread_id)).status, 'done');
    assert.deepEqual(await header(), ['checkout retries']);
    const ack = await post(a.owner_token, a.channel_id, 'OK', root.thread_id);
    await graph.query(`INSERT INTO kb.m_messages(id,workspace_id,thread_id,sequence,revision,created_at,memory,knowledge,body,embedding,version)
      VALUES($1,$2,$3,$4,1,now(),true,false,$5,$6,1)`, [ack.id, a.workspace_id, root.thread_id, ack.sequence, ack.text, vector]);
    await due(root.thread_id);
    assert.equal((await runMemoryExtract(pool, graph, async () => ({ topics: [], facts: [] }), embed, root.thread_id)).status, 'done');
    assert.equal((await graph.query('SELECT id FROM kb.m_thread_topics WHERE thread_id=$1', [root.thread_id])).rowCount, 0, 'empty replacement clears the old links');
    assert.deepEqual(await header(), []);

    await graph.query('DELETE FROM kb.m_messages WHERE id=$1', [fix.id]);
    assert.equal(Number((await graph.query('SELECT count(*) FROM kb.m_fact_evidence WHERE message_id=$1', [fix.id])).rows[0].count), 0, 'evidence follows its message');

    const later = await post(a.owner_token, a.channel_id, 'Also refund the second charge', root.thread_id);
    await graph.query(`INSERT INTO kb.m_messages(id,workspace_id,thread_id,sequence,revision,created_at,memory,knowledge,body,embedding,version)
      VALUES($1,$2,$3,$4,1,now(),true,false,$5,$6,1)`, [later.id, a.workspace_id, root.thread_id, later.sequence, later.text, vector]);
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
    useMemoryIndex(undefined);
    await graph.query('DELETE FROM kb.m_channels WHERE id=$1', [a.channel_id]);
    await graph.end();
  }
});

test('a burst of events runs the model once: stale deadlines are dropped and one delivery claims the current one', { skip: !process.env.MEMORY_GRAPH_URL }, async () => {
  const graph = new Pool({ connectionString: process.env.MEMORY_GRAPH_URL });
  const a = await bootstrap(pool);
  await pool.query('UPDATE channels SET memory_enabled=true WHERE id=$1', [a.channel_id]);
  await pool.query('UPDATE memory_extract_config SET enabled=true');
  const root = await post(a.owner_token, a.channel_id, 'Retries charge customers twice');
  const deadlines: string[] = [];
  const messages = [root];
  for (let i = 0; i < 4; i++) {
    messages.push(await post(a.owner_token, a.channel_id, `Reply ${i}`, root.thread_id));
    deadlines.push((await pool.query("SELECT payload->>'available_at' AS at FROM observed_outbox WHERE kind='memory.extract.ready' AND payload->>'thread_id'=$1 ORDER BY created_at DESC, id DESC LIMIT 1", [root.thread_id])).rows[0].at);
  }
  await pool.query('UPDATE memory_extract_threads SET last_run_at = NULL WHERE thread_id=$1', [root.thread_id]);
  const vector = JSON.stringify(Array.from({ length: 384 }, () => 0.1));
  try {
    await graph.query('INSERT INTO kb.m_channels(id,workspace_id,name,is_private,memory_enabled,version) VALUES($1,$2,$3,false,true,1)', [a.channel_id, a.workspace_id, 'general']);
    await graph.query('INSERT INTO kb.m_threads(id,workspace_id,channel_id,version) VALUES($1,$2,$3,1)', [root.thread_id, a.workspace_id, a.channel_id]);
    for (const m of messages) await graph.query(`INSERT INTO kb.m_messages(id,workspace_id,thread_id,sequence,revision,created_at,memory,knowledge,body,embedding,version)
      VALUES($1,$2,$3,$4,1,now(),true,false,$5,$6,1)`, [m.id, a.workspace_id, root.thread_id, m.sequence, m.text, vector]);
    let calls = 0;
    const model = async (input: { messages: { id: string }[] }) => { calls++; await new Promise(r => setTimeout(r, 200));
      return JSON.stringify({ topics: [{ name: 'retries', message_ids: [input.messages[0]!.id] }], facts: [{ text: 'Retries double charge.', kind: 'fact', message_ids: [input.messages[0]!.id] }] }); };
    const embed = async (texts: string[]) => texts.map(() => Array.from({ length: 384 }, () => 0.2));
    // Make the newest deadline due, keeping its exact value so its event still matches.
    const current = deadlines.at(-1)!;
    await pool.query('UPDATE memory_extract_threads SET available_at = $2::timestamptz - interval \'1 hour\' WHERE thread_id=$1', [root.thread_id, current]);
    const due = (await pool.query('SELECT available_at::text AS at FROM memory_extract_threads WHERE thread_id=$1', [root.thread_id])).rows[0].at;

    assert.equal((await runMemoryExtract(pool, graph, model, embed, root.thread_id, 60, deadlines[0])).status, 'superseded', 'an older event is dropped');
    const outcomes = await Promise.all([1, 2, 3, 4].map(() => runMemoryExtract(pool, graph, model, embed, root.thread_id, 60, due)));
    assert.deepEqual(outcomes.map(o => o.status).sort(), ['done', 'superseded', 'superseded', 'superseded'], 'duplicate deliveries of one deadline: one runs');
    assert.equal(calls, 1, 'one model call');
    assert.equal((await pool.query('SELECT used FROM memory_extract_budget WHERE workspace_id=$1', [a.workspace_id])).rows[0].used, 1, 'one budget unit');
  } finally {
    await graph.query('DELETE FROM kb.m_channels WHERE id=$1', [a.channel_id]);
    await graph.end();
  }
});

test('extraction waits for indexed revisions, preserves earlier decisions, and refreshes edits at the same sequence', { skip: !process.env.MEMORY_GRAPH_URL }, async () => {
  const graph = new Pool({ connectionString: process.env.MEMORY_GRAPH_URL });
  const a = await bootstrap(pool);
  await pool.query('UPDATE channels SET memory_enabled=true WHERE id=$1', [a.channel_id]);
  await pool.query('UPDATE memory_extract_config SET enabled=true');
  const root = await post(a.owner_token, a.channel_id, 'Ship Friday');
  const thread = root.thread_id;
  const vector = Array<number>(384).fill(0.25);
  const indexMessage = (m: typeof root, revision: number) => graph.query(
    `INSERT INTO kb.m_messages(id,workspace_id,thread_id,sequence,revision,created_at,memory,knowledge,body,embedding,version)
     VALUES ($1,$2,$3,$4,$5,now(),true,false,$6,$7,$5) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, body=excluded.body`,
    [m.id, a.workspace_id, thread, m.sequence, revision, m.text, JSON.stringify(vector)]);
  let calls = 0;
  const model = async ({ messages }: { messages: { id: string; text: string }[] }) => {
    calls++;
    return { topics: [], facts: messages.filter(m => m.text.startsWith('Ship')).map(m => ({ text: m.text, message_ids: [m.id] })) };
  };
  const run = () => runMemoryExtract(pool, graph, model, async texts => texts.map(() => vector), thread);
  const stored = async () => (await graph.query('SELECT text FROM kb.m_facts WHERE thread_id=$1 ORDER BY text', [thread])).rows.map(r => r.text);
  try {
    await due(thread);
    await run();
    assert.equal((await state(thread)).done_through, '0', 'missing graph thread must leave Space progress pending');
    assert.equal(calls, 0, 'waiting for CDC costs no model call');
    await graph.query('INSERT INTO kb.m_channels(id,workspace_id,name,is_private,memory_enabled,version) VALUES($1,$2,$3,false,true,1)', [a.channel_id, a.workspace_id, 'general']);
    await graph.query('INSERT INTO kb.m_threads(id,workspace_id,channel_id,version) VALUES($1,$2,$3,1)', [thread, a.workspace_id, a.channel_id]);
    await indexMessage(root, 1);
    await pool.query('SELECT wake_memory_extract($1::uuid[])', [[thread]]);
    assert.equal((await run()).status, 'done');
    const followup = await post(a.owner_token, a.channel_id, 'Thanks', thread);
    await indexMessage(followup, 1);
    await due(thread);
    assert.equal((await run()).status, 'done');
    assert.deepEqual(await stored(), ['Ship Friday']);
    useMemoryIndex(graphMemoryIndex(process.env.MEMORY_GRAPH_URL));
    const visibleFacts = async () => (await readThreadMemory(new PostgresStore(pool).db, a.channel_id, thread)).facts.map(f => f.text);
    assert.deepEqual(await visibleFacts(), ['Ship Friday']);
    await pool.query("UPDATE messages SET text='Ship Monday' WHERE channel_id=$1 AND id=$2", [a.channel_id, root.id]);
    assert.deepEqual(await visibleFacts(), [], 'Space hides an edited citation before the graph catches up');
    await due(thread);
    await run();
    assert.equal(calls, 2, 'a stale indexed revision must wait for CDC');
    await indexMessage({ ...root, text: 'Ship Monday' }, 2);
    await pool.query('SELECT wake_memory_extract($1::uuid[])', [[thread]]);
    assert.equal((await run()).status, 'done');
    assert.deepEqual(await stored(), ['Ship Monday']);

    // Replay after the graph committed but before Space saved its watermark.
    await pool.query("UPDATE memory_extract_threads SET done_through=0,available_at=now() WHERE thread_id=$1", [thread]);
    assert.equal((await run()).status, 'done');
    assert.equal(calls, 3, 'a committed extraction is acknowledged without a second model call');

    const long = await post(a.owner_token, a.channel_id, '界'.repeat(5000), thread);
    const last = await post(a.owner_token, a.channel_id, 'Ship Tuesday too', thread);
    await indexMessage(long, 1);
    await indexMessage(last, 1);
    await due(thread);
    assert.equal((await run()).status, 'done');
    assert.equal((await state(thread)).done_through, String(long.sequence));
    await due(thread);
    assert.equal((await run()).status, 'done');
    assert.deepEqual(await stored(), ['Ship Monday', 'Ship Tuesday too']);

    const changed = await post(a.owner_token, a.channel_id, 'Ship Wednesday', thread);
    await indexMessage(changed, 1);
    await due(thread);
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const older = runMemoryExtract(pool, graph, async input => { started(); await resume; return model(input); },
      async texts => texts.map(() => vector), thread);
    await entered;
    try {
      await pool.query("UPDATE messages SET text='Ship Thursday' WHERE channel_id=$1 AND id=$2", [a.channel_id, changed.id]);
      await indexMessage({ ...changed, text: 'Ship Thursday' }, 2);
      await due(thread);
      assert.equal((await run()).status, 'done');
    } finally { release(); }
    assert.equal((await older).status, 'superseded');
    assert.deepEqual(await stored(), ['Ship Monday', 'Ship Thursday', 'Ship Tuesday too']);
  } finally {
    useMemoryIndex(undefined);
    await graph.query('DELETE FROM kb.m_channels WHERE id=$1', [a.channel_id]);
    await graph.end();
  }
});
