-- The indexer needs only note IDs to evict notes whose evidence is now hidden.
CREATE INDEX knowledge_notes_evidence ON knowledge_notes USING gin(evidence) WHERE removed_at IS NULL;
CREATE VIEW knowledge_note_citations WITH (security_barrier=true) AS
  SELECT workspace_id, channel_id, id, evidence FROM knowledge_notes WHERE removed_at IS NULL;

CREATE OR REPLACE FUNCTION notify_thread_knowledge() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  destination text := 'space_kb_' || replace(coalesce(NEW.workspace_id, OLD.workspace_id)::text, '-', '');
  ref text;
  visibility_changed boolean;
BEGIN
  -- Row triggers run on physical message partitions; the trigger name is stable across them.
  IF TG_NAME = 'knowledge_message_changed' THEN
    ref := coalesce(NEW.channel_id, OLD.channel_id)::text || '/' || coalesce(NEW.id, OLD.id)::text;
    visibility_changed := TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND
      (OLD.deleted_at IS NULL AND OLD.retained_at IS NULL AND OLD.agent_session_id IS NULL)
      <> (NEW.deleted_at IS NULL AND NEW.retained_at IS NULL AND NEW.agent_session_id IS NULL));
    IF visibility_changed THEN PERFORM pg_notify(destination, 'evidence/' || ref); END IF;
    IF TG_OP <> 'UPDATE' OR visibility_changed OR NEW.search_revision <> OLD.search_revision THEN
      PERFORM pg_notify(destination, ref);
    END IF;
  ELSE
    IF TG_TABLE_NAME = 'knowledge_thread_channels' AND TG_OP = 'UPDATE' AND OLD.workspace_id <> NEW.workspace_id THEN
      PERFORM pg_notify('space_kb_' || replace(OLD.workspace_id::text, '-', ''), 'reconcile');
    END IF;
    PERFORM pg_notify(destination, 'reconcile');
  END IF;
  RETURN NULL;
END; $$;
