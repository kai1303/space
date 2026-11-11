import { assetDownloadPath, messagePath } from '@space/contracts';

// Rank individual messages, verify their graph edge, then hydrate the evidence
// from Space under the current requester and destination permissions.
export async function searchThreads(index, source, context, query, vector, limit, filesOnly = false) {
  const ranked = await index.query(`
    SELECT m.id,m.revision,m.thread_id,m.asset_id,m.source_message_id,m.body FROM pgcontext.query($6,$1::pgcontext.vector,$2,'text',$3) q
    JOIN kb.thread_messages m ON m.id=q.source_key AND m.workspace_id=$4 AND m.published
    WHERE (NOT $5::boolean OR m.asset_id IS NOT NULL) AND EXISTS (SELECT 1 FROM graph.traverse('kb.thread_messages'::regclass,m.id,1,
      edge_types=>ARRAY['in_thread'],max_rows=>2) g WHERE g.depth=1 AND g.node_id=m.thread_id)
    ORDER BY q.score DESC,m.id`,[JSON.stringify(vector),query,Math.min(100,limit*4),context.workspaceId,filesOnly,filesOnly ? 'kb_markdown' : 'kb_threads']);
  async function hydrate(candidates) {
    if (!candidates.length) return [];
    const messages = candidates.filter(row => !row.asset_id);
    const files = [...new Set(candidates.map(row => row.asset_id).filter(Boolean))];
    const args = [context.workspaceId, context.requesterId, context.audience.channelId];
    const visibleMessages = messages.length ? (await source.query(
      'SELECT * FROM knowledge_visible_messages($1,$2,$3,$4::uuid[])',[...args,messages.map(row => row.id)])).rows : [];
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
      return row && row.search_revision===candidate.revision && row.thread_id===candidate.thread_id ? [row] : [];
    });
  }
  const matches = await hydrate(ranked.rows);
  const lead = matches.slice(0,Math.ceil(limit/2));
  const threads = [...new Set(lead.map(row=>row.thread_id))];
  let neighbors = [];
  if (!filesOnly && threads.length && limit>1) {
    const { rows } = await index.query(`
      SELECT m.id,m.thread_id,m.revision,m.asset_id,m.source_message_id,m.body FROM unnest($1::text[]) WITH ORDINALITY t(id,rank)
      CROSS JOIN LATERAL graph.traverse('kb.threads'::regclass,t.id,1,edge_types=>ARRAY['in_thread'],
        direction:='in',max_rows=>5) g
      JOIN kb.thread_messages m ON m.id=g.node_id AND m.thread_id=t.id AND m.workspace_id=$2
      WHERE g.depth=1 AND m.published ORDER BY t.rank,m.id LIMIT 100`,[threads,context.workspaceId]);
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
