-- The knowledge graph proposes thread ids; this function decides which thread memories a requester may read.
-- Only the destination channel's own memories are returned, and only while its memory switch is on.
CREATE FUNCTION memory_visible_summaries(w uuid, requester uuid, destination uuid, ids uuid[])
 RETURNS TABLE(thread_id uuid, revision integer, summary text, created_at timestamptz, channel_name text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
 SELECT DISTINCT ON (m.thread_id) m.thread_id, m.revision, m.summary, m.created_at, dest.name
 FROM memory_revisions m JOIN channels dest ON dest.id = m.channel_id
 WHERE dest.id = destination AND dest.workspace_id = w AND dest.kind = 'channel' AND dest.memory_enabled AND dest.archived_at IS NULL
 AND m.session_id IS NULL AND m.thread_id = ANY(ids) AND cardinality(ids) <= 128
 AND EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w AND wm.user_id = requester AND wm.active)
 AND EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id = dest.id AND cm.user_id = requester)
 ORDER BY m.thread_id, m.revision DESC
$$;
REVOKE ALL ON FUNCTION memory_visible_summaries(uuid,uuid,uuid,uuid[]) FROM PUBLIC;
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION memory_visible_summaries(uuid,uuid,uuid,uuid[]) SET search_path=pg_catalog,%I,pg_temp', current_schema());
END $$;
