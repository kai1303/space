-- Preserve the operation on the existing invalidation so CDC can distinguish
-- committed message inserts from edits, removals and initial search backfills.
CREATE OR REPLACE FUNCTION enqueue_message_search() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.search_revision=OLD.search_revision THEN RETURN NULL; END IF;
  INSERT INTO event_outbox(kind,aggregate_id,payload)
    VALUES('search.message',coalesce(NEW.id,OLD.id)::text,
      jsonb_build_object('message_id',coalesce(NEW.id,OLD.id),'channel_id',coalesce(NEW.channel_id,OLD.channel_id),'operation',TG_OP));
  RETURN NULL;
END; $$;
