// Copies live Space notes into kb.notes. Reads go through knowledge_note_sources, so removed notes,
// archived channels and switched-off channels drop out on the next sync or reconcile.
const pageSize = 32;
const body = row => row.title + '\n' + row.content;

export async function syncNotes(source, index, workspace, ids, embed) {
  if (!ids.length) return;
  const { rows } = await source.query('SELECT id::text AS id, channel_id, revision, title, content FROM knowledge_note_sources WHERE workspace_id=$1 AND id=ANY($2::uuid[])', [workspace, ids]);
  const { rows: existing } = await index.query('SELECT id, revision FROM kb.notes WHERE workspace_id=$1 AND id=ANY($2::text[])', [workspace, ids]);
  const old = new Map(existing.map(row => [row.id, row.revision]));
  const live = new Set(rows.map(row => row.id));
  const removed = existing.filter(row => !live.has(row.id)).map(row => row.id);
  const changed = rows.filter(row => old.get(row.id) !== row.revision);
  if (!removed.length && !changed.length) return;
  const vectors = changed.length ? await embed(changed.map(body)) : [];
  const client = await index.connect();
  try {
    await client.query('BEGIN');
    if (removed.length) {
      await client.query("SELECT pgcontext.delete_points('kb_notes',$1::text[])", [removed]);
      await client.query('DELETE FROM kb.notes WHERE workspace_id=$1 AND id=ANY($2::text[])', [workspace, removed]);
    }
    for (const [i, row] of changed.entries()) {
      await client.query(`INSERT INTO kb.notes(id,workspace_id,channel_id,revision,body,embedding) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (id) DO UPDATE SET revision=EXCLUDED.revision, body=EXCLUDED.body, embedding=EXCLUDED.embedding
        WHERE kb.notes.revision <= EXCLUDED.revision`, [row.id, workspace, row.channel_id, row.revision, body(row), JSON.stringify(vectors[i])]);
    }
    if (changed.length) await client.query("SELECT pgcontext.upsert_points('kb_notes',$1::text[])", [changed.map(row => row.id)]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// Bounded pages in both directions: drop index rows that left the source, then add missing or older rows.
export async function reconcileNotes(source, index, workspace, embed) {
  let after = '';
  for (;;) {
    const { rows } = await index.query('SELECT id FROM kb.notes WHERE workspace_id=$1 AND id>$2 ORDER BY id LIMIT $3', [workspace, after, pageSize]);
    if (!rows.length) break;
    await syncNotes(source, index, workspace, rows.map(row => row.id), embed);
    after = rows.at(-1).id;
  }
  let cursor = null;
  for (;;) {
    const { rows } = await source.query('SELECT id::text AS id FROM knowledge_note_sources WHERE workspace_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3', [workspace, cursor, pageSize]);
    if (!rows.length) break;
    await syncNotes(source, index, workspace, rows.map(row => row.id), embed);
    cursor = rows.at(-1).id;
  }
}
