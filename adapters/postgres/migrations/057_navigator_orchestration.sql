ALTER TABLE navigator_settings ADD COLUMN policy_version uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE navigator_settings ADD COLUMN execution_mode text NOT NULL DEFAULT 'suggest' CHECK(execution_mode IN ('suggest','observe'));
ALTER TABLE navigator_suggestions ADD COLUMN policy_version text;
ALTER TABLE navigator_inferences DROP CONSTRAINT navigator_inferences_level_check;
ALTER TABLE navigator_inferences ADD CHECK(level IN (1,2,3));
ALTER TABLE navigator_inferences ADD COLUMN policy_version text;
ALTER TABLE navigator_inferences ADD COLUMN work_state_hash text;
ALTER TABLE navigator_inferences ADD COLUMN input_hash text;

CREATE TABLE navigator_authorizations (
 id uuid PRIMARY KEY,
 decision_id uuid NOT NULL REFERENCES navigator_decisions(id),
 actor_id uuid NOT NULL REFERENCES users(id),
 source_message_id uuid NOT NULL,
 channel_id uuid NOT NULL REFERENCES channels(id),
 thread_id uuid NOT NULL REFERENCES threads(id),
 installation_id uuid NOT NULL REFERENCES agent_installations(id),
 session_id uuid REFERENCES agent_sessions(id),
 skill text NOT NULL,
 action text NOT NULL CHECK(action IN ('start','continue','stop')),
 scope text NOT NULL CHECK(length(scope) BETWEEN 1 AND 16000),
 policy_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(decision_id)
);
CREATE FUNCTION immutable_navigation_authorization() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'navigation authorization is immutable';
END; $$;
CREATE TRIGGER navigator_authorization_immutable BEFORE UPDATE ON navigator_authorizations FOR EACH ROW EXECUTE FUNCTION immutable_navigation_authorization();

CREATE TABLE navigator_followups (
 id uuid PRIMARY KEY REFERENCES navigator_authorizations(id),
 thread_id uuid NOT NULL REFERENCES threads(id),
 session_id uuid NOT NULL REFERENCES agent_sessions(id),
 document jsonb,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','cancelled')),
 task_id uuid REFERENCES tasks(id),
 reason text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX navigator_followups_pending ON navigator_followups(thread_id,created_at,id) WHERE status='pending';
CREATE INDEX navigator_followups_session ON navigator_followups(session_id) WHERE status='pending';

CREATE FUNCTION wake_navigation_followups() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_session uuid; target_thread uuid;
BEGIN
 IF TG_TABLE_NAME='navigator_followups' THEN
  target_session:=NEW.session_id;
 ELSIF TG_TABLE_NAME='tasks' THEN
  IF NEW.status IN ('awaiting_approval','queued','running') OR OLD.status=NEW.status THEN RETURN NEW; END IF;
  target_session:=NEW.session_id;
 ELSIF TG_TABLE_NAME='agent_sessions' THEN
  IF NEW.state<> 'ended' OR OLD.state=NEW.state THEN RETURN NEW; END IF;
  target_session:=NEW.id;
 ELSE
  IF NEW.payload->>'code' IS DISTINCT FROM 'session_stopped' THEN RETURN NEW; END IF;
  SELECT session_id INTO target_session FROM tasks WHERE id=NEW.correlation_id;
  UPDATE navigator_followups SET status='cancelled',reason='session_stopped' WHERE session_id=target_session AND status='pending';
 END IF;
 SELECT thread_id INTO target_thread FROM navigator_followups WHERE session_id=target_session AND status='pending' LIMIT 1;
 IF target_thread IS NOT NULL THEN
  INSERT INTO event_outbox(kind,aggregate_id,payload) VALUES('navigator.ready',target_thread::text,jsonb_build_object('thread_id',target_thread));
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER navigator_followups_ready AFTER INSERT ON navigator_followups FOR EACH ROW EXECUTE FUNCTION wake_navigation_followups();
CREATE TRIGGER navigator_followups_task_ready AFTER UPDATE OF status ON tasks FOR EACH ROW EXECUTE FUNCTION wake_navigation_followups();
CREATE TRIGGER navigator_followups_session_ready AFTER UPDATE OF state ON agent_sessions FOR EACH ROW EXECUTE FUNCTION wake_navigation_followups();
CREATE TRIGGER navigator_followups_stopped AFTER INSERT ON task_events FOR EACH ROW EXECUTE FUNCTION wake_navigation_followups();
