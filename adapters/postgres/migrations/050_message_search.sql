CREATE TABLE message_search_state (id boolean PRIMARY KEY DEFAULT true CHECK(id), enabled boolean NOT NULL DEFAULT false);
INSERT INTO message_search_state(id) VALUES(true);
CREATE SEQUENCE message_search_order_seq MAXVALUE 9007199254740991;
ALTER TABLE messages ADD COLUMN search_order bigint NOT NULL DEFAULT nextval('message_search_order_seq');
-- The revision is local to a message. Reaction changes do not rebuild its search document.
ALTER TABLE messages ADD COLUMN search_revision bigint NOT NULL DEFAULT 1
  CHECK (search_revision BETWEEN 1 AND 9007199254740991);
CREATE FUNCTION advance_message_search_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  NEW.search_order := OLD.search_order;
  IF (NEW.text,NEW.document,NEW.attachments,NEW.agent_session_id) IS DISTINCT FROM
     (OLD.text,OLD.document,OLD.attachments,OLD.agent_session_id) THEN
    NEW.search_revision := OLD.search_revision + 1;
  ELSE
    NEW.search_revision := OLD.search_revision;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER messages_search_revision BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION advance_message_search_revision();
CREATE FUNCTION enqueue_message_search() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN
    INSERT INTO event_outbox(kind,aggregate_id,payload) VALUES('search.message',OLD.id::text,
      jsonb_build_object('message_id',OLD.id,'channel_id',OLD.channel_id));
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' OR NEW.search_revision IS DISTINCT FROM OLD.search_revision THEN
    INSERT INTO event_outbox(kind,aggregate_id,payload) VALUES('search.message',NEW.id::text,
      jsonb_build_object('message_id',NEW.id,'channel_id',NEW.channel_id));
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER messages_search_event AFTER INSERT OR UPDATE OR DELETE ON messages
  FOR EACH ROW EXECUTE FUNCTION enqueue_message_search();
-- SEARCH uses interest retention: unconfigured installations retain no broker backlog.
-- Always emit invalidations, including transactions that commit across first-time activation.
-- A configured consumer enables indexing and enqueues a durable, paginated initial backfill.
