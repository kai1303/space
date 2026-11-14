-- Apply once on both new and existing knowledge databases, after memory-graph.sql.
BEGIN;
-- An attachment can belong to a post whose text was never indexed. Keep its origin
-- addressable even for those posts, without creating a text/vector search record.
CREATE TABLE kb.m_attachment_messages (
  id text PRIMARY KEY, thread_id text NOT NULL REFERENCES kb.m_threads(id) ON DELETE CASCADE
);
CREATE INDEX ON kb.m_attachment_messages(thread_id);
CREATE TABLE kb.m_attachments (
  id text PRIMARY KEY, workspace_id uuid NOT NULL,
  channel_id text NOT NULL REFERENCES kb.m_channels(id) ON DELETE CASCADE,
  thread_id text NOT NULL REFERENCES kb.m_threads(id) ON DELETE CASCADE,
  message_id text NOT NULL, name text NOT NULL, type text NOT NULL, size integer NOT NULL,
  version bigint NOT NULL
);
CREATE INDEX ON kb.m_attachments(channel_id, id);
CREATE INDEX ON kb.m_attachments(message_id);
CREATE INDEX ON kb.m_attachments(thread_id);
CREATE INDEX ON kb.m_attachments USING gin(to_tsvector('simple', translate(name || ' ' || type, '._/-', '    ')));

-- Materialize one source-message identity for all files on that post. AFTER triggers
-- run only for writes that passed the reader's WAL-version check.
CREATE OR REPLACE FUNCTION kb.sync_attachment_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO kb.m_attachment_messages(id,thread_id) VALUES(NEW.message_id,NEW.thread_id)
    ON CONFLICT (id) DO UPDATE SET thread_id=EXCLUDED.thread_id
    WHERE kb.m_attachment_messages.thread_id<>EXCLUDED.thread_id;
  END IF;
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.message_id<>NEW.message_id) THEN
    DELETE FROM kb.m_attachment_messages WHERE id=OLD.message_id
      AND NOT EXISTS (SELECT FROM kb.m_attachments WHERE message_id=OLD.message_id);
  END IF;
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.thread_id<>NEW.thread_id) THEN
    DELETE FROM kb.m_threads t WHERE t.id=OLD.thread_id
      AND NOT EXISTS (SELECT FROM kb.m_attachments WHERE thread_id=t.id)
      AND NOT EXISTS (SELECT FROM kb.m_messages WHERE workspace_id=t.workspace_id AND thread_id=t.id)
      AND NOT EXISTS (SELECT FROM kb.m_sessions WHERE thread_id=t.id)
      AND NOT EXISTS (SELECT FROM kb.m_knowledge_evidence WHERE thread_id=t.id)
      AND NOT EXISTS (SELECT FROM kb.m_facts WHERE thread_id=t.id)
      AND NOT EXISTS (SELECT FROM kb.m_thread_topics WHERE thread_id=t.id);
  END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER sync_attachment_message AFTER INSERT OR UPDATE OR DELETE ON kb.m_attachments
  FOR EACH ROW EXECUTE FUNCTION kb.sync_attachment_message();

GRANT SELECT ON kb.m_attachments,kb.m_attachment_messages TO space_knowledge_reader;
SELECT graph.add_table_to_graph('space_memory','kb.m_attachment_messages'::regclass,'id',ARRAY['id']);
SELECT graph.add_table_to_graph('space_memory','kb.m_attachments'::regclass,'id',ARRAY['id']);
SELECT graph.add_edge_to_graph('space_memory','kb.m_attachments'::regclass,'message_id','kb.m_attachment_messages'::regclass,'id',
  label := 'attached_to', bidirectional := false);
SELECT graph.add_edge_to_graph('space_memory','kb.m_attachment_messages'::regclass,'thread_id','kb.m_threads'::regclass,'id',
  label := 'attachment_message_in_thread', bidirectional := false);
SELECT graph.add_edge_to_graph('space_memory','kb.m_attachment_messages'::regclass,'id','kb.m_messages'::regclass,'id',
  label := 'indexed_message', bidirectional := false);
COMMIT;
