import { messagePath } from '@space/contracts';

// Rank indexed notes, then return only those Space still shows to this requester and destination,
// at the same revision that was indexed.
export async function searchNotes(index, source, context, query, vector, limit) {
  const ranked = await index.query(`
    SELECT n.id, n.revision FROM pgcontext.query('kb_notes',$1::pgcontext.vector,$2,'text',$3) q
    JOIN kb.notes n ON n.id=q.source_key AND n.workspace_id=$4
    ORDER BY q.score DESC, n.id`, [JSON.stringify(vector), query, Math.min(100, limit * 4), context.workspaceId]);
  if (!ranked.rows.length) return [];
  const { rows } = await source.query('SELECT * FROM knowledge_visible_notes($1,$2,$3,$4::uuid[])',
    [context.workspaceId, context.requesterId, context.audience.channelId, ranked.rows.map(row => row.id)]);
  const visible = new Map(rows.map(row => [row.id, row]));
  return ranked.rows.flatMap(candidate => {
    const note = visible.get(candidate.id);
    if (!note || note.revision !== candidate.revision) return [];
    const label = 'Note in #' + note.channel_name;
    return [{ ref: { connectionId: context.connectionId, recordId: 'note/' + note.id }, title: note.title, evidence: note.content,
      citation: { label, url: messagePath(note.channel_id, note.evidence[0]) } }];
  }).slice(0, limit);
}
