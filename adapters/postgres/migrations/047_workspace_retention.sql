-- Retention is opt-in. Identity and task audit records survive content expiry.
ALTER TABLE messages ADD COLUMN retained_at timestamptz;
ALTER TABLE workspace_preferences ADD COLUMN retention_version bigint NOT NULL DEFAULT 0;
CREATE INDEX messages_retention_page ON messages(workspace_id,id) WHERE retained_at IS NULL;
CREATE INDEX channel_events_retention_source ON channel_events(channel_id,(payload->>'id')) WHERE type IN ('message.created','message.updated');
CREATE TABLE workspace_retention_batches (
 workspace_id uuid NOT NULL REFERENCES workspaces(id), version bigint NOT NULL,
 after_id uuid NOT NULL, PRIMARY KEY(workspace_id,version,after_id)
);
CREATE TABLE retention_asset_deletions (
 id uuid PRIMARY KEY, object_keys jsonb NOT NULL CHECK(jsonb_typeof(object_keys)='array'), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION prepare_workspace_retention() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN NEW.retention_version=CASE WHEN NEW.retention_days IS NULL THEN 0 ELSE 1 END;
 ELSIF NEW.retention_days IS DISTINCT FROM OLD.retention_days THEN NEW.retention_version=OLD.retention_version+1;
 ELSE NEW.retention_version=OLD.retention_version;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER workspace_retention_version BEFORE INSERT OR UPDATE ON workspace_preferences FOR EACH ROW EXECUTE FUNCTION prepare_workspace_retention();
CREATE FUNCTION enqueue_workspace_retention() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.retention_days IS NOT NULL AND (TG_OP='INSERT' OR NEW.retention_version IS DISTINCT FROM OLD.retention_version) THEN
  INSERT INTO event_outbox(kind,aggregate_id,payload) VALUES('retention.backfill',NEW.workspace_id::text,jsonb_build_object('workspace_id',NEW.workspace_id,'version',NEW.retention_version::text,'after_id','00000000-0000-0000-0000-000000000000'));
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER workspace_retention_schedule AFTER INSERT OR UPDATE ON workspace_preferences FOR EACH ROW EXECUTE FUNCTION enqueue_workspace_retention();
CREATE FUNCTION enqueue_message_retention() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO event_outbox(kind,aggregate_id,payload,available_at)
 SELECT 'retention.message_due',NEW.id::text,jsonb_build_object('workspace_id',NEW.workspace_id,'channel_id',NEW.channel_id,'message_id',NEW.id,'version',coalesce(p.retention_version,0)::text),NEW.created_at+make_interval(days=>coalesce(p.retention_days,1))
 FROM (SELECT 1) seed LEFT JOIN workspace_preferences p ON p.workspace_id=NEW.workspace_id;
 RETURN NEW;
END; $$;
CREATE TRIGGER message_retention_schedule AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION enqueue_message_retention();
CREATE FUNCTION protect_retained_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.retained_at IS NOT NULL AND (NEW.text<>'Message removed by workspace retention.' OR NEW.document IS NOT NULL OR NEW.attachments<>'[]'::jsonb OR NEW.agent_response IS NOT NULL)
  OR OLD.retained_at IS NOT NULL AND NEW.retained_at IS DISTINCT FROM OLD.retained_at THEN
  RAISE EXCEPTION 'retained message content cannot be restored';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER messages_retention_guard BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION protect_retained_message();
CREATE FUNCTION retained_message_payload(payload jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT (payload-'text'-'document'-'attachments'-'agent_response'-'agent_sessions') || jsonb_build_object('text','Message removed by workspace retention.','document',NULL,'attachments','[]'::jsonb,'agent_sessions','[]'::jsonb);
$$;
-- Permit only erasure of the exact message content; task events and event identities stay immutable.
CREATE FUNCTION protect_channel_event_retention() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' AND OLD.type IN ('message.created','message.updated')
  AND (to_jsonb(NEW)-'payload')=(to_jsonb(OLD)-'payload')
  AND NEW.payload=retained_message_payload(OLD.payload)
  AND EXISTS(SELECT 1 FROM messages m WHERE m.workspace_id=OLD.workspace_id AND m.channel_id=OLD.channel_id AND m.id::text=OLD.payload->>'id' AND m.retained_at IS NOT NULL)
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'channel events are append-only except message retention erasure';
END; $$;
DROP TRIGGER channel_events_immutable ON channel_events;
CREATE TRIGGER channel_events_immutable BEFORE UPDATE OR DELETE ON channel_events FOR EACH ROW EXECUTE FUNCTION protect_channel_event_retention();
-- One upgrade seed; subsequent recovery is driven exclusively by durable events.
INSERT INTO event_outbox(kind,aggregate_id,payload)
 SELECT 'retention.backfill',workspace_id::text,jsonb_build_object('workspace_id',workspace_id,'version',retention_version::text,'after_id','00000000-0000-0000-0000-000000000000') FROM workspace_preferences WHERE retention_days IS NOT NULL;
