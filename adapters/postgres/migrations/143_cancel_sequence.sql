-- Order a new cancellation against the insert trigger that allocates a message's
-- immutable position. If a concurrent send commits first, the serializable canceller
-- retries and erases that message. If cancellation wins, the sender sees its marker.
-- An idempotent repeat creates no row and consumes no additional position.
CREATE FUNCTION sequence_message_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE channels SET event_sequence=event_sequence+1 WHERE id=NEW.channel_id;
  RETURN NULL;
END; $$;
CREATE TRIGGER cancelled_send_sequence AFTER INSERT ON cancelled_message_sends
  FOR EACH ROW EXECUTE FUNCTION sequence_message_cancellation();
