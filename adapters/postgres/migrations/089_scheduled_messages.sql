-- Scheduled sends, like Slack. The broker holds each deadline; no process scans this table.
-- status: pending → sending → sent, or cancelled / failed. version changes whenever send_at changes,
-- so a deadline event for an older version becomes a no-op.
CREATE TABLE scheduled_messages (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  channel_id uuid NOT NULL REFERENCES channels(id),
  thread_id uuid,
  user_id uuid NOT NULL REFERENCES users(id),
  request_hash text NOT NULL,
  text text NOT NULL,
  document jsonb,
  asset_ids uuid[] NOT NULL DEFAULT '{}',
  asset_descriptions jsonb,
  send_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','cancelled','failed')),
  version integer NOT NULL DEFAULT 1,
  message_id uuid,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(asset_ids) <= 5),
  CHECK (status <> 'sent' OR message_id IS NOT NULL)
);
CREATE INDEX scheduled_messages_owner ON scheduled_messages(workspace_id,user_id,send_at) WHERE status IN ('pending','sending','failed');

CREATE FUNCTION prepare_scheduled_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.send_at IS DISTINCT FROM OLD.send_at THEN NEW.version=OLD.version+1; END IF;
  NEW.updated_at=clock_timestamp();
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER scheduled_message_version BEFORE UPDATE ON scheduled_messages FOR EACH ROW EXECUTE FUNCTION prepare_scheduled_message();

-- The row and its deadline event commit together; the bridge publishes it with send_at as the broker schedule.
CREATE FUNCTION enqueue_scheduled_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.status='pending' AND (TG_OP='INSERT' OR NEW.version IS DISTINCT FROM OLD.version) THEN
  INSERT INTO event_outbox(kind,aggregate_id,payload,available_at) VALUES('scheduled.message_due',NEW.id::text,
   jsonb_build_object('scheduled_id',NEW.id,'version',NEW.version),NEW.send_at);
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER scheduled_message_event AFTER INSERT OR UPDATE ON scheduled_messages FOR EACH ROW EXECUTE FUNCTION enqueue_scheduled_message();
