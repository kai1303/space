-- Lock in writer order while installing allocation triggers and backfilling history.
LOCK TABLE channels, messages IN ACCESS EXCLUSIVE MODE;
ALTER TABLE messages ADD COLUMN sequence bigint;

-- Preserve the original message.created ordering without rewriting immutable events.
UPDATE messages m SET sequence=e.sequence
FROM (
  SELECT channel_id,payload->>'id' AS message_id,min(sequence) AS sequence
  FROM channel_events WHERE type='message.created'
  GROUP BY channel_id,payload->>'id'
) e WHERE m.channel_id=e.channel_id AND m.id::text=e.message_id;

-- Repair the counter defensively before allocating sequences for any legacy orphan rows.
UPDATE channels c SET event_sequence=greatest(c.event_sequence,e.sequence)
FROM (SELECT channel_id,max(sequence) AS sequence FROM channel_events GROUP BY channel_id) e
WHERE c.id=e.channel_id;
DO $$ DECLARE m record; seq bigint; BEGIN
  FOR m IN SELECT id,channel_id FROM messages WHERE sequence IS NULL ORDER BY created_at,id LOOP
    UPDATE channels SET event_sequence=event_sequence+1 WHERE id=m.channel_id RETURNING event_sequence INTO STRICT seq;
    UPDATE messages SET sequence=seq WHERE id=m.id;
  END LOOP;
END; $$;
ALTER TABLE messages ALTER COLUMN sequence SET NOT NULL;
ALTER TABLE messages ALTER COLUMN sequence SET DEFAULT 0;
ALTER TABLE messages ADD CONSTRAINT messages_positive_sequence CHECK(sequence > 0);
CREATE UNIQUE INDEX messages_channel_sequence ON messages(workspace_id,channel_id,sequence);
CREATE INDEX messages_thread_sequence ON messages(workspace_id,channel_id,thread_id,sequence);

CREATE FUNCTION allocate_message_sequence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  -- The channel row lock serializes every writer, including direct agent inserts.
  UPDATE channels SET event_sequence=event_sequence+1
    WHERE id=NEW.channel_id AND workspace_id=NEW.workspace_id RETURNING event_sequence INTO STRICT NEW.sequence;
  RETURN NEW;
END; $$;
CREATE TRIGGER messages_allocate_sequence BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION allocate_message_sequence();
CREATE FUNCTION immutable_message_sequence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (NEW.sequence,NEW.channel_id,NEW.workspace_id,NEW.thread_id) IS DISTINCT FROM (OLD.sequence,OLD.channel_id,OLD.workspace_id,OLD.thread_id) THEN
    RAISE EXCEPTION 'message sequence and scope are immutable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER messages_immutable_sequence BEFORE UPDATE OF sequence,channel_id,workspace_id,thread_id ON messages
  FOR EACH ROW EXECUTE FUNCTION immutable_message_sequence();

CREATE OR REPLACE FUNCTION chat_message_payload(m messages) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('id',m.id,'channel_id',m.channel_id,'thread_id',m.thread_id,'task_id',m.task_id,'sequence',m.sequence::text,
    'text',m.text,'document',m.document,'attachments',m.attachments,'created_at',m.created_at,'client_message_id',m.client_message_id,
    'author',jsonb_build_object('kind',m.author_type,'id',coalesce(m.user_id,m.installation_id),
      'name',CASE WHEN m.author_type='human' THEN (SELECT display_name FROM users WHERE id=m.user_id)
        ELSE (SELECT d.name FROM agent_installations i JOIN agent_definitions d ON d.id=i.definition_id WHERE i.id=m.installation_id) END));
$$;
CREATE OR REPLACE FUNCTION message_chat_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO channel_events(workspace_id,channel_id,thread_id,sequence,type,payload)
    VALUES(NEW.workspace_id,NEW.channel_id,NEW.thread_id,NEW.sequence,'message.created',chat_message_payload(NEW));
  RETURN NEW;
END; $$;
