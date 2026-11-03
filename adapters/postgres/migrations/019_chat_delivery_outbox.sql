CREATE TABLE chat_delivery_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION enqueue_chat_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO chat_delivery_outbox(channel_id)
    VALUES ((coalesce(to_jsonb(NEW),to_jsonb(OLD))->>'channel_id')::uuid);
  RETURN NULL;
END; $$;

-- Enqueue alongside every human/agent message and task event, including direct writers.
CREATE TRIGGER channel_events_delivery AFTER INSERT ON channel_events
  FOR EACH ROW EXECUTE FUNCTION enqueue_chat_delivery();
CREATE TRIGGER channel_members_delivery AFTER INSERT OR UPDATE OR DELETE ON channel_members
  FOR EACH ROW EXECUTE FUNCTION enqueue_chat_delivery();
CREATE TRIGGER workspace_members_delivery AFTER UPDATE OR DELETE ON workspace_members
  FOR EACH ROW EXECUTE FUNCTION enqueue_chat_delivery();
CREATE TRIGGER human_credentials_delivery AFTER UPDATE OR DELETE ON human_credentials
  FOR EACH ROW EXECUTE FUNCTION enqueue_chat_delivery();
CREATE TRIGGER auth_sessions_delivery AFTER UPDATE OR DELETE ON auth_sessions
  FOR EACH ROW EXECUTE FUNCTION enqueue_chat_delivery();
