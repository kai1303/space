ALTER TABLE agent_sessions ADD COLUMN title text NOT NULL DEFAULT 'Agent run' CHECK (length(title) BETWEEN 1 AND 160);
ALTER TABLE agent_sessions ADD COLUMN state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','ended'));
ALTER TABLE agent_sessions ADD COLUMN managed boolean NOT NULL DEFAULT false;
ALTER TABLE agent_sessions ADD COLUMN created_by uuid REFERENCES users(id);
ALTER TABLE agent_sessions ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE agent_sessions ADD COLUMN outputs jsonb NOT NULL DEFAULT '{"files":[],"changes":[]}' CHECK (jsonb_typeof(outputs)='object');
ALTER TABLE agent_sessions ADD COLUMN skill text NOT NULL DEFAULT 'codex.run';
CREATE INDEX agent_sessions_thread_created ON agent_sessions(origin_thread_id,created_at DESC,id DESC);
CREATE INDEX tasks_session_created ON tasks(session_id,created_at DESC,id DESC);
CREATE INDEX task_events_response_snapshot ON task_events(correlation_id,sequence DESC) WHERE payload ? 'response';
CREATE INDEX task_events_ready_session ON task_events(correlation_id) WHERE payload->>'session_ready'='true';
CREATE FUNCTION enqueue_agent_session_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE thread uuid; workspace uuid; channel uuid;
BEGIN
  IF TG_TABLE_NAME='agent_sessions' THEN
    thread := NEW.origin_thread_id; workspace := NEW.workspace_id;
  ELSE
    SELECT t.thread_id,t.workspace_id INTO thread,workspace FROM tasks t JOIN agent_sessions a ON a.id=t.session_id
      WHERE t.id=NEW.correlation_id AND a.managed;
  END IF;
  IF thread IS NULL THEN RETURN NULL; END IF;
  SELECT channel_id INTO channel FROM threads WHERE id=thread;
  INSERT INTO chat_delivery_outbox(channel_id,workspace_id,resource_scope,resource_id) VALUES(channel,workspace,'thread',thread);
  RETURN NULL;
END; $$;
CREATE TRIGGER agent_sessions_resource_delivery AFTER INSERT OR UPDATE ON agent_sessions FOR EACH ROW EXECUTE FUNCTION enqueue_agent_session_delivery();
-- Allocate the channel sequence before locking the thread revision, matching other task events.
CREATE TRIGGER zz_agent_session_turn_resource_delivery AFTER INSERT ON task_events FOR EACH ROW EXECUTE FUNCTION enqueue_agent_session_delivery();
