-- A citation identifies a particular version of a message, not just its URL.
ALTER TABLE knowledge_notes ADD COLUMN evidence_revisions jsonb NOT NULL DEFAULT '{}';

CREATE FUNCTION capture_note_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT coalesce(jsonb_object_agg(m.id, m.search_revision), '{}') INTO NEW.evidence_revisions
    FROM messages m WHERE m.channel_id=NEW.channel_id AND m.id=ANY(NEW.evidence)
      AND m.agent_session_id IS NULL AND m.deleted_at IS NULL AND m.retained_at IS NULL;
  RETURN NEW;
END; $$;
CREATE TRIGGER capture_note_evidence BEFORE INSERT OR UPDATE OF evidence ON knowledge_notes
  FOR EACH ROW EXECUTE FUNCTION capture_note_evidence();

-- Older notes did not record revisions. Only an unedited source is provable.
UPDATE knowledge_notes n SET evidence_revisions=(
  SELECT jsonb_object_agg(id, 1) FROM unnest(n.evidence) id
);
CREATE OR REPLACE VIEW shared_knowledge_notes WITH (security_barrier=true) AS
 SELECT n.* FROM knowledge_notes n WHERE cardinality(n.evidence) = (
   SELECT count(*) FROM messages m WHERE m.channel_id=n.channel_id AND m.id=ANY(n.evidence)
     AND m.agent_session_id IS NULL AND m.deleted_at IS NULL AND m.retained_at IS NULL
     AND n.evidence_revisions->>m.id::text=m.search_revision::text
 );

-- Existing index workers re-read the affected notes through the live view.
CREATE FUNCTION notify_edited_note_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('space_kb_' || replace(NEW.workspace_id::text,'-',''),
    'evidence/' || NEW.channel_id::text || '/' || NEW.id::text);
  RETURN NULL;
END; $$;
CREATE TRIGGER edited_note_evidence AFTER UPDATE ON messages FOR EACH ROW
 WHEN (OLD.search_revision <> NEW.search_revision)
 EXECUTE FUNCTION notify_edited_note_evidence();
