ALTER TABLE tasks ADD COLUMN request_document jsonb CHECK (request_document IS NULL OR jsonb_typeof(request_document)='object');
CREATE FUNCTION immutable_task_document() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.request_document IS DISTINCT FROM OLD.request_document THEN RAISE EXCEPTION 'task request document is immutable'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER tasks_immutable_document BEFORE UPDATE OF request_document ON tasks FOR EACH ROW EXECUTE FUNCTION immutable_task_document();
