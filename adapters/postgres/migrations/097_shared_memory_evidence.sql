-- A channel note may be shared only while every cited message is live and shared in that channel.
CREATE VIEW shared_knowledge_notes WITH (security_barrier=true) AS
 SELECT n.* FROM knowledge_notes n
 WHERE cardinality(n.evidence) = (
   SELECT count(*) FROM messages m WHERE m.channel_id = n.channel_id AND m.id = ANY(n.evidence)
     AND m.agent_session_id IS NULL AND m.deleted_at IS NULL AND m.retained_at IS NULL
 );

CREATE OR REPLACE VIEW knowledge_note_sources WITH (security_barrier=true) AS
 SELECT n.workspace_id, n.channel_id, n.id, n.kind, n.title, n.content, n.evidence, n.revision, c.name AS channel_name
 FROM shared_knowledge_notes n JOIN channels c ON c.id = n.channel_id AND c.workspace_id = n.workspace_id
 WHERE n.removed_at IS NULL AND c.kind = 'channel' AND c.archived_at IS NULL AND c.knowledge_enabled;

CREATE OR REPLACE FUNCTION memory_visible_messages(w uuid, requester uuid, destination uuid, ids uuid[])
 RETURNS TABLE(id uuid, channel_id uuid, thread_id uuid, agent_session_id uuid, author_id uuid, author_type text, body text, sequence bigint, search_revision bigint, created_at timestamptz)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
 SELECT m.id, m.channel_id, m.thread_id, m.agent_session_id, m.author_id, m.author_type, m.body, m.sequence, m.search_revision, m.created_at
 FROM memory_source_messages m JOIN channels dest ON dest.id = destination AND dest.workspace_id = w
 WHERE m.workspace_id = w AND m.channel_id = destination AND m.agent_session_id IS NULL AND m.id = ANY(ids) AND cardinality(ids) <= 128
 AND EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w AND wm.user_id = requester AND wm.active)
 AND EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id = destination AND cm.user_id = requester)
$$;
REVOKE ALL ON FUNCTION memory_visible_messages(uuid,uuid,uuid,uuid[]) FROM PUBLIC;
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION memory_visible_messages(uuid,uuid,uuid,uuid[]) SET search_path=pg_catalog,%I,pg_temp', current_schema());
END $$;
