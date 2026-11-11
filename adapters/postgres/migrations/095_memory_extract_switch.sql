-- Extraction runs only when a worker has a model. Until one says so, messages queue nothing,
-- so no memory.extract.ready events pile up in the broker with nobody to read them.
-- A worker with MEMORY_EXTRACT_MODEL and MEMORY_GRAPH_WRITE_URL turns this on when it starts.
-- To turn it off after removing the model: UPDATE memory_extract_config SET enabled = false;
CREATE TABLE memory_extract_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT false
);
INSERT INTO memory_extract_config DEFAULT VALUES;

CREATE OR REPLACE FUNCTION queue_memory_extract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.search_revision = OLD.search_revision AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at THEN RETURN NULL; END IF;
  IF NEW.agent_session_id IS NOT NULL OR btrim(NEW.text) = '' THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM memory_extract_config WHERE enabled) THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM channels c WHERE c.id = NEW.channel_id AND c.kind = 'channel' AND c.memory_enabled AND c.archived_at IS NULL) THEN RETURN NULL; END IF;
  INSERT INTO memory_extract_threads(thread_id, workspace_id, channel_id, pending_through, available_at)
    VALUES (NEW.thread_id, NEW.workspace_id, NEW.channel_id, NEW.sequence, now() + interval '60 seconds')
  ON CONFLICT (thread_id) DO UPDATE SET
    pending_through = greatest(memory_extract_threads.pending_through, EXCLUDED.pending_through),
    done_through = CASE WHEN TG_OP = 'UPDATE' THEN least(memory_extract_threads.done_through, NEW.sequence - 1) ELSE memory_extract_threads.done_through END,
    available_at = greatest(now() + interval '60 seconds', coalesce(memory_extract_threads.last_run_at + interval '5 minutes', '-infinity'::timestamptz));
  RETURN NULL;
END; $$;
