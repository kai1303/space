ALTER TABLE assets ADD COLUMN task_id uuid REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE assets ADD CONSTRAINT asset_task_owner CHECK (task_id IS NULL OR (message_id IS NULL AND status='ready'));
CREATE INDEX assets_task ON assets(task_id) WHERE task_id IS NOT NULL;
ALTER TABLE tasks ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]' CHECK (
  jsonb_typeof(attachments)='array' AND jsonb_array_length(attachments)<=5
);

CREATE OR REPLACE FUNCTION enqueue_stream_asset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' OR OLD.task_id IS DISTINCT FROM NEW.task_id OR OLD.expires_at IS DISTINCT FROM NEW.expires_at OR OLD.status IS DISTINCT FROM NEW.status OR OLD.staging_deleted_at IS DISTINCT FROM NEW.staging_deleted_at OR OLD.processing_until IS DISTINCT FROM NEW.processing_until THEN
  IF NEW.message_id IS NULL AND NEW.task_id IS NULL THEN
   INSERT INTO event_outbox(kind,aggregate_id,payload,available_at) VALUES('asset.deadline',NEW.id::text,jsonb_build_object('asset_id',NEW.id),NEW.expires_at);
  END IF;
  IF NEW.status='ready' AND NEW.staging_deleted_at IS NULL THEN
   INSERT INTO event_outbox(kind,aggregate_id,payload,available_at) VALUES('asset.deadline',NEW.id::text,jsonb_build_object('asset_id',NEW.id),GREATEST(NEW.upload_expires_at,coalesce(NEW.processing_until,NEW.upload_expires_at)));
  END IF;
 END IF;
 RETURN NEW;
END; $$;
