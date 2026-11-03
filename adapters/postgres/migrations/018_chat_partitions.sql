-- Transactional maintenance migration: writers pause while both histories are copied.
-- Match writer lock order and fail cleanly instead of waiting indefinitely for traffic.
SET LOCAL lock_timeout = '5s';
LOCK TABLE channels, messages, channel_events, assets IN ACCESS EXCLUSIVE MODE;

CREATE TABLE message_identities (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  task_id uuid UNIQUE,
  user_id uuid,
  client_message_id uuid,
  request_hash text
);
CREATE UNIQUE INDEX message_identities_client_id ON message_identities(workspace_id,user_id,client_message_id)
  WHERE client_message_id IS NOT NULL;
INSERT INTO message_identities SELECT id,workspace_id,channel_id,task_id,user_id,client_message_id,request_hash FROM messages;

-- LIKE preserves every column/default/check, but intentionally excludes old global indexes.
CREATE TABLE messages_partitioned (LIKE messages INCLUDING DEFAULTS INCLUDING CONSTRAINTS) PARTITION BY HASH(channel_id);
ALTER TABLE messages_partitioned ADD PRIMARY KEY(channel_id,id);
ALTER TABLE messages_partitioned
  ADD FOREIGN KEY(workspace_id,thread_id) REFERENCES threads(workspace_id,id),
  ADD FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id),
  ADD FOREIGN KEY(workspace_id,installation_id) REFERENCES agent_installations(workspace_id,id),
  ADD FOREIGN KEY(workspace_id,channel_id,thread_id) REFERENCES threads(workspace_id,channel_id,id),
  ADD FOREIGN KEY(user_id) REFERENCES users(id);
CREATE TABLE channel_events_partitioned (LIKE channel_events INCLUDING DEFAULTS INCLUDING CONSTRAINTS) PARTITION BY HASH(channel_id);
ALTER TABLE channel_events_partitioned ADD PRIMARY KEY(channel_id,sequence),
  ADD FOREIGN KEY(workspace_id,channel_id,thread_id) REFERENCES threads(workspace_id,channel_id,id);
DO $$ BEGIN
  FOR part IN 0..15 LOOP
    EXECUTE format('CREATE TABLE messages_p%s PARTITION OF messages_partitioned FOR VALUES WITH (MODULUS 16, REMAINDER %s)',part,part);
    EXECUTE format('CREATE TABLE channel_events_p%s PARTITION OF channel_events_partitioned FOR VALUES WITH (MODULUS 16, REMAINDER %s)',part,part);
  END LOOP;
END; $$;
-- No sequence allocation or replay triggers run during this copy.
INSERT INTO messages_partitioned SELECT * FROM messages;
INSERT INTO channel_events_partitioned SELECT * FROM channel_events;
DO $$ BEGIN
  IF (SELECT count(*) FROM messages) <> (SELECT count(*) FROM messages_partitioned)
    OR EXISTS(SELECT * FROM messages EXCEPT ALL SELECT * FROM messages_partitioned)
    OR (SELECT count(*) FROM channel_events) <> (SELECT count(*) FROM channel_events_partitioned)
    OR EXISTS(SELECT * FROM channel_events EXCEPT ALL SELECT * FROM channel_events_partitioned) THEN
    RAISE EXCEPTION 'chat partition copy verification failed';
  END IF;
END; $$;
ALTER TABLE messages_partitioned ADD CONSTRAINT messages_identity_fk
  FOREIGN KEY(id) REFERENCES message_identities(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE message_identities ADD CONSTRAINT message_identities_message_fk
  FOREIGN KEY(channel_id,id) REFERENCES messages_partitioned(channel_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE assets DROP CONSTRAINT assets_message_id_fkey;
ALTER TABLE assets ADD CONSTRAINT assets_message_id_fkey FOREIGN KEY(message_id) REFERENCES message_identities(id);

-- The payload function's argument is the old table's composite type, so rebind it explicitly.
DROP FUNCTION chat_message_payload(messages);
DROP TABLE messages;
DROP TABLE channel_events;
ALTER TABLE messages_partitioned RENAME TO messages;
ALTER TABLE channel_events_partitioned RENAME TO channel_events;
CREATE UNIQUE INDEX messages_channel_sequence ON messages(workspace_id,channel_id,sequence);
CREATE INDEX messages_thread_sequence ON messages(workspace_id,channel_id,thread_id,sequence);
CREATE INDEX messages_thread_history ON messages(thread_id,created_at,id);
-- Local uniqueness lets ON CONFLICT DO NOTHING skip rows before AFTER triggers run.
-- The identity registry additionally enforces each original key across all partitions.
CREATE UNIQUE INDEX messages_channel_task ON messages(channel_id,task_id);
CREATE UNIQUE INDEX messages_client_id ON messages(channel_id,workspace_id,user_id,client_message_id) WHERE client_message_id IS NOT NULL;

CREATE FUNCTION maintain_message_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO message_identities(id,workspace_id,channel_id,task_id,user_id,client_message_id,request_hash)
      VALUES(NEW.id,NEW.workspace_id,NEW.channel_id,NEW.task_id,NEW.user_id,NEW.client_message_id,NEW.request_hash);
    RETURN NEW;
  END IF;
  DELETE FROM message_identities WHERE id=OLD.id;
  RETURN OLD;
END; $$;
CREATE TRIGGER messages_identity AFTER INSERT OR DELETE ON messages FOR EACH ROW EXECUTE FUNCTION maintain_message_identity();
CREATE FUNCTION immutable_message_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (NEW.id,NEW.workspace_id,NEW.channel_id,NEW.task_id,NEW.user_id,NEW.client_message_id,NEW.request_hash)
    IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.channel_id,OLD.task_id,OLD.user_id,OLD.client_message_id,OLD.request_hash) THEN
    RAISE EXCEPTION 'message identity is immutable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER messages_immutable_identity BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION immutable_message_identity();
CREATE TRIGGER message_identities_immutable BEFORE UPDATE ON message_identities FOR EACH ROW EXECUTE FUNCTION immutable_message_identity();
CREATE FUNCTION protect_live_message_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  -- Deferred FKs alone permit delete/reinsert with different global keys in one transaction.
  -- The message AFTER DELETE cleanup reaches here only after its message has disappeared.
  IF EXISTS(SELECT 1 FROM messages WHERE channel_id=OLD.channel_id AND id=OLD.id) THEN
    RAISE EXCEPTION 'cannot delete the identity of an existing message' USING ERRCODE='23503';
  END IF;
  RETURN OLD;
END; $$;
CREATE TRIGGER message_identities_protect_delete BEFORE DELETE ON message_identities
  FOR EACH ROW EXECUTE FUNCTION protect_live_message_identity();
CREATE TRIGGER messages_allocate_sequence BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION allocate_message_sequence();
CREATE TRIGGER messages_immutable_sequence BEFORE UPDATE OF sequence,channel_id,workspace_id,thread_id ON messages
  FOR EACH ROW EXECUTE FUNCTION immutable_message_sequence();
CREATE FUNCTION chat_message_payload(m messages) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('id',m.id,'channel_id',m.channel_id,'thread_id',m.thread_id,'task_id',m.task_id,'sequence',m.sequence::text,
    'text',m.text,'document',m.document,'attachments',m.attachments,'created_at',m.created_at,'client_message_id',m.client_message_id,
    'author',jsonb_build_object('kind',m.author_type,'id',coalesce(m.user_id,m.installation_id),
      'name',CASE WHEN m.author_type='human' THEN (SELECT display_name FROM users WHERE id=m.user_id)
        ELSE (SELECT d.name FROM agent_installations i JOIN agent_definitions d ON d.id=i.definition_id WHERE i.id=m.installation_id) END));
$$;
CREATE OR REPLACE FUNCTION message_chat_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO channel_events(workspace_id,channel_id,thread_id,sequence,type,payload)
    VALUES(NEW.workspace_id,NEW.channel_id,NEW.thread_id,NEW.sequence,'message.created',chat_message_payload(NEW::messages));
  RETURN NEW;
END; $$;
CREATE TRIGGER messages_realtime AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION message_chat_event();
CREATE TRIGGER channel_events_immutable BEFORE UPDATE OR DELETE ON channel_events FOR EACH ROW EXECUTE FUNCTION immutable_task_event();

-- Populate parent and leaf planner statistics before traffic resumes.
-- Autovacuum does not refresh inherited statistics on partitioned parents.
ANALYZE messages;
ANALYZE channel_events;
ANALYZE message_identities;
