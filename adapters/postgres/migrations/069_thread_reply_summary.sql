ALTER TABLE threads
  ADD COLUMN reply_summary text NOT NULL DEFAULT '' CHECK (length(reply_summary) <= 1200),
  ADD COLUMN reply_summary_through bigint NOT NULL DEFAULT 0,
  ADD COLUMN reply_summary_offset integer NOT NULL DEFAULT 0,
  ADD COLUMN reply_history_revision bigint NOT NULL DEFAULT 0;

-- Bump the revision even before the first summary exists: a provider call can be in flight.
CREATE FUNCTION invalidate_reply_summary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE threads SET reply_history_revision = reply_history_revision + 1,
    reply_summary = '', reply_summary_through = 0, reply_summary_offset = 0
    WHERE id = OLD.thread_id;
  RETURN NULL;
END;
$$;
CREATE TRIGGER messages_invalidate_reply_summary AFTER UPDATE ON messages FOR EACH ROW
  WHEN ((OLD.agent_session_id IS NULL OR NEW.agent_session_id IS NULL) AND
    (OLD.text, OLD.agent_session_id, OLD.deleted_at, OLD.retained_at) IS DISTINCT FROM
    (NEW.text, NEW.agent_session_id, NEW.deleted_at, NEW.retained_at))
  EXECUTE FUNCTION invalidate_reply_summary();
CREATE TRIGGER messages_delete_reply_summary AFTER DELETE ON messages FOR EACH ROW
  WHEN (OLD.agent_session_id IS NULL) EXECUTE FUNCTION invalidate_reply_summary();
