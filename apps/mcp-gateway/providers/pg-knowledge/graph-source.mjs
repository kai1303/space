// Reads from Space: message text through the source view, which thread and channel a message belongs to,
// and the finite snapshot used to start or rebuild the graph. Text is embedded here in batches with Ollama.
const EMBED_BATCH = 32;

export async function embed(bodies) {
  const response = await fetch('http://127.0.0.1:11434/api/embed', { method: 'POST',
    headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ model: 'all-minilm:22m', input: bodies }) });
  if (!response.ok) throw Error('Memory embedding failed');
  const vectors = (await response.json()).embeddings;
  if (vectors?.length !== bodies.length || !vectors.every(v => v.length === 384 && v.every(Number.isFinite))) throw Error('Invalid memory embeddings');
  return vectors;
}

export function sourceLookup(source, embedder = embed) {
  const hydrated = new Map();
  return {
    // Reads and embeds the messages named by a batch of changes. The planner then finds them with message().
    // The read happens after the change, so a newer text simply wins; the version guard orders the writes.
    async prefetch(changes) {
      hydrated.clear();
      const wanted = changes.filter(c => c.table === 'messages' && c.op !== 'delete' && c.row.channel_id);
      if (!wanted.length) return;
      const { rows } = await source.query(
        `SELECT m.id::text AS id, m.workspace_id::text AS workspace_id, m.channel_id::text AS channel_id, m.thread_id::text AS thread_id,
           m.agent_session_id::text AS agent_session_id, m.author_id::text AS author_id, m.author_type, m.sequence::text AS sequence,
           m.search_revision::text AS search_revision, m.created_at, m.body, m.memory, m.knowledge
         FROM graph_source_messages m
         JOIN unnest($1::uuid[], $2::uuid[]) AS w(channel_id, id) ON m.channel_id = w.channel_id AND m.id = w.id`,
        [wanted.map(c => c.row.channel_id), wanted.map(c => c.row.id)]);
      for (let i = 0; i < rows.length; i += EMBED_BATCH) {
        const page = rows.slice(i, i + EMBED_BATCH);
        const vectors = await embedder(page.map(row => row.body));
        page.forEach((row, n) => hydrated.set(row.id, { ...row, embedding: vectors[n] }));
      }
    },
    async message(_workspace, id) { return hydrated.get(id) ?? null; },
    async threadsOf(workspace, messageIds) {
      const { rows } = await source.query(
        `SELECT m.id::text AS message, m.thread_id::text AS thread, m.channel_id::text AS channel, c.kind
         FROM messages m JOIN channels c ON c.id=m.channel_id WHERE m.workspace_id=$1 AND m.id=ANY($2::uuid[])`,
        [workspace, messageIds]);
      return new Map(rows.map(row => [row.message, row]));
    },
    async channelsOfThreads(workspace, threadIds) {
      const { rows } = await source.query(
        `SELECT DISTINCT ON (m.thread_id) m.thread_id::text AS thread, m.channel_id::text AS channel, c.kind
         FROM messages m JOIN channels c ON c.id=m.channel_id WHERE m.workspace_id=$1 AND m.thread_id=ANY($2::uuid[])
         ORDER BY m.thread_id`,
        [workspace, threadIds]);
      return new Map(rows.map(row => [row.thread, row]));
    },
  };
}

const snapshotQueries = [
  ['channels', "SELECT id::text, workspace_id::text, name, private, kind, memory_enabled, knowledge_enabled, topic, description FROM channels WHERE kind='channel' ORDER BY id"],
  ['agent_sessions', 'SELECT id::text, workspace_id::text, origin_thread_id::text, title, state FROM agent_sessions ORDER BY id'],
  ['messages', 'SELECT id::text, workspace_id::text, channel_id::text FROM graph_source_messages ORDER BY channel_id, id'],
  ['knowledge_notes', 'SELECT id::text, workspace_id::text, channel_id::text, kind, title, evidence, revision, removed_at FROM knowledge_notes WHERE removed_at IS NULL ORDER BY id'],
];

// Pages of 500. Channels first so a real channel row is written before any placeholder for it.
export async function* snapshotPages(source) {
  const client = await source.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const lookup = sourceLookup(client);
    for (const [table, query] of snapshotQueries) {
      await client.query(`DECLARE graph_snapshot NO SCROLL CURSOR FOR ${query}`);
      for (;;) {
        const { rows } = await client.query('FETCH 500 FROM graph_snapshot');
        if (rows.length) yield { changes: rows.map(row => ({ table, op: 'insert', row })), lookup };
        if (rows.length < 500) break;
      }
      await client.query('CLOSE graph_snapshot');
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
