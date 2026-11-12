import { planChange } from './graph-plan.mjs';
import { snapshotPages } from './graph-source.mjs';

const SNAPSHOT_VERSION = 1n;
const run = async (client, ops) => { for (const op of ops) await client.query(op.text, op.values); };

async function inTransaction(index, work) {
  const client = await index.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function planAll(changes, version, lookup) {
  await lookup.prefetch(changes);
  const ops = [];
  for (const change of changes) ops.push(...await planChange(change, typeof version === 'function' ? version(change) : version, lookup));
  return ops;
}

export async function savedPosition(index, slot) {
  const { rows } = await index.query('SELECT lsn::text AS lsn FROM kb.graph_position WHERE slot=$1', [slot]);
  return rows[0]?.lsn ?? null;
}

// The graph writes and the new position commit together. The position only moves forward.
export function applyOps(index, ops, position) {
  return inTransaction(index, async client => {
    await run(client, ops);
    if (position) await client.query(
      `INSERT INTO kb.graph_position(slot,lsn) VALUES($1,$2::pg_lsn)
       ON CONFLICT (slot) DO UPDATE SET lsn=EXCLUDED.lsn WHERE kb.graph_position.lsn<EXCLUDED.lsn`,
      [position.slot, position.lsn]);
  });
}

export async function publishNeeded(index, slot) {
  const { rows } = await index.query('SELECT lsn>published_lsn AS dirty FROM kb.graph_position WHERE slot=$1', [slot]);
  return Boolean(rows[0]?.dirty);
}

// Builds the pgGraph graph from the tables and records which position it reflects.
// pgGraph refuses a build while a source write is open, so callers run this one-at-a-time with graph writes.
export async function publish(index, slot) {
  const position = await savedPosition(index, slot);
  if (!position) return;
  await index.query("SELECT * FROM graph.build_graph('space_memory', true)");
  await index.query('UPDATE kb.graph_position SET published_lsn=$2::pg_lsn WHERE slot=$1 AND published_lsn<$2::pg_lsn', [slot, position]);
}

// Refresh in place so surviving messages retain their extracted facts, evidence and thread progress.
// A single transaction hides the stale marks and resets the publish watermark only after the full snapshot.
export function rebuild(index, source, slot, position) {
  return inTransaction(index, async client => {
    for (const table of ['m_channels', 'm_sessions', 'm_messages', 'm_knowledge']) {
      await client.query(`UPDATE kb.${table} SET version=-1`);
    }
    await client.query('DELETE FROM kb.m_session_turns');
    for await (const { changes, lookup } of snapshotPages(source)) {
      await run(client, await planAll(changes, SNAPSHOT_VERSION, lookup));
    }
    // Remove absent messages before their parents, letting the usual delete path clean vectors and counts.
    let cursor = '';
    for (;;) {
      const { rows } = await client.query('SELECT id FROM kb.m_messages WHERE version=-1 AND id>$1 ORDER BY id LIMIT 200', [cursor]);
      for (const row of rows) await run(client, await planChange({ table: 'messages', op: 'delete', row }, SNAPSHOT_VERSION));
      if (rows.length < 200) break;
      cursor = rows.at(-1).id;
    }
    for (const table of ['m_knowledge', 'm_sessions', 'm_channels']) await client.query(`DELETE FROM kb.${table} WHERE version=-1`);
    await client.query(`DELETE FROM kb.m_threads t WHERE NOT EXISTS (SELECT 1 FROM kb.m_messages m WHERE m.thread_id=t.id)
      AND NOT EXISTS (SELECT 1 FROM kb.m_sessions s WHERE s.thread_id=t.id)
      AND NOT EXISTS (SELECT 1 FROM kb.m_knowledge_evidence e WHERE e.thread_id=t.id)`);
    await client.query('DELETE FROM kb.m_people p WHERE NOT EXISTS (SELECT 1 FROM kb.m_messages m WHERE m.author_id=p.id)');
    await client.query(`DELETE FROM kb.m_topics t WHERE NOT EXISTS (SELECT 1 FROM kb.m_thread_topics l WHERE l.topic_id=t.id)
      AND NOT EXISTS (SELECT 1 FROM kb.m_facts f WHERE f.topic_id=t.id)`);
    await client.query('DELETE FROM kb.graph_position WHERE slot=$1', [slot]);
    await client.query('INSERT INTO kb.graph_position(slot,lsn) VALUES($1,$2::pg_lsn)', [slot, position]);
  });
}

// A channel's switches changed. Bring its messages in line with the source view, in bounded pages:
// first add or refresh what the view shows, then delete indexed messages the view no longer shows.
export async function resyncChannel(index, source, lookup, channelId, version) {
  let after = null;
  for (;;) {
    const { rows } = await source.query(
      `SELECT id::text, workspace_id::text, channel_id::text FROM graph_source_messages
       WHERE channel_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 200`, [channelId, after]);
    if (!rows.length) break;
    const ops = await planAll(rows.map(row => ({ table: 'messages', op: 'insert', row })), version, lookup);
    await applyOps(index, ops);
    after = rows.at(-1).id;
    if (rows.length < 200) break;
  }
  let cursor = '';
  for (;;) {
    const { rows } = await index.query(
      `SELECT m.id FROM kb.m_messages m JOIN kb.m_threads t ON t.id=m.thread_id
       WHERE t.channel_id=$1 AND m.id>$2 ORDER BY m.id LIMIT 200`, [channelId, cursor]);
    if (!rows.length) break;
    const { rows: live } = await source.query(
      'SELECT id::text FROM graph_source_messages WHERE channel_id=$1 AND id=ANY($2::uuid[])', [channelId, rows.map(r => r.id)]);
    const keep = new Set(live.map(r => r.id));
    const gone = rows.filter(r => !keep.has(r.id)).map(r => ({ table: 'messages', op: 'delete', row: { id: r.id, channel_id: channelId } }));
    if (gone.length) await applyOps(index, await planAll(gone, version, lookup));
    cursor = rows.at(-1).id;
    if (rows.length < 200) break;
  }
}
