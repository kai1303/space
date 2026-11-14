-- Index the readable words of submitted turns and final replies. Tool payloads,
-- private provider history and machine identifiers are outside this corpus.
CREATE FUNCTION session_response_words(p jsonb) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT to_tsvector('simple',coalesce(string_agg(m->>'text',' '),''))
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p->'response'->'messages')='array' THEN p->'response'->'messages' ELSE '[]'::jsonb END) m
$$;
CREATE INDEX session_turn_words ON tasks USING gin(to_tsvector('simple',goal||' '||coalesce(result,''))) WHERE session_id IS NOT NULL;
CREATE INDEX session_reply_words ON task_events USING gin(session_response_words(payload))
  WHERE type IN ('task.completed','task.failed') AND payload ? 'response';
CREATE INDEX session_discussion_words ON session_discussion_messages USING gin(to_tsvector('simple',body));
CREATE INDEX session_steering_words ON agent_session_inputs USING gin(to_tsvector('simple',body->>'text')) WHERE kind='steer' AND state='sent';

-- Existing activity triggers only publish entering/leaving running. Wake the
-- workspace view on the other user-visible transitions, never on streamed tokens.
CREATE OR REPLACE FUNCTION enqueue_session_activity_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE workspace uuid; source_channel uuid;
BEGIN
  SELECT a.workspace_id,t.channel_id INTO workspace,source_channel FROM agent_sessions a JOIN threads t ON t.id=a.origin_thread_id
    WHERE a.id=NEW.session_id AND a.managed;
  IF workspace IS NOT NULL THEN
    INSERT INTO chat_delivery_outbox(workspace_id,channel_id,resource_scope) VALUES(workspace,source_channel,'metadata');
    PERFORM pg_notify('space_direct_turn',json_build_object('keys',ARRAY['workspace:'||workspace,'channel:'||source_channel])::text);
  END IF;
  RETURN NULL;
END; $$;

CREATE OR REPLACE FUNCTION enqueue_session_sidebar_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session_row agent_sessions; source_channel uuid;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.title,NEW.state,NEW.managed) IS NOT DISTINCT FROM (OLD.title,OLD.state,OLD.managed) THEN RETURN NULL; END IF;
  session_row := CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  SELECT channel_id INTO source_channel FROM threads WHERE id=session_row.origin_thread_id;
  INSERT INTO chat_delivery_outbox(workspace_id,channel_id,resource_scope) VALUES(session_row.workspace_id,source_channel,'metadata');
  PERFORM pg_notify('space_direct_turn',json_build_object('keys',array_remove(ARRAY['workspace:'||session_row.workspace_id,'channel:'||source_channel],NULL))::text);
  RETURN NULL;
END; $$;

DROP TRIGGER session_activity_started ON tasks;
DROP TRIGGER session_activity_changed ON tasks;
CREATE TRIGGER session_activity_started AFTER INSERT ON tasks FOR EACH ROW WHEN (NEW.session_id IS NOT NULL)
  EXECUTE FUNCTION enqueue_session_activity_delivery();
CREATE TRIGGER session_activity_changed AFTER UPDATE OF status ON tasks FOR EACH ROW WHEN (NEW.session_id IS NOT NULL AND NEW.status<>OLD.status)
  EXECUTE FUNCTION enqueue_session_activity_delivery();
CREATE TRIGGER session_approval_requested AFTER INSERT ON agent_tool_approvals FOR EACH ROW WHEN (NEW.status='pending')
  EXECUTE FUNCTION enqueue_session_activity_delivery();
CREATE TRIGGER session_approval_resolved AFTER UPDATE OF status ON agent_tool_approvals FOR EACH ROW WHEN (NEW.status<>OLD.status)
  EXECUTE FUNCTION enqueue_session_activity_delivery();
CREATE TRIGGER session_queue_blocked AFTER UPDATE OF state ON agent_session_inputs FOR EACH ROW WHEN ((OLD.state='blocked')<>(NEW.state='blocked') OR (NEW.kind='steer' AND NEW.state='sent' AND OLD.state<>NEW.state))
  EXECUTE FUNCTION enqueue_session_activity_delivery();
CREATE TRIGGER session_discussion_search_changed AFTER INSERT ON session_discussion_messages FOR EACH ROW
  EXECUTE FUNCTION enqueue_session_activity_delivery();
