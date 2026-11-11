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
// pgGraph refuses a build while a source write is open, so callers run this one-at-a-time with applyOps.
export async function publish(index, slot) {
  const position = await savedPosition(index, slot);
  if (!position) return;
  await index.query("SELECT * FROM graph.build_graph('space_memory', true)");
  await index.query('UPDATE kb.graph_position SET published_lsn=$2::pg_lsn WHERE slot=$1 AND published_lsn<$2::pg_lsn', [slot, position]);
}

// Clears the graph and refills it from one Space snapshot in a single transaction, so readers keep
// the old graph until the new one is complete. `position` is the slot's confirmed LSN taken after the
// slot existed; everything the snapshot may have missed is later in the stream.
export function rebuild(index, source, lookup, slot, position) {
  return inTransaction(index, async client => {
    await client.query("SELECT pgcontext.delete_points('kb_memory', ARRAY(SELECT id FROM kb.m_messages))");
    await client.query("SELECT pgcontext.delete_points('kb_memory_facts', ARRAY(SELECT id FROM kb.m_facts))");
    await client.query('DELETE FROM kb.m_channels');
    await client.query('DELETE FROM kb.m_people');
    await client.query('DELETE FROM kb.m_topics');
    await client.query('DELETE FROM kb.graph_position WHERE slot=$1', [slot]);
    for await (const page of snapshotPages(source)) await run(client, await planAll(page, SNAPSHOT_VERSION, lookup));
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
