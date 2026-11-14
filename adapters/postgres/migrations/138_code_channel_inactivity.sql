-- Activity that doesn't produce a turn or discussion message also counts.
ALTER TABLE agent_sessions ADD COLUMN sidebar_activity_at timestamptz;
CREATE FUNCTION record_code_channel_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.sidebar_activity_at := greatest(NEW.sidebar_activity_at, statement_timestamp());
  RETURN NEW;
END; $$;
CREATE TRIGGER code_channel_details_activity BEFORE UPDATE OF title,state,outputs ON agent_sessions FOR EACH ROW
  WHEN (NEW.managed AND NEW.handoff_context IS NULL AND
    (NEW.title,NEW.state,NEW.outputs) IS DISTINCT FROM (OLD.title,OLD.state,OLD.outputs))
  EXECUTE FUNCTION record_code_channel_activity();
CREATE INDEX code_channel_last_turn ON tasks(session_id,updated_at DESC) WHERE session_id IS NOT NULL;
CREATE INDEX code_channel_active_turn ON tasks(session_id) WHERE status IN ('running','queued');
CREATE INDEX code_channel_last_input ON agent_session_inputs(session_id,created_at DESC);
CREATE INDEX code_channel_last_discussion ON session_discussion_messages(session_id,created_at DESC);

-- A queued request is activity before it is promoted to a task. Wake open lists
-- immediately when a new request revives an otherwise expired code channel.
CREATE TRIGGER session_queue_sidebar_activity AFTER INSERT ON agent_session_inputs
  FOR EACH ROW WHEN (NEW.kind='queue') EXECUTE FUNCTION enqueue_session_activity_delivery();
