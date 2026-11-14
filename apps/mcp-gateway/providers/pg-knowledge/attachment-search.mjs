import { assetDownloadPath } from '@space/contracts';

const attachmentFields = ['workspace_id', 'channel_id', 'thread_id', 'message_id', 'name', 'type', 'size'];

export async function searchAttachments(index, source, context, query, limit) {
  const { rows: candidates } = await index.query(`
    WITH documents AS (
      SELECT id, workspace_id, channel_id, thread_id, message_id, name, type, size,
        to_tsvector('simple', translate(name || ' ' || type, '._/-', '    ')) AS document
      FROM kb.m_attachments WHERE workspace_id = $1
    ), terms AS (
      SELECT plainto_tsquery('simple', translate($2, '._/-', '    ')) AS query
    )
    SELECT id, workspace_id, channel_id, thread_id, message_id, name, type, size
    FROM documents CROSS JOIN terms WHERE id = lower($2) OR document @@ query
    ORDER BY (id = lower($2)) DESC, (lower(name) = lower($2)) DESC, ts_rank(document, query) DESC, id
    LIMIT $3`, [context.workspaceId, query.trim(), Math.min(100, limit * 4)]);
  if (!candidates.length) return [];

  const { rows } = await source.query('SELECT * FROM knowledge_visible_attachments($1,$2,$3,$4::uuid[])',
    [context.workspaceId, context.requesterId, context.audience.channelId, candidates.map(row => row.id)]);
  const visible = new Map(rows.map(row => [row.id, row]));
  const hits = [];
  for (const candidate of candidates) {
    const file = visible.get(candidate.id);
    // A stale match can reveal a former filename even when the asset itself is still visible.
    if (!file || !attachmentFields.every(key => file[key] === candidate[key])) continue;
    hits.push({
      ref: { connectionId: context.connectionId, recordId: 'attachment/' + file.id },
      title: file.name, evidence: `${file.name} (${file.type}, ${file.size} bytes)`,
      citation: { label: file.name, url: assetDownloadPath(file.id) },
    });
    if (hits.length === limit) break;
  }
  return hits;
}
