ALTER TABLE channels ADD COLUMN name text NOT NULL DEFAULT 'general' CHECK (length(btrim(name)) BETWEEN 1 AND 80);
ALTER TABLE channels ADD COLUMN private boolean NOT NULL DEFAULT true;
ALTER TABLE channels ADD COLUMN created_by uuid REFERENCES users;
ALTER TABLE channels ADD COLUMN event_sequence bigint NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE messages ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE messages ALTER COLUMN installation_id DROP NOT NULL;
ALTER TABLE messages ADD COLUMN channel_id uuid;
UPDATE messages m SET channel_id=t.channel_id FROM threads t WHERE t.id=m.thread_id;
ALTER TABLE messages ALTER COLUMN channel_id SET NOT NULL;
ALTER TABLE threads ADD UNIQUE(workspace_id,channel_id,id);
ALTER TABLE messages ADD FOREIGN KEY(workspace_id,channel_id,thread_id) REFERENCES threads(workspace_id,channel_id,id);
ALTER TABLE messages ADD COLUMN author_type text NOT NULL DEFAULT 'agent';
ALTER TABLE messages ADD COLUMN user_id uuid REFERENCES users;
ALTER TABLE messages ADD COLUMN client_message_id uuid;
ALTER TABLE messages ADD COLUMN request_hash text;
ALTER TABLE messages ADD CONSTRAINT message_author CHECK (
  (author_type='human' AND user_id IS NOT NULL AND installation_id IS NULL AND task_id IS NULL AND client_message_id IS NOT NULL AND request_hash IS NOT NULL)
  OR (author_type='agent' AND user_id IS NULL AND installation_id IS NOT NULL AND task_id IS NOT NULL AND client_message_id IS NULL AND request_hash IS NULL)
);
CREATE UNIQUE INDEX messages_client_id ON messages(workspace_id,user_id,client_message_id) WHERE client_message_id IS NOT NULL;
CREATE INDEX messages_thread_history ON messages(thread_id,created_at,id);
CREATE TABLE channel_events (
  workspace_id uuid NOT NULL, channel_id uuid NOT NULL, thread_id uuid NOT NULL,
  sequence bigint NOT NULL, type text NOT NULL CHECK(type IN ('message.created','task.event')),
  payload jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(channel_id,sequence),
  FOREIGN KEY(workspace_id,channel_id,thread_id) REFERENCES threads(workspace_id,channel_id,id)
);
CREATE TRIGGER channel_events_immutable BEFORE UPDATE OR DELETE ON channel_events FOR EACH ROW EXECUTE FUNCTION immutable_task_event();

CREATE FUNCTION append_chat_event(channel uuid, thread uuid, event_type text, data jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE seq bigint; workspace uuid;
BEGIN
  -- Row locking serializes sequence allocation and commit order per channel.
  UPDATE channels SET event_sequence=event_sequence+1 WHERE id=channel RETURNING event_sequence,workspace_id INTO STRICT seq,workspace;
  INSERT INTO channel_events(workspace_id,channel_id,thread_id,sequence,type,payload) VALUES(workspace,channel,thread,seq,event_type,data);
END; $$;
CREATE FUNCTION chat_message_payload(m messages) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('id',m.id,'channel_id',m.channel_id,'thread_id',m.thread_id,'task_id',m.task_id,
    'text',m.text,'created_at',m.created_at,'client_message_id',m.client_message_id,
    'author',jsonb_build_object('kind',m.author_type,'id',coalesce(m.user_id,m.installation_id),
      'name',CASE WHEN m.author_type='human' THEN (SELECT display_name FROM users WHERE id=m.user_id)
        ELSE (SELECT d.name FROM agent_installations i JOIN agent_definitions d ON d.id=i.definition_id WHERE i.id=m.installation_id) END));
$$;
-- Backfill only durable existing messages, keeping their original timestamps/IDs.
DO $$ DECLARE m messages; BEGIN
  FOR m IN SELECT * FROM messages ORDER BY created_at,id LOOP
    PERFORM append_chat_event(m.channel_id,m.thread_id,'message.created',chat_message_payload(m));
  END LOOP;
END; $$;
CREATE FUNCTION message_chat_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  PERFORM append_chat_event(NEW.channel_id,NEW.thread_id,'message.created',chat_message_payload(NEW));
  RETURN NEW;
END; $$;
CREATE TRIGGER messages_realtime AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION message_chat_event();
CREATE FUNCTION task_chat_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE channel uuid; thread uuid; installation uuid; owner_id uuid;
BEGIN
  SELECT t.channel_id,t.id,i.id,i.owner_id INTO STRICT channel,thread,installation,owner_id
    FROM tasks k JOIN threads t ON t.id=k.thread_id JOIN agent_installations i ON i.id=k.installation_id WHERE k.id=NEW.correlation_id;
  PERFORM append_chat_event(channel,thread,'task.event',jsonb_build_object('task_id',NEW.correlation_id,'type',NEW.type,
    'actor_id',NEW.actor_id,'installation_id',installation,'owner_id',owner_id,'data',NEW.payload));
  RETURN NEW;
END; $$;
CREATE TRIGGER task_events_realtime AFTER INSERT ON task_events FOR EACH ROW EXECUTE FUNCTION task_chat_event();
