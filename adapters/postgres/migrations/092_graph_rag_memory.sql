-- Graph RAG memory: the Space side. The knowledge database reads message text through these views and
-- memory readers check access through memory_visible_messages().

-- Source of message text for memory. Includes agent replies and agent session turns.
CREATE VIEW memory_source_messages WITH (security_barrier=true) AS
  SELECT m.id, m.workspace_id, m.channel_id, m.thread_id, m.agent_session_id,
         coalesce(m.user_id, m.installation_id) AS author_id, m.author_type,
         m.sequence, m.search_revision, m.created_at, left(m.text, 8000) AS body
  FROM channels c JOIN messages m ON m.channel_id = c.id
  WHERE c.kind = 'channel' AND c.archived_at IS NULL AND c.memory_enabled
    AND m.deleted_at IS NULL AND m.retained_at IS NULL AND btrim(m.text) <> '';

-- One message index for memory and knowledge thread search.
-- memory: the channel has memory on. knowledge: a human message in a thread-search channel.
CREATE VIEW graph_source_messages WITH (security_barrier=true) AS
  SELECT m.id, m.workspace_id, m.channel_id, m.thread_id, m.agent_session_id,
         coalesce(m.user_id, m.installation_id) AS author_id, m.author_type,
         m.sequence, m.search_revision, m.created_at, left(m.text, 8000) AS body,
         c.memory_enabled AS memory,
         (k.channel_id IS NOT NULL AND m.author_type = 'human' AND m.agent_session_id IS NULL) AS knowledge
  FROM channels c JOIN messages m ON m.channel_id = c.id
  LEFT JOIN knowledge_thread_channels k ON k.channel_id = c.id AND k.workspace_id = c.workspace_id
  WHERE c.kind = 'channel' AND c.archived_at IS NULL
    AND m.deleted_at IS NULL AND m.retained_at IS NULL AND btrim(m.text) <> ''
    AND (c.memory_enabled OR (k.channel_id IS NOT NULL AND m.author_type = 'human' AND m.agent_session_id IS NULL));

-- Memory never crosses channels, so the requester must belong to the message's own channel.
CREATE FUNCTION memory_visible_messages(w uuid, requester uuid, destination uuid, ids uuid[])
 RETURNS TABLE(id uuid, channel_id uuid, thread_id uuid, agent_session_id uuid, author_id uuid, author_type text, body text, sequence bigint, search_revision bigint, created_at timestamptz)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
 SELECT m.id, m.channel_id, m.thread_id, m.agent_session_id, m.author_id, m.author_type, m.body, m.sequence, m.search_revision, m.created_at
 FROM memory_source_messages m JOIN channels dest ON dest.id = destination AND dest.workspace_id = w
 WHERE m.workspace_id = w AND m.channel_id = destination AND m.id = ANY(ids) AND cardinality(ids) <= 128
 AND EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w AND wm.user_id = requester AND wm.active)
 AND EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id = destination AND cm.user_id = requester)
$$;
REVOKE ALL ON FUNCTION memory_visible_messages(uuid,uuid,uuid,uuid[]) FROM PUBLIC;
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION memory_visible_messages(uuid,uuid,uuid,uuid[]) SET search_path=pg_catalog,%I,pg_temp', current_schema());
END $$;
