import { lsnToVersion, planChange } from './graph-plan.mjs';
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
    for (const table of ['m_channels', 'm_sessions', 'm_messages', 'm_knowledge', 'm_attachments']) {
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
    for (const table of ['m_attachments', 'm_knowledge', 'm_sessions', 'm_channels']) await client.query(`DELETE FROM kb.${table} WHERE version=-1`);
    await client.query(`DELETE FROM kb.m_threads t WHERE NOT EXISTS (SELECT 1 FROM kb.m_messages m WHERE m.thread_id=t.id)
      AND NOT EXISTS (SELECT 1 FROM kb.m_attachment_messages a WHERE a.thread_id=t.id)
      AND NOT EXISTS (SELECT 1 FROM kb.m_sessions s WHERE s.thread_id=t.id)
      AND NOT EXISTS (SELECT 1 FROM kb.m_knowledge_evidence e WHERE e.thread_id=t.id)`);
    await client.query('DELETE FROM kb.m_people p WHERE NOT EXISTS (SELECT 1 FROM kb.m_messages m WHERE m.author_id=p.id)');
    await client.query(`DELETE FROM kb.m_topics t WHERE NOT EXISTS (SELECT 1 FROM kb.m_thread_topics l WHERE l.topic_id=t.id)
      AND NOT EXISTS (SELECT 1 FROM kb.m_facts f WHERE f.topic_id=t.id)`);
    await client.query('DELETE FROM kb.graph_position WHERE slot=$1', [slot]);
    await client.query('INSERT INTO kb.graph_position(slot,lsn) VALUES($1,$2::pg_lsn)', [slot, position]);
  });
}

// Channel rows copied before topic and description were watched hold NULL. Copy the current text once,
// in bounded pages, before the stream starts; later changes arrive through the stream. Returns rows filled.
export async function fillChannelText(index, source, page = 500) {
  let after = '', filled = 0;
  for (;;) {
    const { rows } = await index.query(
      'SELECT id FROM kb.m_channels WHERE (topic IS NULL OR description IS NULL) AND id>$1 ORDER BY id LIMIT $2', [after, page]);
    if (!rows.length) break;
    const { rows: found } = await source.query(
      "SELECT id::text, topic, description FROM channels WHERE kind='channel' AND id=ANY($1::uuid[])", [rows.map(r => r.id)]);
    if (found.length) {
      const result = await index.query(
        `UPDATE kb.m_channels c SET topic=coalesce(c.topic,s.topic),description=coalesce(c.description,s.description)
         FROM unnest($1::text[],$2::text[],$3::text[]) AS s(id,topic,description) WHERE c.id=s.id`,
        [found.map(r => r.id), found.map(r => r.topic), found.map(r => r.description)]);
      filled += result.rowCount;
    }
    after = rows.at(-1).id;
    if (rows.length < page) break;
  }
  return filled;
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

// A post can gain or lose files without qualifying for text indexing. Both its
// current and previously projected file IDs must be reconciled in that case.
export async function attachmentChanges(index, source, batch) {
  const messages = new Map(), assets = new Map();
  const touch = (id, lsn) => {
    if (!assets.has(id) || lsnToVersion(lsn) > lsnToVersion(assets.get(id))) assets.set(id, lsn);
  };
  for (const { table, row, lsn } of batch) {
    if (table === 'assets') touch(row.id, lsn);
    if (table === 'messages') messages.set(row.id, { channel: row.channel_id, lsn });
  }
  if (messages.size) {
    const ids = [...messages.keys()];
    const [live, stored] = await Promise.all([
      source.query(`SELECT a.id, a.message_id FROM graph_source_attachments a
        JOIN unnest($1::uuid[], $2::uuid[]) AS m(channel_id,id) ON a.channel_id=m.channel_id AND a.message_id=m.id`,
        [[...messages.values()].map(m => m.channel), ids]),
      index.query('SELECT id,message_id FROM kb.m_attachments WHERE message_id=ANY($1::text[])', [ids]),
    ]);
    for (const a of [...live.rows, ...stored.rows]) touch(a.id, messages.get(a.message_id).lsn);
  }
  if (!assets.size) return [];
  const { rows } = await source.query(
    'SELECT id,workspace_id,channel_id,thread_id,message_id,name,type,size FROM graph_source_attachments WHERE id=ANY($1::uuid[])',
    [[...assets.keys()]]);
  const found = new Map(rows.map(row => [row.id, row]));
  return [...assets].map(([id, lsn]) => ({ table: 'graph_source_attachments', lsn,
    op: found.has(id) ? 'insert' : 'delete', row: found.get(id) ?? { id } }));
}

// Archiving or restoring a channel changes visibility for all its attachments.
// Independent bounded pages are replayable until the switch's WAL is checkpointed.
export async function resyncChannelAttachments(index, source, channelId, version) {
  let after = null;
  for (;;) {
    const { rows } = await source.query(
      `SELECT id,workspace_id,channel_id,thread_id,message_id,name,type,size FROM graph_source_attachments
       WHERE channel_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 200`, [channelId, after]);
    if (!rows.length) break;
    const ops = [];
    for (const row of rows) ops.push(...await planChange({ table: 'graph_source_attachments', op: 'insert', row }, version));
    await applyOps(index, ops);
    after = rows.at(-1).id;
    if (rows.length < 200) break;
  }
  let cursor = '';
  for (;;) {
    const { rows } = await index.query(
      'SELECT id FROM kb.m_attachments WHERE channel_id=$1 AND id>$2 ORDER BY id LIMIT 200', [channelId, cursor]);
    if (!rows.length) break;
    const { rows: live } = await source.query(
      'SELECT id FROM graph_source_attachments WHERE channel_id=$1 AND id=ANY($2::uuid[])', [channelId, rows.map(r => r.id)]);
    const keep = new Set(live.map(r => r.id));
    const gone = rows.filter(r => !keep.has(r.id)).map(r => r.id);
    if (gone.length) await applyOps(index, [{
      text: 'DELETE FROM kb.m_attachments WHERE channel_id=$1 AND id=ANY($2::text[]) AND version<=$3::bigint',
      values: [channelId, gone, String(version)],
    }]);
    cursor = rows.at(-1).id;
    if (rows.length < 200) break;
  }
}
