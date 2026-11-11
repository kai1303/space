import { assetDownloadPath, messagePath } from '@space/contracts';

// Messages come from the Graph RAG store (kb.m_messages, collection kb_memory, flag `knowledge`).
// Markdown file passages still come from kb.thread_messages (collection kb_markdown, graph space_threads).
// Either way, Space hydrates the evidence under the current requester and destination permissions.
async function rankMessages(index, context, query, vector, limit) {
  const { rows } = await index.query(`
    SELECT m.id, m.revision, m.thread_id, NULL::uuid AS asset_id, NULL::uuid AS source_message_id
    FROM pgcontext.query('kb_memory',$1::pgcontext.vector,$2,'text',$3) q
    JOIN kb.m_messages m ON m.id=q.source_key AND m.workspace_id=$4 AND m.knowledge
    ORDER BY q.score DESC, m.id`, [JSON.stringify(vector), query, Math.min(200, limit * 8), context.workspaceId]);
  return rows;
}
async function rankFiles(index, context, query, vector, limit) {
  const { rows } = await index.query(`
    SELECT m.id,m.revision,m.thread_id,m.asset_id,m.source_message_id FROM pgcontext.query('kb_markdown',$1::pgcontext.vector,$2,'text',$3) q
    JOIN kb.thread_messages m ON m.id=q.source_key AND m.workspace_id=$4 AND m.published
    WHERE m.asset_id IS NOT NULL AND EXISTS (SELECT 1 FROM graph.traverse('kb.thread_messages'::regclass,m.id,1,
      edge_types=>ARRAY['in_thread'],max_rows=>2) g WHERE g.depth=1 AND g.node_id=m.thread_id)
    ORDER BY q.score DESC,m.id`, [JSON.stringify(vector), query, Math.min(100, limit * 4), context.workspaceId]);
  return rows;
}

export async function searchThreads(index, source, context, query, vector, limit, filesOnly = false) {
  const ranked = filesOnly ? await rankFiles(index, context, query, vector, limit) : await rankMessages(index, context, query, vector, limit);
  async function hydrate(candidates) {
    if (!candidates.length) return [];
    const messages = candidates.filter(row => !row.asset_id);
    const files = [...new Set(candidates.map(row => row.asset_id).filter(Boolean))];
    const args = [context.workspaceId, context.requesterId, context.audience.channelId];
    const visibleMessages = messages.length ? (await source.query(
      'SELECT * FROM knowledge_visible_messages($1,$2,$3,$4::uuid[])',[...args,messages.slice(0,128).map(row => row.id)])).rows : [];
    const visibleFiles = files.length ? (await source.query(
      'SELECT * FROM knowledge_visible_files($1,$2,$3,$4::uuid[])',[...args,files])).rows : [];
    const permitted = new Map(visibleMessages.map(row => [row.id,row]));
    const attached = new Map(visibleFiles.map(row => [row.id,row]));
    return candidates.flatMap(candidate => {
      if (candidate.asset_id) {
        const file = attached.get(candidate.asset_id);
        return file && file.message_id === candidate.source_message_id && file.thread_id === candidate.thread_id
          ? [{...candidate, name:file.name}] : [];
      }
      const row = permitted.get(candidate.id);
      return row && String(row.search_revision)===String(candidate.revision) && row.thread_id===candidate.thread_id ? [row] : [];
    });
  }
  const matches = await hydrate(ranked);
  const lead = matches.slice(0,Math.ceil(limit/2));
  const threads = [...new Set(lead.map(row=>row.thread_id))];
  let neighbors = [];
  if (!filesOnly && threads.length && limit>1) {
    // Up to 5 other knowledge messages from each leading thread, through the in_thread links.
    const { rows } = await index.query(`
      SELECT n.id, n.thread_id, n.revision, NULL::uuid AS asset_id, NULL::uuid AS source_message_id
      FROM unnest($1::text[]) WITH ORDINALITY t(id,rank)
      CROSS JOIN LATERAL (SELECT m.id, m.thread_id, m.revision FROM kb.m_messages m
        WHERE m.thread_id=t.id AND m.workspace_id=$2 AND m.knowledge ORDER BY m.sequence LIMIT 5) n
      ORDER BY t.rank, n.id LIMIT 100`,[threads,context.workspaceId]);
    neighbors = await hydrate(rows);
  }
  const hits = new Map();
  for (const row of [...lead,...neighbors,...matches]) {
    const label = row.asset_id ? row.name : 'Message in #'+row.channel_name;
    const url = row.asset_id ? assetDownloadPath(row.asset_id) : messagePath(row.channel_id,row.id);
    hits.set(row.id,{ref:{connectionId:context.connectionId,recordId:(row.asset_id ? 'file/' : 'message/')+row.id},title:label,evidence:row.body,
      citation:{label,url}});
    if (hits.size===limit) break;
  }
  return [...hits.values()];
}
