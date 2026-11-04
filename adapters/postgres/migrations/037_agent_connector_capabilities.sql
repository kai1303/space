ALTER TABLE agent_pairings ALTER COLUMN provider DROP NOT NULL;
ALTER TABLE agent_pairings ADD COLUMN connector_id text NOT NULL DEFAULT 'codex.local';
ALTER TABLE agent_pairings ADD COLUMN descriptor jsonb;
UPDATE agent_pairings SET connector_id='kiro.local' WHERE provider='kiro';
UPDATE agent_definitions SET capabilities=capabilities || '{"persistent_sessions":true}'::jsonb WHERE id IN ('41a5de8a-63df-4c25-8666-1d0290bc921f','f6090a5c-8959-4674-aec1-f7e611f35c42');

CREATE OR REPLACE FUNCTION enqueue_stream_task() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE installation uuid; paired boolean;
BEGIN
 SELECT t.installation_id,EXISTS(SELECT 1 FROM agent_connections ac WHERE ac.installation_id=t.installation_id) INTO installation,paired FROM tasks t WHERE t.id=NEW.task_id;
 IF NEW.state='pending' AND (TG_OP='INSERT' OR OLD.state IS DISTINCT FROM NEW.state OR OLD.available_at IS DISTINCT FROM NEW.available_at) THEN
  INSERT INTO event_outbox(kind,aggregate_id,payload,available_at) VALUES(CASE WHEN paired THEN 'task.local.ready' ELSE 'task.remote.ready' END,installation::text,jsonb_build_object('delivery_id',NEW.id,'task_id',NEW.task_id,'execution_id',NEW.execution_id,'installation_id',installation,'available_at',NEW.available_at),NEW.available_at);
 ELSIF NEW.state='delivering' AND (TG_OP='INSERT' OR OLD.state IS DISTINCT FROM NEW.state OR OLD.lease_until IS DISTINCT FROM NEW.lease_until OR OLD.lease_token IS DISTINCT FROM NEW.lease_token) THEN
  INSERT INTO event_outbox(kind,aggregate_id,payload,available_at) VALUES('delivery.deadline',NEW.id::text,jsonb_build_object('delivery_id',NEW.id,'lease_token',NEW.lease_token,'lease_until',NEW.lease_until),NEW.lease_until);
 END IF;
 RETURN NEW;
END; $$;
