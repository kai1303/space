import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { fitMessages, parseExtraction, topicKey, type Extractor, type ExtractMessage } from '@space/core/memory-extract';

// The extraction run for one thread. Space holds the progress (memory_extract_threads, memory_extract_budget);
// the Graph RAG store holds the topics and facts. Every step is a conditional write; nothing is locked.
export type ExtractOutcome = { status: 'done' | 'idle' | 'later' | 'retry' | 'capped'; delayMs?: number };
type Embed = (texts: string[]) => Promise<number[][]>;

const hash = (...parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
const MAX_ATTEMPTS = 6;

export async function runMemoryExtract(space: Pool, graph: Pool, extract: Extractor, embed: Embed, threadId: string, hourlyCap = 60): Promise<ExtractOutcome> {
  const { rows: [state] } = await space.query<{ workspace_id: string; channel_id: string; pending_through: string; done_through: string; attempts: number; wait_ms: number }>(
    `SELECT workspace_id, channel_id, pending_through::text, done_through::text, attempts,
       CASE WHEN isfinite(available_at) THEN greatest(0, ceil(extract(epoch FROM (available_at - now())) * 1000))::float8 ELSE 0 END AS wait_ms
     FROM memory_extract_threads WHERE thread_id = $1`, [threadId]);
  if (!state) return { status: 'idle' };
  if (state.wait_ms > 0) return { status: 'later', delayMs: state.wait_ms };
  if (BigInt(state.pending_through) <= BigInt(state.done_through)) return { status: 'idle' };

  const { rows: source } = await space.query<{ id: string; sequence: string; author: string; body: string }>(
    `SELECT m.id::text, m.sequence::text, coalesce(u.display_name, d.name, m.author_type) AS author, m.body
     FROM memory_source_messages m
     LEFT JOIN users u ON u.id = m.author_id
     LEFT JOIN agent_installations i ON i.id = m.author_id LEFT JOIN agent_definitions d ON d.id = i.definition_id
     WHERE m.thread_id = $1 AND m.channel_id = $2 AND m.agent_session_id IS NULL AND m.sequence > $3::bigint
     ORDER BY m.sequence LIMIT 64`, [threadId, state.channel_id, state.done_through]);
  const messages: ExtractMessage[] = fitMessages(source.map(r => ({ id: r.id, speaker: r.author, text: r.body })));
  if (!messages.length) {
    await space.query('UPDATE memory_extract_threads SET done_through = pending_through, available_at = \'infinity\' WHERE thread_id = $1 AND done_through = $2::bigint', [threadId, state.done_through]);
    return { status: 'idle' };
  }
  const through = source[messages.length - 1]!.sequence;

  const { rowCount } = await space.query(
    `INSERT INTO memory_extract_budget(workspace_id, hour, used) VALUES ($1, date_trunc('hour', now()), 1)
     ON CONFLICT (workspace_id, hour) DO UPDATE SET used = memory_extract_budget.used + 1 WHERE memory_extract_budget.used < $2`,
    [state.workspace_id, hourlyCap]);
  if (!rowCount) {
    const { rows: [next] } = await space.query<{ wait_ms: number }>(
      `UPDATE memory_extract_threads SET available_at = date_trunc('hour', now()) + interval '1 hour' WHERE thread_id = $1
       RETURNING ceil(extract(epoch FROM (available_at - now())) * 1000)::float8 AS wait_ms`, [threadId]);
    return { status: 'capped', delayMs: next?.wait_ms };
  }

  const { rows: known } = await graph.query<{ name: string; text: string | null }>(
    `SELECT t.name, NULL AS text FROM kb.m_thread_topics l JOIN kb.m_topics t ON t.id = l.topic_id WHERE l.thread_id = $1
     UNION ALL SELECT NULL, f.text FROM kb.m_facts f WHERE f.thread_id = $1`, [threadId]);
  let extraction;
  try {
    const raw = await extract({ messages, topics: known.flatMap(k => k.name ? [k.name] : []), facts: known.flatMap(k => k.text ? [k.text] : []) }, AbortSignal.timeout(30_000));
    extraction = parseExtraction(raw, new Set(messages.map(m => m.id)));
  } catch {
    const { rows: [next] } = await space.query<{ wait_ms: number; attempts: number }>(
      `UPDATE memory_extract_threads SET attempts = attempts + 1,
         available_at = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'infinity' ELSE now() + least(interval '1 hour', interval '30 seconds' * power(2, attempts)) END
       WHERE thread_id = $1 RETURNING attempts, CASE WHEN isfinite(available_at) THEN ceil(extract(epoch FROM (available_at - now())) * 1000)::float8 END AS wait_ms`, [threadId]);
    return { status: 'retry', delayMs: next && next.attempts < MAX_ATTEMPTS ? next.wait_ms : undefined };
  }

  // Evidence must be in the store, so a fact always links to indexed messages.
  const cited = [...new Set(extraction.facts.flatMap(f => f.message_ids))];
  const { rows: indexed } = cited.length ? await graph.query<{ id: string }>('SELECT id FROM kb.m_messages WHERE id = ANY($1::text[])', [cited]) : { rows: [] };
  const present = new Set(indexed.map(r => r.id));
  const facts = extraction.facts.map(f => ({ ...f, message_ids: f.message_ids.filter(id => present.has(id)) })).filter(f => f.message_ids.length);
  const vectors = facts.length ? await embed(facts.map(f => f.text)) : [];

  const client = await graph.connect();
  try {
    await client.query('BEGIN');
    // The guard: only a newer run may replace this thread's topics and facts.
    const won = await client.query('UPDATE kb.m_threads SET extract_version = $2 WHERE id = $1 AND extract_version < $2 RETURNING workspace_id', [threadId, through]);
    if (won.rowCount) {
      const workspace = won.rows[0].workspace_id as string;
      await client.query("SELECT pgcontext.delete_points('kb_memory_facts', ARRAY(SELECT id FROM kb.m_facts WHERE thread_id = $1))", [threadId]);
      await client.query('DELETE FROM kb.m_facts WHERE thread_id = $1', [threadId]);
      await client.query('DELETE FROM kb.m_thread_topics WHERE thread_id = $1', [threadId]);
      const topicIds = new Map<string, string>();
      for (const name of extraction.topics) {
        const id = hash(workspace, topicKey(name));
        topicIds.set(topicKey(name), id);
        await client.query('INSERT INTO kb.m_topics(id, workspace_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [id, workspace, name]);
        await client.query('INSERT INTO kb.m_thread_topics(id, workspace_id, thread_id, topic_id, extract_version) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING',
          [hash(threadId, id), workspace, threadId, id, through]);
      }
      for (const [i, fact] of facts.entries()) {
        const id = hash(threadId, through, String(i));
        await client.query(`INSERT INTO kb.m_facts(id, workspace_id, thread_id, topic_id, kind, text, extract_version, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, workspace, threadId, fact.topic ? topicIds.get(topicKey(fact.topic)) ?? null : null, fact.kind, fact.text, through, JSON.stringify(vectors[i])]);
        for (const message of fact.message_ids) await client.query('INSERT INTO kb.m_fact_evidence(id, workspace_id, fact_id, message_id) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
          [hash(id, message), workspace, id, message]);
      }
      if (facts.length) await client.query("SELECT pgcontext.upsert_points('kb_memory_facts', ARRAY(SELECT id FROM kb.m_facts WHERE thread_id = $1))", [threadId]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }

  // Progress moves only from the value this run read. A newer message has already moved available_at again.
  await space.query(
    `UPDATE memory_extract_threads SET done_through = $2::bigint, attempts = 0, last_run_at = now(),
       available_at = CASE WHEN pending_through > $2::bigint THEN greatest(available_at, now() + interval '5 minutes') ELSE 'infinity' END
     WHERE thread_id = $1 AND done_through = $3::bigint`, [threadId, through, state.done_through]);
  return { status: 'done' };
}
