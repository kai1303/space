import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { fitMessages, parseExtraction, topicKey, type Extractor, type Extraction } from '@space/core/memory-extract';

export type ExtractOutcome = { status: 'done' | 'idle' | 'later' | 'retry' | 'capped' | 'superseded' | 'waiting_for_index'; delayMs?: number };
type Embed = (texts: string[]) => Promise<number[][]>;
type Source = { id: string; sequence: string; revision: string; author: string; body: string };
type State = { workspace_id: string; channel_id: string; pending_through: string; done_through: string; generation: string; wait_ms: number; available_at: string; current: boolean };
const hash = (...parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
const MAX_ATTEMPTS = 6;

async function indexed(client: Pool | PoolClient, thread: string, source: Source[]) {
  const result = await client.query(`SELECT m.id FROM kb.m_messages m
    JOIN unnest($2::text[], $3::bigint[]) input(id, revision) USING (id, revision)
    WHERE m.thread_id=$1 AND m.memory`, [thread, source.map(m => m.id), source.map(m => m.revision)]);
  return result.rowCount === source.length;
}

async function saveExtraction(client: PoolClient, workspace: string, thread: string, through: string,
  extraction: Extraction, revisions: Map<string, string>, vectors: number[][]) {
  const topicIds = new Map<string, string>();
  for (const name of extraction.topics) {
    const key = topicKey(name), id = hash(workspace, key);
    topicIds.set(key, id);
    await client.query('INSERT INTO kb.m_topics(id,workspace_id,name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING', [id, workspace, name]);
    await client.query(`INSERT INTO kb.m_thread_topics(id,workspace_id,thread_id,topic_id,extract_version) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (id) DO UPDATE SET extract_version=excluded.extract_version`, [hash(thread, id), workspace, thread, id, through]);
  }
  if (topicIds.size) await client.query('DELETE FROM kb.m_thread_topics WHERE thread_id=$1 AND NOT (topic_id=ANY($2::text[]))',
    [thread, [...topicIds.values()]]);
  // An earlier run can commit while the CDC transaction editing its source is in flight.
  // Its claims are already hidden on reads. Remove them when processing the revised batch.
  const input = Object.fromEntries(revisions);
  await client.query(`WITH removed AS (
    DELETE FROM kb.m_facts f USING kb.m_fact_evidence e,jsonb_each_text($2::jsonb) source
    WHERE f.thread_id=$1 AND e.fact_id=f.id AND e.message_id=source.key
      AND f.evidence_revisions->>source.key IS DISTINCT FROM source.value RETURNING f.id
  ) SELECT pgcontext.delete_points('kb_memory_facts', ARRAY(SELECT id FROM removed))`, [thread, input]);
  const ids: string[] = [];
  for (const [i, fact] of extraction.facts.entries()) {
    const id = hash(thread, fact.kind, fact.text);
    ids.push(id);
    const evidence = Object.fromEntries(fact.message_ids.map(message => [message, revisions.get(message)!]));
    await client.query(`INSERT INTO kb.m_facts(id,workspace_id,thread_id,topic_id,kind,text,extract_version,embedding,evidence_revisions)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (id) DO UPDATE SET evidence_revisions=excluded.evidence_revisions, extract_version=excluded.extract_version,
        topic_id=excluded.topic_id, embedding=excluded.embedding`,
      [id, workspace, thread, fact.topic ? topicIds.get(topicKey(fact.topic)) ?? null : null, fact.kind, fact.text, through, JSON.stringify(vectors[i]), evidence]);
    await client.query('DELETE FROM kb.m_fact_evidence WHERE fact_id=$1 AND NOT (message_id=ANY($2::text[]))', [id, fact.message_ids]);
    for (const message of fact.message_ids) await client.query(`INSERT INTO kb.m_fact_evidence(id,workspace_id,fact_id,message_id)
      VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`, [hash(id, message), workspace, id, message]);
  }
  if (ids.length) await client.query("SELECT pgcontext.upsert_points('kb_memory_facts',$1::text[])", [ids]);
}

export async function runMemoryExtract(space: Pool, graph: Pool, extract: Extractor, embed: Embed, threadId: string, hourlyCap = 60, deadline?: string): Promise<ExtractOutcome> {
  const { rows: [state] } = await space.query<State>(
    `SELECT workspace_id, channel_id, pending_through::text, done_through::text, generation::text, available_at::text,
       CASE WHEN isfinite(available_at) THEN greatest(0, ceil(extract(epoch FROM (available_at - now())) * 1000))::float8 ELSE 0 END AS wait_ms,
       ($2::timestamptz IS NULL OR available_at = $2::timestamptz) AS current
     FROM memory_extract_threads WHERE thread_id=$1`, [threadId, deadline ?? null]);
  if (!state) return { status: 'idle' };
  if (!state.current) return { status: 'superseded' };
  if (state.wait_ms > 0) return { status: 'later', delayMs: state.wait_ms };
  if (BigInt(state.pending_through) <= BigInt(state.done_through)) return { status: 'idle' };

  // Register before checking the graph. A concurrent graph commit either wakes this claim or
  // is already visible to its read. A finite deadline recovers a worker that dies during the check.
  const claim = (await space.query<{ deadline: string }>(`UPDATE memory_extract_threads
    SET available_at=now()+interval '5 minutes', waiting_for_index=true
    WHERE thread_id=$1 AND available_at=$2 AND generation=$3 AND done_through=$4
    RETURNING available_at::text AS deadline`, [threadId, state.available_at, state.generation, state.done_through])).rows[0];
  if (!claim) return { status: 'superseded' };
  const owner = [threadId, claim.deadline, state.generation, state.done_through];
  const owns = 'thread_id=$1 AND available_at=$2::timestamptz AND generation=$3 AND done_through=$4';
  const finish = async (through: string) => {
    const result = await space.query(`UPDATE memory_extract_threads SET done_through=$5, attempts=0,
      last_run_at=now(), waiting_for_index=false,
      available_at=CASE WHEN pending_through>$5 THEN now()+interval '5 minutes' ELSE 'infinity' END
      WHERE ${owns}`, [...owner, through]);
    return Boolean(result.rowCount);
  };
  const { rows: source } = await space.query<Source>(
    `SELECT m.id::text, m.sequence::text, m.search_revision::text AS revision, coalesce(u.display_name, d.name, m.author_type) AS author, m.body
     FROM memory_source_messages m LEFT JOIN users u ON u.id=m.author_id
     LEFT JOIN agent_installations i ON i.id=m.author_id LEFT JOIN agent_definitions d ON d.id=i.definition_id
     WHERE m.thread_id=$1 AND m.channel_id=$2 AND m.agent_session_id IS NULL AND m.sequence>$3 AND m.sequence<=$4
     ORDER BY m.sequence LIMIT 64`, [threadId, state.channel_id, state.done_through, state.pending_through]);
  if (!source.length) return { status: await finish(state.pending_through) ? 'idle' : 'superseded' };
  const messages = fitMessages(source.map(m => ({ id: m.id, speaker: m.author, text: m.body })));
  const batch = source.slice(0, messages.length);
  const through = batch.at(-1)!.sequence;
  if (!await indexed(graph, threadId, batch)) {
    const parked = await space.query(`UPDATE memory_extract_threads SET available_at='infinity' WHERE ${owns}`, owner);
    return { status: parked.rowCount ? 'waiting_for_index' : 'superseded' };
  }
  if (!(await space.query(`UPDATE memory_extract_threads SET waiting_for_index=false WHERE ${owns}`, owner)).rowCount) return { status: 'superseded' };

  // A crash can occur after the graph commit but before Space records its progress.
  const committed = async (reader: Pool | PoolClient) => Boolean((await reader.query(`SELECT 1 FROM kb.m_threads
    WHERE id=$1 AND extract_generation=$2 AND extract_version >= $3`, [threadId, state.generation, through])).rowCount);
  if (await committed(graph)) return { status: await finish(through) ? 'done' : 'superseded' };

  const budget = await space.query(
    `INSERT INTO memory_extract_budget(workspace_id,hour,used) SELECT $1,date_trunc('hour',now()),1 WHERE $2::int>0
     ON CONFLICT (workspace_id,hour) DO UPDATE SET used=memory_extract_budget.used+1 WHERE memory_extract_budget.used<$2`,
    [state.workspace_id, hourlyCap]);
  if (!budget.rowCount) {
    const { rows: [next] } = await space.query<{ wait_ms: number }>(
      `UPDATE memory_extract_threads SET available_at=date_trunc('hour',now())+interval '1 hour' WHERE ${owns}
       RETURNING ceil(extract(epoch FROM (available_at-now()))*1000)::float8 AS wait_ms`, owner);
    return next ? { status: 'capped', delayMs: next.wait_ms } : { status: 'superseded' };
  }
  const revisions = new Map(batch.map(m => [m.id, m.revision]));
  const { rows: known } = await graph.query<{ name: string | null; text: string | null }>(
    `(SELECT t.name,NULL AS text FROM kb.m_thread_topics l JOIN kb.m_topics t ON t.id=l.topic_id
       WHERE l.thread_id=$1 ORDER BY l.extract_version DESC,l.id LIMIT 5)
     UNION ALL (SELECT NULL,f.text FROM kb.m_facts f WHERE f.thread_id=$1 AND f.evidence_revisions IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(f.evidence_revisions) e
         WHERE $2::jsonb ? e.key AND ($2::jsonb ->> e.key) <> e.value)
       ORDER BY f.extract_version DESC,f.id LIMIT 8)`, [threadId, Object.fromEntries(revisions)]);
  let extraction: Extraction;
  let vectors: number[][];
  try {
    const raw = await extract({ messages, topics: known.flatMap(k => k.name ? [k.name] : []), facts: known.flatMap(k => k.text ? [k.text] : []) }, AbortSignal.timeout(30_000));
    extraction = parseExtraction(raw, new Set(messages.map(m => m.id)));
    vectors = extraction.facts.length ? await embed(extraction.facts.map(f => f.text)) : [];
  } catch {
    const { rows: [next] } = await space.query<{ wait_ms: number | null }>(
      `UPDATE memory_extract_threads SET attempts=attempts+1,
         available_at=CASE WHEN attempts+1 >= ${MAX_ATTEMPTS} THEN 'infinity' ELSE now()+least(interval '1 hour',interval '30 seconds'*power(2,attempts)) END
       WHERE ${owns} RETURNING CASE WHEN isfinite(available_at) THEN ceil(extract(epoch FROM (available_at-now()))*1000)::float8 END AS wait_ms`, owner);
    return next ? { status: 'retry', delayMs: next.wait_ms ?? undefined } : { status: 'superseded' };
  }

  const client = await graph.connect();
  try {
    await client.query('BEGIN');
    const won = await client.query(`UPDATE kb.m_threads SET extract_generation=$2, extract_version=$3
      WHERE id=$1 AND (extract_generation,extract_version)<($2::bigint,$3::bigint) RETURNING workspace_id`, [threadId, state.generation, through]);
    if (won.rowCount) {
      if (!await indexed(client, threadId, batch)) {
        await client.query('ROLLBACK');
        // The durable claim deadline retries the readiness check after a concurrent edit/rebuild.
        return { status: 'retry' };
      }
      await saveExtraction(client, won.rows[0].workspace_id, threadId, through, extraction, revisions, vectors);
    }
    await client.query('COMMIT');
    if (!won.rowCount && !await committed(client)) return { status: 'superseded' };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  return { status: await finish(through) ? 'done' : 'superseded' };
}
