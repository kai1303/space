CREATE INDEX agent_sessions_workspace_created ON agent_sessions(workspace_id,created_at DESC,id DESC) WHERE managed;

-- Session discovery changes wake workspace lists; streamed turns keep their thread scope.
CREATE FUNCTION enqueue_session_sidebar_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session_row agent_sessions;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.title,NEW.state,NEW.managed) IS NOT DISTINCT FROM (OLD.title,OLD.state,OLD.managed) THEN RETURN NULL; END IF;
  session_row := CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  INSERT INTO chat_delivery_outbox(workspace_id,resource_scope) VALUES(session_row.workspace_id,'metadata');
  RETURN NULL;
END; $$;
CREATE TRIGGER session_sidebar_delivery AFTER INSERT OR UPDATE OR DELETE ON agent_sessions
  FOR EACH ROW EXECUTE FUNCTION enqueue_session_sidebar_delivery();
