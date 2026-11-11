import { noteHit } from './notes-search.mjs';

const reference = /^note\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

// Knowledge that cites a message or a thread the given knowledge also cites: shared messages first, then shared
// threads. The graph only proposes ids; Space decides what this requester may see, and the starting knowledge
// must be visible too.
export async function searchRelated(index, source, context, recordId, limit) {
  const start = reference.exec(recordId)?.[1];
  if (!start) throw new Error('Invalid related reference');
  const { rows: near } = await index.query(
    `SELECT other.knowledge_id AS id,
            count(DISTINCT CASE WHEN other.message_id = mine.message_id THEN other.message_id END) AS shared_messages,
            count(DISTINCT other.thread_id) AS shared_threads
     FROM kb.m_knowledge_evidence mine JOIN kb.m_knowledge_evidence other
       ON other.thread_id = mine.thread_id AND other.knowledge_id <> mine.knowledge_id AND other.workspace_id = mine.workspace_id
     WHERE mine.knowledge_id = $1 AND mine.workspace_id = $2
     GROUP BY other.knowledge_id ORDER BY shared_messages DESC, shared_threads DESC, other.knowledge_id LIMIT $3`,
    [start, context.workspaceId, Math.min(100, limit * 4)]);
  if (!near.length) return [];
  const ids = [start, ...near.map(row => row.id)];
  const { rows } = await source.query('SELECT * FROM knowledge_visible_notes($1,$2,$3,$4::uuid[])',
    [context.workspaceId, context.requesterId, context.audience.channelId, ids]);
  const visible = new Map(rows.map(row => [row.id, row]));
  if (!visible.has(start)) return [];
  return near.flatMap(row => visible.has(row.id) ? [noteHit(context, visible.get(row.id))] : []).slice(0, limit);
}
