ALTER TABLE memory_extract_threads
  ADD COLUMN generation bigint NOT NULL DEFAULT 1,
  ADD COLUMN waiting_for_index boolean NOT NULL DEFAULT false;
CREATE INDEX memory_extract_waiters ON memory_extract_threads(channel_id, thread_id) WHERE waiting_for_index;

-- Graph commits can wake a parked batch even if no more messages arrive.
CREATE FUNCTION wake_memory_extract(ids uuid[], channel_ids uuid[] DEFAULT '{}'::uuid[])
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$
  UPDATE memory_extract_threads SET waiting_for_index = false, available_at = now()
   WHERE waiting_for_index AND (ids IS NULL OR thread_id = ANY(ids) OR channel_id = ANY(channel_ids))
$$;
REVOKE ALL ON FUNCTION wake_memory_extract(uuid[], uuid[]) FROM PUBLIC;
DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION wake_memory_extract(uuid[], uuid[]) SET search_path=pg_catalog,%I,pg_temp', current_schema());
END $$;

CREATE OR REPLACE FUNCTION queue_memory_extract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.search_revision, NEW.deleted_at, NEW.retained_at)
      IS NOT DISTINCT FROM (OLD.search_revision, OLD.deleted_at, OLD.retained_at) THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' AND (NEW.agent_session_id IS NOT NULL OR btrim(NEW.text) = '') THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW.agent_session_id IS NOT NULL AND OLD.agent_session_id IS NOT NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM memory_extract_config WHERE enabled) THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM channels c WHERE c.id = NEW.channel_id AND c.kind = 'channel' AND c.memory_enabled AND c.archived_at IS NULL) THEN RETURN NULL; END IF;
  INSERT INTO memory_extract_threads(thread_id, workspace_id, channel_id, pending_through, available_at)
    VALUES (NEW.thread_id, NEW.workspace_id, NEW.channel_id, NEW.sequence, now() + interval '60 seconds')
  ON CONFLICT (thread_id) DO UPDATE SET
    pending_through = greatest(memory_extract_threads.pending_through, EXCLUDED.pending_through),
    generation = memory_extract_threads.generation + CASE WHEN TG_OP = 'UPDATE' THEN 1 ELSE 0 END,
    done_through = CASE WHEN TG_OP = 'UPDATE' THEN least(memory_extract_threads.done_through, NEW.sequence - 1) ELSE memory_extract_threads.done_through END,
    waiting_for_index = false, attempts = 0,
    available_at = greatest(now() + interval '60 seconds', coalesce(memory_extract_threads.last_run_at + interval '5 minutes', '-infinity'::timestamptz));
  RETURN NULL;
END; $$;

-- Old progress cannot distinguish a successful write from a missed edit or a lagging index.
UPDATE memory_extract_threads t SET done_through=0, attempts=0,
  available_at=CASE WHEN c.memory_enabled AND c.archived_at IS NULL AND (SELECT enabled FROM memory_extract_config)
    THEN now() + interval '60 seconds' ELSE 'infinity' END
FROM channels c WHERE c.id=t.channel_id;
