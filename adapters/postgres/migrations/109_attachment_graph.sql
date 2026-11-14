-- A separate opt-in lets channel managers share file metadata independently of message or Markdown indexing.
CREATE TABLE knowledge_attachment_channels (
  workspace_id uuid NOT NULL, channel_id uuid NOT NULL,
  PRIMARY KEY (workspace_id, channel_id),
  FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id, id) ON DELETE CASCADE
);

CREATE VIEW graph_source_attachments WITH (security_barrier=true) AS
 SELECT a.id, m.workspace_id, m.channel_id, m.thread_id, m.id AS message_id, a.name, a.type, a.size
 FROM knowledge_attachment_channels k
 JOIN channels c ON (c.workspace_id,c.id)=(k.workspace_id,k.channel_id)
 JOIN assets a ON (a.workspace_id,a.channel_id)=(c.workspace_id,c.id)
 JOIN messages m ON (m.workspace_id,m.channel_id,m.id)=(a.workspace_id,a.channel_id,a.message_id)
 WHERE c.kind='channel' AND c.archived_at IS NULL AND m.author_type='human' AND m.agent_session_id IS NULL
 AND m.deleted_at IS NULL AND m.retained_at IS NULL AND a.status='ready' AND NOT a.encrypted
 AND m.attachments @> jsonb_build_array(jsonb_build_object('id',a.id));

-- Check the current posted file and the entire destination audience, independently of the graph index.
CREATE FUNCTION knowledge_visible_attachments(w uuid, requester uuid, destination uuid, ids uuid[])
 RETURNS TABLE(id uuid,workspace_id uuid,channel_id uuid,thread_id uuid,message_id uuid,name text,type text,size integer)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
 SELECT f.* FROM graph_source_attachments f
 JOIN channels src ON src.id=f.channel_id
 JOIN channels dest ON dest.workspace_id=w AND dest.id=destination AND dest.archived_at IS NULL
 JOIN workspace_members actor ON actor.workspace_id=w AND actor.user_id=requester AND actor.active
 WHERE f.workspace_id=w AND f.id=ANY(ids) AND cardinality(ids)<=128
 AND EXISTS(SELECT 1 FROM channel_members WHERE channel_id=src.id AND user_id=requester)
 AND EXISTS(SELECT 1 FROM channel_members WHERE channel_id=dest.id AND user_id=requester)
 AND (NOT src.private OR dest.private)
 AND NOT EXISTS(SELECT 1 FROM channel_members cm JOIN workspace_members viewer
      ON viewer.workspace_id=w AND viewer.user_id=cm.user_id AND viewer.active
      WHERE cm.channel_id=dest.id
      AND NOT EXISTS(SELECT 1 FROM channel_members allowed WHERE allowed.channel_id=src.id AND allowed.user_id=viewer.user_id))
$$;
REVOKE ALL ON FUNCTION knowledge_visible_attachments(uuid,uuid,uuid,uuid[]) FROM PUBLIC;
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION knowledge_visible_attachments(uuid,uuid,uuid,uuid[]) SET search_path=pg_catalog,%I,pg_temp', current_schema());
END $$;
