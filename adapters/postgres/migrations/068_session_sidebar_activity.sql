CREATE INDEX tasks_running_session ON tasks(session_id) WHERE status='running' AND session_id IS NOT NULL;

CREATE FUNCTION enqueue_session_activity_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO chat_delivery_outbox(workspace_id,resource_scope)
    SELECT workspace_id,'metadata' FROM agent_sessions WHERE id=NEW.session_id AND managed;
  RETURN NULL;
END; $$;

CREATE TRIGGER session_activity_started AFTER INSERT ON tasks
  FOR EACH ROW WHEN (NEW.session_id IS NOT NULL AND NEW.status='running')
  EXECUTE FUNCTION enqueue_session_activity_delivery();
CREATE TRIGGER session_activity_changed AFTER UPDATE OF status ON tasks
  FOR EACH ROW WHEN (NEW.session_id IS NOT NULL AND (NEW.status='running') <> (OLD.status='running'))
  EXECUTE FUNCTION enqueue_session_activity_delivery();
