-- A durable subscription outlives any one API process.
CREATE TABLE memory_change_providers (provider text PRIMARY KEY);
CREATE TABLE memory_provider_message_refs (
  channel_id uuid NOT NULL,
  message_id uuid NOT NULL,
  provider text NOT NULL REFERENCES memory_change_providers(provider),
  has_quote boolean NOT NULL,
  PRIMARY KEY (channel_id, message_id, provider),
  FOREIGN KEY (channel_id, message_id) REFERENCES messages(channel_id, id) ON DELETE CASCADE
);

CREATE FUNCTION enqueue_memory_provider_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO event_outbox(kind, aggregate_id, payload)
  SELECT 'memory.provider.changed', recipients.provider,
    jsonb_build_object('workspace_id', NEW.workspace_id, 'channel_id', NEW.channel_id,
      'message_id', NEW.id, 'revision', greatest(NEW.search_revision, OLD.search_revision + 1)::text,
      'type', CASE WHEN NEW.deleted_at IS NOT NULL OR NEW.retained_at IS NOT NULL
                    OR NEW.agent_session_id IS NOT NULL THEN 'deleted' ELSE 'edited' END,
      'can_refresh', c.memory_enabled AND c.memory_provider = recipients.provider)
  FROM channels c
  CROSS JOIN LATERAL (
    SELECT p.provider FROM memory_change_providers p
      WHERE c.memory_enabled AND p.provider = c.memory_provider
    UNION
    SELECT r.provider FROM memory_provider_message_refs r
      WHERE r.channel_id = NEW.channel_id AND r.message_id = NEW.id
  ) recipients
  WHERE c.id = NEW.channel_id AND c.kind = 'channel';
  RETURN NULL;
END; $$;

CREATE TRIGGER memory_provider_message_changed AFTER UPDATE ON messages FOR EACH ROW
  WHEN (OLD.agent_session_id IS NULL AND OLD.deleted_at IS NULL AND OLD.retained_at IS NULL
    AND (OLD.search_revision, OLD.retained_at) IS DISTINCT FROM (NEW.search_revision, NEW.retained_at))
  EXECUTE FUNCTION enqueue_memory_provider_change();
