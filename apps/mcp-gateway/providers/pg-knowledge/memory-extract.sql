-- Apply after memory-graph.sql, including on installations that used sequence-only extraction.
BEGIN;
-- Channel topic and description. The graph reader fills NULL rows from Space when it starts.
ALTER TABLE kb.m_channels ADD COLUMN IF NOT EXISTS topic text, ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE kb.m_channels ADD COLUMN IF NOT EXISTS archived boolean;
ALTER TABLE kb.m_threads ADD COLUMN IF NOT EXISTS extract_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extract_generation bigint NOT NULL DEFAULT 0;
-- Keep the complete original citations even if a graph message (and its edge) disappears.
ALTER TABLE kb.m_facts ADD COLUMN IF NOT EXISTS evidence_revisions jsonb;
ALTER TABLE kb.m_thread_topics ADD COLUMN IF NOT EXISTS evidence_revisions jsonb;
DELETE FROM kb.m_thread_topics WHERE evidence_revisions IS NULL;

-- Existing facts predate revision tracking. Space migration 096 queues their threads for re-extraction.
SELECT pgcontext.delete_points('kb_memory_facts', ARRAY(SELECT id FROM kb.m_facts WHERE evidence_revisions IS NULL));
DELETE FROM kb.m_facts WHERE evidence_revisions IS NULL;

-- Remove a whole fact if any of its sources moves out of memory, changes, or disappears.
CREATE OR REPLACE FUNCTION kb.invalidate_message_facts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ids text[];
BEGIN
  DELETE FROM kb.m_thread_topics WHERE thread_id=OLD.thread_id AND evidence_revisions ? OLD.id;
  SELECT array_agg(fact_id) INTO ids FROM kb.m_fact_evidence WHERE message_id=OLD.id;
  IF ids IS NOT NULL THEN
    PERFORM pgcontext.delete_points('kb_memory_facts', ids);
    DELETE FROM kb.m_facts WHERE id=ANY(ids);
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;
CREATE OR REPLACE TRIGGER invalidate_edited_facts BEFORE UPDATE OF revision,memory ON kb.m_messages
  FOR EACH ROW WHEN (OLD.revision IS DISTINCT FROM NEW.revision OR (OLD.memory AND NOT NEW.memory))
  EXECUTE FUNCTION kb.invalidate_message_facts();
CREATE OR REPLACE TRIGGER invalidate_deleted_facts BEFORE DELETE ON kb.m_messages
  FOR EACH ROW EXECUTE FUNCTION kb.invalidate_message_facts();
COMMIT;
