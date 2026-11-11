import { createPool } from '@space/postgres/database';
import type { MemoryFact } from '@space/contracts';
import type { MemoryIndex, MemoryScope } from '@space/postgres/layered-memory';

// Ranks messages by meaning in the Graph RAG store (knowledge database). It only proposes ids inside the
// requested scope; layered-memory reads the text from Space and re-checks the scope there.
// MEMORY_GRAPH_URL is a read-only role on the knowledge database. Without it, memory reads skip ranking.
const CANDIDATES = 200;

async function embed(text: string, signal: AbortSignal): Promise<number[]> {
  const response = await fetch(`${process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434'}/api/embed`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ model: 'all-minilm:22m', input: [text] }),
  });
  if (!response.ok) throw new Error('memory_embedding_failed');
  const vector = (await response.json() as { embeddings?: number[][] }).embeddings?.[0];
  if (!Array.isArray(vector) || vector.length !== 384 || !vector.every(Number.isFinite)) throw new Error('memory_embedding_invalid');
  return vector;
}

export function graphMemoryIndex(url = process.env.MEMORY_GRAPH_URL): MemoryIndex | undefined {
  if (!url) return undefined;
  const pool = createPool(url);
  return {
    async related(scope: MemoryScope, query: string, limit: number) {
      const signal = AbortSignal.timeout(4000);
      const vector = JSON.stringify(await embed(query, signal));
      // Rank the store first (bounded), then keep only messages inside the scope.
      const { rows } = await pool.query<{ id: string }>(`
        SELECT m.id FROM pgcontext.query('kb_memory', $1::pgcontext.vector, $2, 'text', $3) q
        JOIN kb.m_messages m ON m.id = q.source_key AND m.memory
        JOIN kb.m_threads t ON t.id = m.thread_id AND t.channel_id = $4
        WHERE ($5::text IS NULL OR m.thread_id = $5)
          AND CASE WHEN $6::text IS NOT NULL
                THEN EXISTS (SELECT 1 FROM kb.m_session_turns s WHERE s.message_id = m.id AND s.session_id = $6)
                ELSE NOT EXISTS (SELECT 1 FROM kb.m_session_turns s WHERE s.message_id = m.id) END
        ORDER BY q.score DESC, m.id LIMIT $7`,
        [vector, query, CANDIDATES, scope.channelId, scope.threadId ?? null, scope.sessionId ?? null, limit]);
      return rows.map(row => row.id);
    },
    async threadKnowledge(scope) {
      const { rows: topics } = await pool.query<{ name: string }>(`
        SELECT t.name FROM kb.m_thread_topics l JOIN kb.m_topics t ON t.id = l.topic_id
        JOIN kb.m_threads th ON th.id = l.thread_id AND th.channel_id = $2
        WHERE l.thread_id = $1 ORDER BY t.name LIMIT 5`, [scope.threadId, scope.channelId]);
      const { rows: facts } = await pool.query<MemoryFact>(`
        SELECT f.id, f.kind, f.text, t.name AS topic, coalesce(array_agg(e.message_id) FILTER (WHERE e.message_id IS NOT NULL), '{}') AS message_ids
        FROM kb.m_facts f JOIN kb.m_threads th ON th.id = f.thread_id AND th.channel_id = $2
        LEFT JOIN kb.m_topics t ON t.id = f.topic_id LEFT JOIN kb.m_fact_evidence e ON e.fact_id = f.id
        WHERE f.thread_id = $1 GROUP BY f.id, t.name ORDER BY f.id LIMIT 8`, [scope.threadId, scope.channelId]);
      return { topics: topics.map(t => t.name), facts };
    },
  };
}
