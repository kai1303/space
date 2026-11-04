ALTER TABLE navigator_inferences ADD COLUMN started_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE event_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 kind text NOT NULL, aggregate_id text NOT NULL, payload jsonb NOT NULL,
 available_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(octet_length(payload::text)<=524288)
);
CREATE INDEX event_outbox_bootstrap ON event_outbox(created_at,id);
CREATE FUNCTION enqueue_stream_chat() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO event_outbox(kind,aggregate_id,payload) VALUES('chat.changed',coalesce(NEW.channel_id::text,'all'),jsonb_build_object('channel_id',NEW.channel_id,'chat_delivery_id',NEW.id::text));
 RETURN NEW;
END; $$;
CREATE TRIGGER chat_stream_event AFTER INSERT ON chat_delivery_outbox FOR EACH ROW EXECUTE FUNCTION enqueue_stream_chat();
CREATE FUNCTION enqueue_stream_task() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE installation uuid; connector text;
BEGIN
 SELECT t.installation_id,i.connector_id INTO installation,connector FROM tasks t JOIN agent_installations i ON i.id=t.installation_id WHERE t.id=NEW.task_id;
 IF NEW.state='pending' AND (TG_OP='INSERT' OR OLD.state IS DISTINCT FROM NEW.state OR OLD.available_at IS DISTINCT FROM NEW.available_at) THEN
  INSERT INTO event_outbox(kind,aggregate_id,payload,available_at) VALUES(CASE WHEN connector='codex.local' THEN 'task.local.ready' ELSE 'task.remote.ready' END,installation::text,jsonb_build_object('delivery_id',NEW.id,'task_id',NEW.task_id,'execution_id',NEW.execution_id,'installation_id',installation,'available_at',NEW.available_at),NEW.available_at);
 ELSIF NEW.state='delivering' AND (TG_OP='INSERT' OR OLD.state IS DISTINCT FROM NEW.state OR OLD.lease_until IS DISTINCT FROM NEW.lease_until OR OLD.lease_token IS DISTINCT FROM NEW.lease_token) THEN
  INSERT INTO event_outbox(kind,aggregate_id,payload,available_at) VALUES('delivery.deadline',NEW.id::text,jsonb_build_object('delivery_id',NEW.id,'lease_token',NEW.lease_token,'lease_until',NEW.lease_until),NEW.lease_until);
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER task_stream_event AFTER INSERT OR UPDATE ON outbox FOR EACH ROW EXECUTE FUNCTION enqueue_stream_task();
CREATE FUNCTION enqueue_stream_navigation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF isfinite(NEW.available_at) AND (TG_OP='INSERT' OR OLD.available_at IS DISTINCT FROM NEW.available_at) THEN
  INSERT INTO event_outbox(kind,aggregate_id,payload,available_at) VALUES('navigator.ready',NEW.thread_id::text,jsonb_build_object('thread_id',NEW.thread_id,'available_at',NEW.available_at),NEW.available_at);
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER navigator_stream_event AFTER INSERT OR UPDATE ON navigator_threads FOR EACH ROW EXECUTE FUNCTION enqueue_stream_navigation();
CREATE FUNCTION enqueue_stream_connection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.connection_id IS NOT NULL AND NEW.last_seen_at IS NOT NULL AND NEW.revoked_at IS NULL AND (TG_OP='INSERT' OR OLD.connection_id IS DISTINCT FROM NEW.connection_id OR OLD.last_seen_at IS DISTINCT FROM NEW.last_seen_at) THEN
  INSERT INTO event_outbox(kind,aggregate_id,payload,available_at) VALUES('connection.deadline',NEW.installation_id::text,jsonb_build_object('installation_id',NEW.installation_id,'connection_id',NEW.connection_id,'last_seen_at',NEW.last_seen_at),NEW.last_seen_at+interval '45 seconds');
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER connection_stream_event AFTER INSERT OR UPDATE ON agent_connections FOR EACH ROW EXECUTE FUNCTION enqueue_stream_connection();
CREATE FUNCTION enqueue_stream_asset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' OR OLD.expires_at IS DISTINCT FROM NEW.expires_at OR OLD.status IS DISTINCT FROM NEW.status OR OLD.staging_deleted_at IS DISTINCT FROM NEW.staging_deleted_at OR OLD.processing_until IS DISTINCT FROM NEW.processing_until THEN
  IF NEW.message_id IS NULL THEN
   INSERT INTO event_outbox(kind,aggregate_id,payload,available_at) VALUES('asset.deadline',NEW.id::text,jsonb_build_object('asset_id',NEW.id),NEW.expires_at);
  END IF;
  IF NEW.status='ready' AND NEW.staging_deleted_at IS NULL THEN
   INSERT INTO event_outbox(kind,aggregate_id,payload,available_at) VALUES('asset.deadline',NEW.id::text,jsonb_build_object('asset_id',NEW.id),GREATEST(NEW.upload_expires_at,coalesce(NEW.processing_until,NEW.upload_expires_at)));
  END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER asset_stream_event AFTER INSERT OR UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION enqueue_stream_asset();
-- Seed once during migration. Subsequent recovery uses WAL and broker cursors.
INSERT INTO event_outbox(kind,aggregate_id,payload) SELECT 'chat.changed',coalesce(channel_id::text,'all'),jsonb_build_object('channel_id',channel_id,'chat_delivery_id',id::text) FROM chat_delivery_outbox;
INSERT INTO event_outbox(kind,aggregate_id,payload,available_at)
 SELECT CASE WHEN i.connector_id='codex.local' THEN 'task.local.ready' ELSE 'task.remote.ready' END,t.installation_id::text,jsonb_build_object('delivery_id',o.id,'task_id',o.task_id,'execution_id',o.execution_id,'installation_id',t.installation_id,'available_at',o.available_at),o.available_at
 FROM outbox o JOIN tasks t ON t.id=o.task_id JOIN agent_installations i ON i.id=t.installation_id WHERE o.state='pending';
INSERT INTO event_outbox(kind,aggregate_id,payload,available_at) SELECT 'delivery.deadline',id::text,jsonb_build_object('delivery_id',id,'lease_token',lease_token,'lease_until',lease_until),lease_until FROM outbox WHERE state='delivering';
INSERT INTO event_outbox(kind,aggregate_id,payload,available_at) SELECT 'navigator.ready',thread_id::text,jsonb_build_object('thread_id',thread_id,'available_at',available_at),available_at FROM navigator_threads WHERE isfinite(available_at);
INSERT INTO event_outbox(kind,aggregate_id,payload,available_at) SELECT 'connection.deadline',installation_id::text,jsonb_build_object('installation_id',installation_id,'connection_id',connection_id,'last_seen_at',last_seen_at),last_seen_at+interval '45 seconds' FROM agent_connections WHERE connection_id IS NOT NULL AND last_seen_at IS NOT NULL AND revoked_at IS NULL;
INSERT INTO event_outbox(kind,aggregate_id,payload,available_at) SELECT 'asset.deadline',id::text,jsonb_build_object('asset_id',id),expires_at FROM assets WHERE message_id IS NULL;
INSERT INTO event_outbox(kind,aggregate_id,payload,available_at) SELECT 'asset.deadline',id::text,jsonb_build_object('asset_id',id),upload_expires_at FROM assets WHERE status='ready' AND staging_deleted_at IS NULL;

CREATE FUNCTION wake_navigation_after_task() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.status IN ('completed','failed','rejected') AND OLD.status IS DISTINCT FROM NEW.status THEN
  UPDATE navigator_threads n SET available_at=now() WHERE n.thread_id=NEW.thread_id AND EXISTS(SELECT 1 FROM messages m WHERE m.thread_id=n.thread_id AND m.author_type='human' AND m.sequence>n.last_sequence);
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER task_terminal_navigation AFTER UPDATE OF status ON tasks FOR EACH ROW EXECUTE FUNCTION wake_navigation_after_task();
