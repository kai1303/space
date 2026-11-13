// Run with TEST_DATABASE_URL (Space test DB with wal_level=logical, role with REPLICATION),
// THREAD_INDEX_URL (disposable index with schema, threads, markdown, memory-graph and memory-extract SQL applied) and
// KNOWLEDGE_DATABASE_URL (knowledge DB reader role). Needs the local Ollama all-minilm:22m model.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool, database } from '@space/postgres/database';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { ChatStore } from '@space/postgres/chat';
import { listNoteTitles, saveNoteByTitle } from '@space/postgres/knowledge-notes';
import { searchRelated } from './graph-related.mjs';
import { searchThreads } from './thread-search.mjs';
import { embed } from './graph-source.mjs';

const schema = 'graph_test_' + randomUUID().replaceAll('-', '');
const slot = ('space_graph_' + schema).slice(0, 63);
const checkpoint = 'space_memory_v2:' + slot;
const admin = createPool(process.env.TEST_DATABASE_URL), index = createPool(process.env.THREAD_INDEX_URL), reader = createPool(process.env.KNOWLEDGE_DATABASE_URL);
const url = new URL(process.env.TEST_DATABASE_URL);
url.searchParams.set('options', '-c search_path=' + schema);
const source = createPool(url.href);
let worker;
async function stop() {
  if (worker && worker.exitCode === null && worker.signalCode === null) { const ended = once(worker, 'exit'); worker.kill(); await ended; }
}
const start = () => { worker = spawn(process.execPath, [fileURLToPath(new URL('./graph-reader.mjs', import.meta.url))], {
  env: { ...process.env, GRAPH_SOURCE_URL: url.href, GRAPH_REPLICATION_URL: process.env.TEST_DATABASE_URL,
    GRAPH_INDEX_URL: process.env.THREAD_INDEX_URL, GRAPH_SOURCE_SCHEMA: schema }, stdio: ['ignore', 'inherit', 'inherit'] }); };
async function until(fn) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await fn()) return; await delay(150); }
  throw Error('Timed out waiting for the graph');
}
const count = async (table, where = 'true') => Number((await index.query(`SELECT count(*) FROM kb.${table} WHERE ${where}`)).rows[0].count);
const thread = async id => (await index.query('SELECT reply_count, root_message_id FROM kb.m_threads WHERE id=$1', [id])).rows[0];
const ranked = async text => {
  const [vector] = await embed([text]);
  return (await index.query(`SELECT source_key FROM pgcontext.query('kb_memory',$1::pgcontext.vector,$2,'text',5)`, [JSON.stringify(vector), text])).rows.map(r => r.source_key);
};
try {
  await admin.query('CREATE SCHEMA ' + schema);
  await migrate(source);
  const seed = await bootstrap(source), chat = new ChatStore(source), db = database(source);
  const send = (text, thread_id) => chat.send(seed.owner_id, seed.channel_id, { client_message_id: randomUUID(), text, ...(thread_id ? { thread_id } : {}) });
  const rootA = await send('Customers are charged twice when checkout retries after a timeout.');
  const replyA = await send('The fix is to dedupe charges on the idempotency key.', rootA.thread_id);
  const rootB = await send('Rotate the API signing keys every quarter.');
  await source.query('UPDATE channels SET memory_enabled=true, knowledge_enabled=true WHERE id=$1', [seed.channel_id]);
  const scope = { workspaceId: seed.workspace_id, channelId: seed.channel_id }, codex = { id: 'codex', name: 'Codex' };
  const save = (title, id) => saveNoteByTitle(db, scope, { kind: 'fact', title, content: title + ' body.', message_ids: [id] }, codex);
  await save('A', rootA.id); await save('B', rootA.id); await save('C', rootB.id);

  const archived = await chat.createChannel(seed.owner_id, seed.workspace_id, { name: 'archived-project', private: false });
  const oldPost = await chat.send(seed.owner_id, archived.id, { client_message_id: randomUUID(), text: 'Archived evidence' });
  await source.query('UPDATE channels SET memory_enabled=true, archived_at=now() WHERE id=$1', [archived.id]);
  await index.query(`INSERT INTO kb.m_channels(id,workspace_id,name,is_private,memory_enabled,version)
    VALUES ($1,$2,'archived-project',false,true,1)`, [archived.id, seed.workspace_id]);
  await index.query('INSERT INTO kb.m_threads(id,workspace_id,channel_id,version) VALUES($1,$2,$3,1)', [oldPost.thread_id,seed.workspace_id,archived.id]);
  await index.query(`INSERT INTO kb.m_messages(id,workspace_id,thread_id,sequence,revision,created_at,memory,knowledge,body,embedding,version)
    VALUES($1,$2,$3,1,1,now(),true,false,'Archived evidence',$4,1)`, [oldPost.id,seed.workspace_id,oldPost.thread_id,JSON.stringify(Array(384).fill(0.25))]);
  // Simulate an upgraded installation: the old graph previously published all source WAL.
  await admin.query(`CREATE PUBLICATION "${slot}" FOR TABLE "${schema}".channels`);
  const { rows: [legacy] } = await admin.query("SELECT lsn::text FROM pg_create_logical_replication_slot($1,'pgoutput')", [slot]);
  await index.query('INSERT INTO kb.graph_position(slot,lsn,published_lsn) VALUES($1,$2,$2)', [slot, legacy.lsn]);
  // The preceding memory reader recorded a current checkpoint but retained an archived row.
  const previous = 'space_memory:' + slot;
  await index.query('INSERT INTO kb.graph_position(slot,lsn,published_lsn) VALUES($1,$2,$2)', [previous, legacy.lsn]);
  const cleanupUrl = new URL(process.env.THREAD_INDEX_URL);
  const env = { ...process.env };
  if (cleanupUrl.password) env.PGPASSWORD = decodeURIComponent(cleanupUrl.password);
  cleanupUrl.password = '';
  const cleanup = () => spawnSync('psql', ['-X', '-d', cleanupUrl.href, '-v', 'source_schema=' + schema,
    '-f', fileURLToPath(new URL('./drop-old-graph.sql', import.meta.url))], { env, encoding: 'utf8' });
  const premature = cleanup();
  assert.notEqual(premature.status, 0, 'a published legacy graph cannot authorize cleanup');
  assert.match(premature.stderr, /space_memory has not been published/);
  const park = id => source.query(`INSERT INTO memory_extract_threads
    (thread_id,workspace_id,channel_id,pending_through,available_at,waiting_for_index)
    VALUES($1,$2,$3,1,'infinity',true) ON CONFLICT(thread_id) DO UPDATE SET available_at='infinity',waiting_for_index=true`,
    [id, seed.workspace_id, seed.channel_id]);
  const awake = async id => (await source.query(
    'SELECT NOT waiting_for_index AND isfinite(available_at) AS awake FROM memory_extract_threads WHERE thread_id=$1', [id])).rows[0]?.awake;
  await park(rootA.thread_id);
  start();
  await until(() => awake(rootA.thread_id));
  await until(async () => (await count('m_messages')) === 3 && (await count('m_knowledge')) === 3);
  assert.equal(await count('m_messages', `id='${oldPost.id}'`), 0, 'upgrade removes stale archived messages');
  assert.equal(await count('m_messages', 'embedding IS NOT NULL'), 3, 'every message has a vector');
  assert.deepEqual(await thread(rootA.thread_id), { reply_count: 1, root_message_id: rootA.id }, 'thread counts and root');
  assert.equal(await count('m_knowledge_evidence', `message_id='${rootA.id}'`), 2, 'knowledge evidence is message level');
  assert.ok(await count('m_people') >= 1);
  const top = await ranked('why are customers charged twice on retry');
  assert.ok([rootA.id, replyA.id].includes(top[0]), 'meaning search finds the right thread first: ' + top.join());

  await source.query('UPDATE channels SET archived_at=now() WHERE id=$1', [seed.channel_id]);
  await until(async () => (await count('m_messages')) === 0);
  assert.ok(!(await ranked('checkout retries')).includes(rootA.id), 'archive removes the vector point');
  await source.query('UPDATE channels SET archived_at=NULL WHERE id=$1', [seed.channel_id]);
  await until(async () => (await count('m_messages')) === 3);
  assert.ok((await ranked('checkout retries')).includes(rootA.id), 'restore indexes existing messages');

  const ids = Object.fromEntries((await listNoteTitles(db, seed.channel_id)).notes.map(n => [n.title, n.id]));
  const ctx = requesterId => ({ workspaceId: seed.workspace_id, requesterId, connectionId: randomUUID(), audience: { channelId: seed.channel_id } });
  assert.deepEqual((await searchRelated(reader, source, ctx(seed.owner_id), 'note/' + ids.A, 5)).map(h => h.title), ['B'], 'A and B cite the same message');
  assert.deepEqual(await searchRelated(reader, source, ctx(randomUUID()), 'note/' + ids.A, 5), [], 'unknown requester sees nothing');
  await assert.rejects(() => searchRelated(reader, source, ctx(seed.owner_id), 'message/' + ids.A, 5), /Invalid related reference/);

  await park(rootA.thread_id); await park(rootB.thread_id);
  const replyB = await send('Also record the rollout date.', rootA.thread_id);   // live change through the slot
  await until(async () => (await count('m_messages')) === 4);
  assert.equal((await thread(rootA.thread_id)).reply_count, 2);
  await until(() => awake(rootA.thread_id));
  assert.equal(await awake(rootB.thread_id), false, 'only the indexed message’s thread wakes');

  await chat.deleteMessage(seed.owner_id, seed.channel_id, replyB.id);          // delete removes the row and its vector point
  await until(async () => (await count('m_messages')) === 3);
  assert.equal((await thread(rootA.thread_id)).reply_count, 1);
  assert.ok(!(await ranked('record the rollout date')).includes(replyB.id), 'the vector point is gone too');

  await stop();                                                                  // reader offline
  const replyC = await send('Offline message about invoices.', rootB.thread_id);
  start();                                                                       // restart: the slot replays what was missed
  await until(async () => (await count('m_messages')) === 4);
  assert.equal(await count('m_messages', `id='${replyC.id}'`), 1);
  await until(async () => (await index.query('SELECT lsn=published_lsn AS same FROM kb.graph_position WHERE slot=$1', [checkpoint])).rows[0]?.same);

  await park(rootB.thread_id);
  await source.query('INSERT INTO knowledge_thread_channels(workspace_id,channel_id) VALUES($1,$2)', [seed.workspace_id, seed.channel_id]);   // thread search opt-in
  await until(async () => (await count('m_messages', 'knowledge')) === 4);
  await until(() => awake(rootB.thread_id));
  const [question] = await embed(['why are customers charged twice on retry']);
  const found = await searchThreads(reader, source, ctx(seed.owner_id), 'why are customers charged twice on retry', question, 3);
  assert.ok(found.some(h => h.ref.recordId === 'message/' + rootA.id), 'knowledge thread search reads the merged store');
  assert.deepEqual(await searchThreads(reader, source, ctx(randomUUID()), 'charged twice', question, 3), [], 'and keeps its own access check');
  await source.query('DELETE FROM knowledge_thread_channels WHERE channel_id=$1', [seed.channel_id]);
  await until(async () => (await count('m_messages', 'knowledge')) === 0);

  // Fail a real graph transaction during reconciliation, then restart without another source event.
  async function interruptSwitch(enabled, partial) {
    let when = '';
    if (!enabled) {
      // The delete phase must commit page one, then fail on page two, with the switch still replayable.
      await index.query(`INSERT INTO kb.m_messages(id,workspace_id,thread_id,sequence,revision,created_at,
        memory,knowledge,body,embedding,version)
        SELECT gen_random_uuid(),workspace_id,thread_id,sequence,revision,created_at,memory,knowledge,body,embedding,version
        FROM kb.m_messages CROSS JOIN generate_series(1,200) WHERE id=$1`, [rootA.id]);
      const { rows: [last] } = await index.query('SELECT max(id) AS id FROM kb.m_messages');
      when = `WHEN (OLD.id='${last.id}')`;
    }
    await index.query(`CREATE FUNCTION kb.fail_resync() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'interrupted resync'; END $$`);
    await index.query(`CREATE TRIGGER fail_resync BEFORE ${enabled ? 'INSERT' : 'DELETE'} ON kb.m_messages
      FOR EACH ROW ${when} EXECUTE FUNCTION kb.fail_resync()`);
    const exited = once(worker, 'exit', { signal: AbortSignal.timeout(30000) });
    const client = await source.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE channels SET memory_enabled=$2 WHERE id=$1', [seed.channel_id, enabled]);
      // Force the switch into a non-checkpointed 500-row chunk.
      if (partial) await client.query(`DO $$ BEGIN FOR i IN 1..500 LOOP
        UPDATE channels SET name=name WHERE id='${seed.channel_id}'; END LOOP; END $$`);
      await client.query('COMMIT');
    } finally { client.release(); }
    assert.equal((await exited)[0], 1);
    await index.query('DROP TRIGGER fail_resync ON kb.m_messages');
    await index.query('DROP FUNCTION kb.fail_resync()');
    if (!enabled) assert.equal(await count('m_messages'), 4, 'exactly one page committed before the interruption');
    assert.equal((await index.query('SELECT memory_enabled FROM kb.m_channels WHERE id=$1', [seed.channel_id])).rows[0].memory_enabled, !enabled);
    start();
  }
  await interruptSwitch(false, false);
  await until(async () => (await count('m_messages')) === 0);
  assert.equal(await count('m_knowledge'), 3, 'knowledge stays while the memory switch is off');
  await interruptSwitch(true, true);
  await until(async () => (await count('m_messages')) === 4);

  await stop(); start();                                                         // restart with nothing new changes nothing
  await delay(2000);
  assert.equal(await count('m_messages'), 4);
  // Recreate the slot as after a WAL loss, including a crash between slot creation and rebuild.
  await stop();
  await index.query(`INSERT INTO kb.m_facts(id,workspace_id,thread_id,kind,text,extract_version,embedding,evidence_revisions)
    SELECT 'preserved',workspace_id,thread_id,'fact','Recovered fact',sequence,embedding,jsonb_build_object(id,revision::text) FROM kb.m_messages WHERE id=$1`, [rootA.id]);
  await index.query(`INSERT INTO kb.m_fact_evidence(id,workspace_id,fact_id,message_id)
    VALUES ('preserved-evidence',$1,'preserved',$2)`, [seed.workspace_id, rootA.id]);
  await admin.query('SELECT pg_drop_replication_slot($1)', [slot]);
  await chat.deleteMessage(seed.owner_id, seed.channel_id, replyA.id);
  const afterLoss = await send('Committed after the old slot was lost.');
  await admin.query("SELECT pg_create_logical_replication_slot($1,'pgoutput')", [slot]);
  start();
  await until(async () => (await count('m_messages', `id='${afterLoss.id}'`)) === 1);
  assert.equal(await count('m_messages', `id='${replyA.id}'`), 0, 'lost-slot snapshot removes an absent message');
  assert.equal((await thread(rootA.thread_id)).reply_count, 0);
  assert.equal(await count('m_fact_evidence', "id='preserved-evidence'"), 1, 'slot recovery preserves existing extraction');
  await until(async () => (await index.query("SELECT published_lsn>'0/0' AS ready FROM kb.graph_position WHERE slot=$1", [checkpoint])).rows[0]?.ready);
  const ready = cleanup();
  assert.equal(ready.status, 0, ready.stderr);
  console.log('PASS: legacy upgrade and cleanup, snapshot, search, CDC, extraction wakeups, interrupted channel switches, slot loss and fact preservation.');
} finally {
  await stop();
  for (let i = 0; i < 20; i++) {
    try { await admin.query('SELECT pg_drop_replication_slot($1)', [slot]); break; } catch { await delay(250); }
  }
  await admin.query(`DROP PUBLICATION IF EXISTS "${slot}"`).catch(() => {});
  await index.query('DROP FUNCTION IF EXISTS kb.fail_resync() CASCADE').catch(() => {});
  await index.query("SELECT pgcontext.delete_points('kb_memory', ARRAY(SELECT id FROM kb.m_messages))").catch(() => {});
  await index.query('DELETE FROM kb.m_channels').catch(() => {});
  await index.query('DELETE FROM kb.m_people').catch(() => {});
  await index.query('DELETE FROM kb.graph_position WHERE slot=ANY($1::text[])', [[slot, 'space_memory:' + slot, checkpoint]]).catch(() => {});
  await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
  await Promise.all([admin.end(), index.end(), reader.end(), source.end()]);
}
