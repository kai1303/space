-- A bounded snapshot committed with extraction progress lets Space validate topics and
-- count distinct threads at the same database snapshot as the current source revisions.
ALTER TABLE memory_extract_threads ADD COLUMN topics jsonb NOT NULL DEFAULT '[]'
  CHECK (jsonb_typeof(topics) = 'array' AND jsonb_array_length(topics) <= 5);
CREATE INDEX memory_extract_channel_topics ON memory_extract_threads(channel_id, thread_id) WHERE topics <> '[]'::jsonb;

CREATE VIEW live_memory_topics AS
 SELECT t.channel_id, t.thread_id, topic.name
 FROM memory_extract_threads t
 CROSS JOIN LATERAL jsonb_to_recordset(t.topics) AS topic(name text, evidence jsonb)
 WHERE t.topics <> '[]'::jsonb AND topic.evidence <> '{}'::jsonb
 AND NOT EXISTS (
   SELECT 1 FROM jsonb_each_text(topic.evidence) e
   WHERE NOT EXISTS (
     SELECT 1 FROM memory_source_messages m WHERE m.channel_id=t.channel_id AND m.thread_id=t.thread_id
       AND m.id=e.key::uuid AND m.agent_session_id IS NULL AND m.search_revision=e.value::bigint
   )
 );

-- The live view also protects reads while worker operations are in flight. Drop the
-- stored labels as part of the source change, including for channels with extraction off.
CREATE FUNCTION drop_invalid_memory_topics() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE memory_extract_threads t SET topics=coalesce((
   SELECT jsonb_agg(x.topic ORDER BY x.ordinal)
   FROM jsonb_array_elements(t.topics) WITH ORDINALITY AS x(topic, ordinal)
   WHERE NOT ((x.topic->'evidence') ? OLD.id::text)
 ), '[]'::jsonb)
 WHERE thread_id=OLD.thread_id AND topics <> '[]'::jsonb AND EXISTS (
   SELECT 1 FROM jsonb_array_elements(t.topics) topic WHERE (topic->'evidence') ? OLD.id::text
 );
 RETURN NULL;
END; $$;
CREATE TRIGGER drop_edited_memory_topics AFTER UPDATE ON messages FOR EACH ROW
 WHEN ((OLD.search_revision,OLD.agent_session_id,OLD.retained_at,OLD.deleted_at)
   IS DISTINCT FROM (NEW.search_revision,NEW.agent_session_id,NEW.retained_at,NEW.deleted_at))
 EXECUTE FUNCTION drop_invalid_memory_topics();
CREATE TRIGGER drop_deleted_memory_topics AFTER DELETE ON messages FOR EACH ROW
 EXECUTE FUNCTION drop_invalid_memory_topics();

-- Regenerate topic links written by older workers without proof of their sources.
UPDATE memory_extract_threads t SET generation=generation+1, done_through=0, attempts=0, waiting_for_index=false,
 available_at=CASE WHEN c.memory_enabled AND c.archived_at IS NULL AND (SELECT enabled FROM memory_extract_config)
   THEN now()+interval '60 seconds' ELSE 'infinity' END
 FROM channels c WHERE c.id=t.channel_id;

-- Restoring the channel index also needs to regenerate its facts and topics. A durable
-- cursor bounds work per broker delivery, including after the graph slot was lost.
ALTER TABLE memory_extract_config ADD COLUMN restores_pending boolean NOT NULL DEFAULT false;
CREATE TABLE memory_extract_restores (
 channel_id uuid PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
 revision bigint NOT NULL, after_thread uuid, pending boolean NOT NULL DEFAULT true
);
CREATE INDEX pending_memory_restores ON memory_extract_restores(channel_id) WHERE pending;
CREATE INDEX memory_extract_channel_threads ON memory_extract_threads(channel_id, thread_id);

CREATE FUNCTION request_memory_restore() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE activation bigint;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM memory_extract_threads WHERE channel_id=NEW.id) THEN RETURN NULL; END IF;
 INSERT INTO memory_extract_restores(channel_id, revision) VALUES(NEW.id, 1)
 ON CONFLICT(channel_id) DO UPDATE SET revision=memory_extract_restores.revision+1,after_thread=NULL,pending=true
 RETURNING revision INTO activation;
 -- When activation races this request, either the activation sees the committed cursor
 -- or its conditional update wins and this request sees an already-enabled model.
 UPDATE memory_extract_config SET restores_pending=true WHERE NOT enabled;
 IF NOT FOUND THEN
   INSERT INTO event_outbox(kind,aggregate_id,payload) VALUES ('memory.extract.restore',NEW.id::text,
     jsonb_build_object('revision',activation::text));
 END IF;
 RETURN NULL;
END; $$;
CREATE TRIGGER channel_memory_restored AFTER UPDATE OF archived_at,memory_enabled ON channels FOR EACH ROW
 WHEN (NEW.kind='channel' AND NEW.memory_enabled AND NEW.archived_at IS NULL
       AND (NOT OLD.memory_enabled OR OLD.archived_at IS NOT NULL))
 EXECUTE FUNCTION request_memory_restore();

CREATE FUNCTION resume_memory_restores() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO event_outbox(kind,aggregate_id,payload)
 SELECT 'memory.extract.restore',r.channel_id::text,jsonb_build_object('revision',r.revision::text,'after_thread',r.after_thread)
 FROM memory_extract_restores r JOIN channels c ON c.id=r.channel_id
 WHERE r.pending AND c.memory_enabled AND c.archived_at IS NULL;
 RETURN NULL;
END; $$;
CREATE TRIGGER resume_memory_restores AFTER UPDATE OF enabled ON memory_extract_config FOR EACH ROW
 WHEN (NEW.enabled AND NOT OLD.enabled AND OLD.restores_pending) EXECUTE FUNCTION resume_memory_restores();

CREATE FUNCTION restore_memory_extract_page(channel uuid, activation bigint, cursor_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE batch uuid[]; last_thread uuid;
BEGIN
 SELECT array_agg(id ORDER BY id) INTO batch FROM (
   SELECT t.thread_id AS id FROM memory_extract_threads t JOIN memory_extract_restores r USING(channel_id)
   JOIN channels c ON c.id=t.channel_id
   WHERE r.channel_id=channel AND r.pending AND r.revision=activation AND r.after_thread IS NOT DISTINCT FROM cursor_id
     AND (cursor_id IS NULL OR t.thread_id>cursor_id) AND c.memory_enabled AND c.archived_at IS NULL
     AND (SELECT enabled FROM memory_extract_config)
   ORDER BY t.thread_id LIMIT 128
 ) page;
 last_thread := batch[cardinality(batch)];
 UPDATE memory_extract_restores SET after_thread=last_thread,pending=coalesce(cardinality(batch),0)=128
 WHERE channel_id=channel AND pending AND revision=activation AND after_thread IS NOT DISTINCT FROM cursor_id
   AND (SELECT enabled FROM memory_extract_config)
   AND EXISTS (SELECT 1 FROM channels WHERE id=channel AND memory_enabled AND archived_at IS NULL);
 IF NOT FOUND OR batch IS NULL THEN RETURN; END IF;
 UPDATE memory_extract_threads t SET generation=t.generation+1, done_through=0,topics='[]',
   pending_through=greatest(t.pending_through, coalesce((SELECT max(m.sequence) FROM messages m WHERE m.channel_id=channel
     AND m.thread_id=t.thread_id AND m.agent_session_id IS NULL AND m.deleted_at IS NULL AND m.retained_at IS NULL),0)),
   waiting_for_index=false,attempts=0,available_at=greatest(now()+interval '60 seconds',t.last_run_at+interval '5 minutes')
 WHERE t.channel_id=channel AND t.thread_id=ANY(batch);
 IF cardinality(batch)=128 THEN
   INSERT INTO event_outbox(kind,aggregate_id,payload) VALUES ('memory.extract.restore',channel::text,
     jsonb_build_object('revision',activation::text,'after_thread',last_thread));
 END IF;
END; $$;
