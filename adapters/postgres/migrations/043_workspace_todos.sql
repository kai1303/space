-- The API bounds compact JSON at 32 KiB; JSONB text expands spacing, so the
-- storage guard allows 64 KiB while remaining independently bounded.
ALTER TABLE hub_todos
 ADD COLUMN document jsonb,
 ADD COLUMN remind_at timestamptz,
 ADD COLUMN reminder_fired_at timestamptz,
 ADD COLUMN reminder_version integer NOT NULL DEFAULT 0,
 ADD COLUMN archived boolean NOT NULL DEFAULT false,
 ADD COLUMN deleted boolean NOT NULL DEFAULT false,
 ADD COLUMN channel_id uuid,
 ADD COLUMN message_id uuid,
 ADD CONSTRAINT hub_todos_source_pair CHECK ((channel_id IS NULL) = (message_id IS NULL)),
 ADD CONSTRAINT hub_todos_document_size CHECK (document IS NULL OR octet_length(document::text)<=65536),
 ADD CONSTRAINT hub_todos_remind_finite CHECK (remind_at IS NULL OR isfinite(remind_at));
CREATE INDEX hub_todos_due_page ON hub_todos(workspace_id,user_id,archived,remind_at,id) WHERE NOT deleted;
CREATE INDEX hub_todos_created_page ON hub_todos(workspace_id,user_id,archived,created_at,id) WHERE NOT deleted;
-- Source references deliberately survive source deletion. Reads and delivery
-- reauthorize against the live source; the copied body never grants access.
CREATE FUNCTION prepare_todo_reminder() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.remind_at IS NOT NULL THEN NEW.reminder_version=1; END IF;
 ELSIF NEW.remind_at IS DISTINCT FROM OLD.remind_at OR (OLD.completed AND NOT NEW.completed) OR (OLD.archived AND NOT NEW.archived) OR (OLD.deleted AND NOT NEW.deleted) THEN
  NEW.reminder_version=OLD.reminder_version+1;
  NEW.reminder_fired_at=NULL;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER todo_reminder_version BEFORE INSERT OR UPDATE ON hub_todos FOR EACH ROW EXECUTE FUNCTION prepare_todo_reminder();
CREATE FUNCTION enqueue_todo_reminder() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.remind_at IS NOT NULL AND NOT NEW.completed AND NOT NEW.archived AND NOT NEW.deleted AND (TG_OP='INSERT' OR NEW.reminder_version IS DISTINCT FROM OLD.reminder_version) THEN
  INSERT INTO event_outbox(kind,aggregate_id,payload,available_at) VALUES('todo.reminder_due',NEW.id::text,jsonb_build_object('todo_id',NEW.id,'remind_at',NEW.remind_at,'reminder_version',NEW.reminder_version),NEW.remind_at);
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER todo_reminder_event AFTER INSERT OR UPDATE ON hub_todos FOR EACH ROW EXECUTE FUNCTION enqueue_todo_reminder();
