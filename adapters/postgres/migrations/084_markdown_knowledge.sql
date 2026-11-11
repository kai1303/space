ALTER TABLE knowledge_thread_channels ADD COLUMN index_markdown boolean NOT NULL DEFAULT false;

-- File-only posts are valid sources of evidence. The worker skips their empty captions.
CREATE OR REPLACE VIEW knowledge_thread_messages WITH (security_barrier=true) AS
 SELECT m.workspace_id,m.channel_id,m.id,m.thread_id,m.search_revision,left(m.text,8000) AS body,c.name AS channel_name
 FROM knowledge_thread_channels k JOIN channels c ON c.id=k.channel_id AND c.workspace_id=k.workspace_id
 JOIN messages m ON m.channel_id=c.id
 WHERE c.kind='channel' AND c.archived_at IS NULL AND m.agent_session_id IS NULL
   AND m.author_type='human' AND m.deleted_at IS NULL AND m.retained_at IS NULL
   AND (btrim(m.text)<>'' OR (k.index_markdown AND jsonb_array_length(m.attachments)>0));

CREATE VIEW knowledge_thread_files WITH (security_barrier=true) AS
 SELECT m.workspace_id,m.channel_id,m.id AS message_id,m.thread_id,a.id,a.name,a.size,a.object_key,a.preview
 FROM knowledge_thread_messages m
 JOIN knowledge_thread_channels k ON k.workspace_id=m.workspace_id AND k.channel_id=m.channel_id AND k.index_markdown
 JOIN assets a ON a.workspace_id=m.workspace_id AND a.channel_id=m.channel_id AND a.message_id=m.id
 JOIN messages posted ON posted.id=m.id AND posted.channel_id=m.channel_id
 WHERE a.status='ready' AND a.name ~* '\.(md|markdown)$'
 AND posted.attachments @> jsonb_build_array(jsonb_build_object('id',a.id));

CREATE FUNCTION knowledge_visible_files(w uuid, requester uuid, destination uuid, ids uuid[])
 RETURNS TABLE(id uuid,message_id uuid,thread_id uuid,name text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
 WITH files AS MATERIALIZED (
   SELECT f.id,f.message_id,f.thread_id,f.name FROM knowledge_thread_files f
   WHERE cardinality(ids)<=128 AND f.workspace_id=w AND f.id=ANY(ids)
 )
 SELECT f.* FROM files f JOIN knowledge_visible_messages(w,requester,destination,ARRAY(SELECT message_id FROM files)) m
 ON m.id=f.message_id
$$;
REVOKE ALL ON FUNCTION knowledge_visible_files(uuid,uuid,uuid,uuid[]) FROM PUBLIC;
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION knowledge_visible_files(uuid,uuid,uuid,uuid[]) SET search_path=pg_catalog,%I,pg_temp',current_schema());
END $$;

-- The normal send binds the asset and posts the message in one transaction.
-- Also wake the worker when an existing attachment is detached or removed.
CREATE FUNCTION notify_knowledge_file_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' AND OLD.message_id IS NOT NULL THEN
   PERFORM pg_notify('space_kb_' || replace(OLD.workspace_id::text,'-',''),OLD.channel_id::text || '/' || OLD.message_id::text);
 END IF;
 IF TG_OP <> 'DELETE' AND NEW.message_id IS NOT NULL THEN
   PERFORM pg_notify('space_kb_' || replace(NEW.workspace_id::text,'-',''),NEW.channel_id::text || '/' || NEW.message_id::text);
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER knowledge_file_changed AFTER INSERT OR UPDATE OF message_id,status,name OR DELETE ON assets
 FOR EACH ROW EXECUTE FUNCTION notify_knowledge_file_change();
