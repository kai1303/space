-- A broadcast has one message identity. Later promotion gets its own channel position;
-- the immutable creation sequence continues to order the reply inside its thread.
ALTER TABLE messages ADD COLUMN channel_broadcast_sequence bigint;
ALTER TABLE messages ADD CONSTRAINT broadcast_reply_shape CHECK(channel_broadcast_sequence IS NULL OR
  (author_type='human' AND agent_session_id IS NULL AND workflow_name IS NULL AND encrypted IS NULL AND channel_broadcast_sequence>=sequence));
CREATE INDEX messages_conversation_sequence ON messages(workspace_id,channel_id,(coalesce(channel_broadcast_sequence,sequence)));
ALTER TABLE scheduled_messages ADD COLUMN also_send_to_channel boolean NOT NULL DEFAULT false CHECK(NOT also_send_to_channel OR thread_id IS NOT NULL);
CREATE FUNCTION set_initial_broadcast_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.channel_broadcast_sequence=NEW.sequence;
  RETURN NEW;
END; $$;
-- Runs after messages_allocate_sequence.
CREATE TRIGGER messages_broadcast_sequence BEFORE INSERT ON messages FOR EACH ROW
  WHEN (NEW.channel_broadcast_sequence IS NOT NULL) EXECUTE FUNCTION set_initial_broadcast_sequence();

ALTER FUNCTION chat_message_payload(messages) RENAME TO chat_message_payload_before_thread_broadcast;
CREATE FUNCTION chat_message_payload(m messages) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT chat_message_payload_before_thread_broadcast(m) || CASE WHEN m.channel_broadcast_sequence IS NULL THEN '{}'::jsonb
    ELSE jsonb_build_object('channel_broadcast_sequence',m.channel_broadcast_sequence::text) END
$$;
