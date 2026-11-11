// Reads from Space: which thread and channel a message belongs to, and the finite snapshot used to
// start or rebuild the graph. Direct-message channels are returned with kind 'direct' so the planner drops them.
export function sourceLookup(source) {
  return {
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
  ['channels', "SELECT id::text, workspace_id::text, name, private, kind, knowledge_enabled FROM channels WHERE kind='channel' ORDER BY id"],
  ['knowledge_notes', 'SELECT id::text, workspace_id::text, channel_id::text, kind, title, evidence, revision, removed_at FROM knowledge_notes WHERE removed_at IS NULL ORDER BY id'],
  ['agent_sessions', 'SELECT id::text, workspace_id::text, origin_thread_id::text, title, state FROM agent_sessions ORDER BY id'],
];

// Channels come first, so a real channel row is written before any placeholder for it. Pages of 500.
export async function* snapshot(source) {
  const client = await source.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const [table, query] of snapshotQueries) {
      await client.query(`DECLARE graph_snapshot NO SCROLL CURSOR FOR ${query}`);
      for (;;) {
        const { rows } = await client.query('FETCH 500 FROM graph_snapshot');
        for (const row of rows) yield { table, op: 'insert', row };
        if (rows.length < 500) break;
      }
      await client.query('CLOSE graph_snapshot');
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
