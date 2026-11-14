CREATE OR REPLACE VIEW graph_source_messages WITH (security_barrier=true) AS
  SELECT m.id, m.workspace_id, m.channel_id, m.thread_id, m.agent_session_id,
         coalesce(m.user_id, m.installation_id) AS author_id, m.author_type,
         m.sequence, m.search_revision, m.created_at, left(m.text, 8000) AS body,
         c.memory_enabled AS memory,
         (m.author_type = 'human' AND m.agent_session_id IS NULL) AS knowledge
  FROM channels c JOIN messages m ON m.channel_id = c.id
  WHERE c.kind = 'channel' AND c.archived_at IS NULL
    AND m.deleted_at IS NULL AND m.retained_at IS NULL AND btrim(m.text) <> ''
    AND (c.memory_enabled OR (m.author_type = 'human' AND m.agent_session_id IS NULL));

-- Keep the Markdown worker’s existing source view scoped to its configured channels.
-- File-only posts still supply evidence for explicitly indexed Markdown passages.
CREATE OR REPLACE FUNCTION knowledge_visible_messages(w uuid, requester uuid, destination uuid, ids uuid[])
 RETURNS TABLE(id uuid,channel_id uuid,thread_id uuid,body text,channel_name text,search_revision bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
 SELECT m.id,m.channel_id,m.thread_id,left(m.text,8000),src.name,m.search_revision
 FROM messages m JOIN channels src ON (src.workspace_id,src.id)=(m.workspace_id,m.channel_id)
 JOIN channels dest ON dest.workspace_id=w AND dest.id=destination
 JOIN workspace_members actor ON actor.workspace_id=w AND actor.user_id=requester AND actor.active
 WHERE m.workspace_id=w AND m.id=ANY(ids) AND cardinality(ids)<=128
 AND src.kind='channel' AND src.archived_at IS NULL AND m.agent_session_id IS NULL
 AND m.author_type='human' AND m.deleted_at IS NULL AND m.retained_at IS NULL
 AND (btrim(m.text)<>'' OR (jsonb_array_length(m.attachments)>0 AND EXISTS (
   SELECT 1 FROM knowledge_thread_channels k WHERE k.workspace_id=w AND k.channel_id=m.channel_id AND k.index_markdown
 )))
 AND EXISTS(SELECT 1 FROM channel_members WHERE channel_id=dest.id AND user_id=requester)
 AND EXISTS(SELECT 1 FROM channel_members WHERE channel_id=src.id AND user_id=requester)
 AND (NOT src.private OR dest.private)
 AND NOT EXISTS(SELECT 1 FROM channel_members cm JOIN workspace_members viewer
      ON viewer.workspace_id=w AND viewer.user_id=cm.user_id AND viewer.active
      WHERE cm.channel_id=dest.id AND (src.private OR viewer.guest_type<>'none')
      AND NOT EXISTS(SELECT 1 FROM channel_members allowed WHERE allowed.channel_id=src.id AND allowed.user_id=viewer.user_id))
$$;
REVOKE ALL ON FUNCTION knowledge_visible_messages(uuid,uuid,uuid,uuid[]) FROM PUBLIC;
-- Pin relations in the owning Space schema (also works in isolated test schemas).
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION knowledge_visible_messages(uuid,uuid,uuid,uuid[]) SET search_path=pg_catalog,%I,pg_temp',current_schema());
END $$;
