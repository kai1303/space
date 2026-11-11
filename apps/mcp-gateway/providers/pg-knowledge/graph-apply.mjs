import { planChange } from './graph-plan.mjs';
import { snapshot } from './graph-source.mjs';

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
  await index.query("SELECT * FROM graph.build_graph('space_knowledge', true)");
  await index.query('UPDATE kb.graph_position SET published_lsn=$2::pg_lsn WHERE slot=$1 AND published_lsn<$2::pg_lsn', [slot, position]);
}

// Clears the graph and refills it from one Space snapshot in a single transaction, so readers keep
// the old graph until the new one is complete. `position` is the slot's confirmed LSN taken after the
// slot existed; everything the snapshot may have missed is later in the stream.
export function rebuild(index, source, lookup, slot, position) {
  return inTransaction(index, async client => {
    await client.query('DELETE FROM kb.g_channels');
    await client.query('DELETE FROM kb.graph_position WHERE slot=$1', [slot]);
    let ops = [];
    for await (const change of snapshot(source)) {
      ops.push(...await planChange(change, SNAPSHOT_VERSION, lookup));
      if (ops.length >= 500) { await run(client, ops); ops = []; }
    }
    await run(client, ops);
    await client.query('INSERT INTO kb.graph_position(slot,lsn) VALUES($1,$2::pg_lsn)', [slot, position]);
  });
}
