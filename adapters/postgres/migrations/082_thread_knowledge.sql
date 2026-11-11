-- An operator opts in a specific workspace channel. The provider reads through this view.
CREATE TABLE knowledge_thread_channels (
  workspace_id uuid NOT NULL, channel_id uuid NOT NULL,
  PRIMARY KEY (workspace_id,channel_id),
  FOREIGN KEY (workspace_id,channel_id) REFERENCES channels(workspace_id,id) ON DELETE CASCADE
);
CREATE VIEW knowledge_thread_messages WITH (security_barrier=true) AS
 SELECT m.workspace_id,m.channel_id,m.id,m.thread_id,m.search_revision,left(m.text,8000) AS body,c.name AS channel_name
 FROM knowledge_thread_channels k JOIN channels c ON c.id=k.channel_id AND c.workspace_id=k.workspace_id
 JOIN messages m ON m.channel_id=c.id
 WHERE c.kind='channel' AND c.archived_at IS NULL AND m.agent_session_id IS NULL
   AND m.author_type='human' AND m.deleted_at IS NULL AND m.retained_at IS NULL AND btrim(m.text)<>'';

-- No text in notifications. LISTEN before the startup backfill closes the commit/backfill gap.
CREATE FUNCTION notify_thread_knowledge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='messages' THEN
    IF TG_OP='UPDATE' AND NEW.search_revision=OLD.search_revision THEN RETURN NULL; END IF;
    PERFORM pg_notify('space_kb_' || replace(coalesce(NEW.workspace_id,OLD.workspace_id)::text,'-',''),
      coalesce(NEW.channel_id,OLD.channel_id)::text || '/' || coalesce(NEW.id,OLD.id)::text);
  ELSE
    IF TG_TABLE_NAME='knowledge_thread_channels' AND TG_OP='UPDATE' AND OLD.workspace_id<>NEW.workspace_id THEN
      PERFORM pg_notify('space_kb_' || replace(OLD.workspace_id::text,'-',''),'reconcile');
    END IF;
    PERFORM pg_notify('space_kb_' || replace(coalesce(NEW.workspace_id,OLD.workspace_id)::text,'-',''),'reconcile');
  END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER knowledge_message_changed AFTER INSERT OR UPDATE OF text,document,deleted_at,retained_at,agent_session_id OR DELETE ON messages
 FOR EACH ROW EXECUTE FUNCTION notify_thread_knowledge();
CREATE TRIGGER knowledge_opt_in_changed AFTER INSERT OR UPDATE OR DELETE ON knowledge_thread_channels
 FOR EACH ROW EXECUTE FUNCTION notify_thread_knowledge();
CREATE TRIGGER knowledge_channel_archived AFTER UPDATE OF archived_at ON channels
 FOR EACH ROW WHEN (NEW.archived_at IS DISTINCT FROM OLD.archived_at) EXECUTE FUNCTION notify_thread_knowledge();

-- Source of truth at retrieval, including membership changes and removals while indexing is down.
CREATE FUNCTION knowledge_visible_messages(w uuid, requester uuid, destination uuid, ids uuid[])
 RETURNS TABLE(id uuid,channel_id uuid,thread_id uuid,body text,channel_name text,search_revision bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
 SELECT m.id,m.channel_id,m.thread_id,m.body,m.channel_name,m.search_revision
 FROM knowledge_thread_messages m JOIN channels src ON src.id=m.channel_id
 JOIN channels dest ON dest.workspace_id=w AND dest.id=destination
 JOIN workspace_members actor ON actor.workspace_id=w AND actor.user_id=requester AND actor.active
 WHERE m.workspace_id=w AND m.id=ANY(ids) AND cardinality(ids)<=128
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
