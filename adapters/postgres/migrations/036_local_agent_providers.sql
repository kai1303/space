ALTER TABLE agent_pairings ADD COLUMN provider text NOT NULL DEFAULT 'codex' CHECK (provider IN ('codex','kiro'));

CREATE OR REPLACE FUNCTION enqueue_stream_task() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE installation uuid; connector text;
BEGIN
 SELECT t.installation_id,i.connector_id INTO installation,connector FROM tasks t JOIN agent_installations i ON i.id=t.installation_id WHERE t.id=NEW.task_id;
 IF NEW.state='pending' AND (TG_OP='INSERT' OR OLD.state IS DISTINCT FROM NEW.state OR OLD.available_at IS DISTINCT FROM NEW.available_at) THEN
  INSERT INTO event_outbox(kind,aggregate_id,payload,available_at) VALUES(CASE WHEN connector IN ('codex.local','kiro.local') THEN 'task.local.ready' ELSE 'task.remote.ready' END,installation::text,jsonb_build_object('delivery_id',NEW.id,'task_id',NEW.task_id,'execution_id',NEW.execution_id,'installation_id',installation,'available_at',NEW.available_at),NEW.available_at);
 ELSIF NEW.state='delivering' AND (TG_OP='INSERT' OR OLD.state IS DISTINCT FROM NEW.state OR OLD.lease_until IS DISTINCT FROM NEW.lease_until OR OLD.lease_token IS DISTINCT FROM NEW.lease_token) THEN
  INSERT INTO event_outbox(kind,aggregate_id,payload,available_at) VALUES('delivery.deadline',NEW.id::text,jsonb_build_object('delivery_id',NEW.id,'lease_token',NEW.lease_token,'lease_until',NEW.lease_until),NEW.lease_until);
 END IF;
 RETURN NEW;
END; $$;
