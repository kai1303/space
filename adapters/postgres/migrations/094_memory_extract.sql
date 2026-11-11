-- Topics and facts for Graph RAG memory. One row per thread holds what the extraction step has covered.
-- A message change moves available_at; the trigger below turns that into a broker event, so no table scan is needed.
CREATE TABLE memory_extract_threads (
  thread_id uuid PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  pending_through bigint NOT NULL DEFAULT 0,
  done_through bigint NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL,
  last_run_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);

-- Builds per workspace per hour. A run takes a unit with one conditional upsert.
CREATE TABLE memory_extract_budget (
  workspace_id uuid NOT NULL,
  hour timestamptz NOT NULL,
  used integer NOT NULL CHECK (used >= 0),
  PRIMARY KEY (workspace_id, hour)
);

-- Debounce: 60 s after the last change, and at least 5 min after the previous run. An edit re-opens its sequence.
CREATE FUNCTION queue_memory_extract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.search_revision = OLD.search_revision AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at THEN RETURN NULL; END IF;
  IF NEW.agent_session_id IS NOT NULL OR btrim(NEW.text) = '' THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM channels c WHERE c.id = NEW.channel_id AND c.kind = 'channel' AND c.memory_enabled AND c.archived_at IS NULL) THEN RETURN NULL; END IF;
  INSERT INTO memory_extract_threads(thread_id, workspace_id, channel_id, pending_through, available_at)
    VALUES (NEW.thread_id, NEW.workspace_id, NEW.channel_id, NEW.sequence, now() + interval '60 seconds')
  ON CONFLICT (thread_id) DO UPDATE SET
    pending_through = greatest(memory_extract_threads.pending_through, EXCLUDED.pending_through),
    done_through = CASE WHEN TG_OP = 'UPDATE' THEN least(memory_extract_threads.done_through, NEW.sequence - 1) ELSE memory_extract_threads.done_through END,
    available_at = greatest(now() + interval '60 seconds', coalesce(memory_extract_threads.last_run_at + interval '5 minutes', '-infinity'::timestamptz));
  RETURN NULL;
END; $$;
CREATE TRIGGER messages_memory_extract AFTER INSERT OR UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION queue_memory_extract();

CREATE FUNCTION enqueue_memory_extract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF isfinite(NEW.available_at) AND (TG_OP = 'INSERT' OR OLD.available_at IS DISTINCT FROM NEW.available_at) THEN
    INSERT INTO event_outbox(kind, aggregate_id, payload, available_at)
      VALUES ('memory.extract.ready', NEW.workspace_id::text, jsonb_build_object('thread_id', NEW.thread_id, 'available_at', NEW.available_at), NEW.available_at);
  END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER memory_extract_event AFTER INSERT OR UPDATE ON memory_extract_threads FOR EACH ROW EXECUTE FUNCTION enqueue_memory_extract();
