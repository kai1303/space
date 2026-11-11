CREATE SEQUENCE channel_pin_order_seq;
ALTER TABLE messages ADD COLUMN pin_order bigint;
CREATE INDEX channel_message_pins_by_order ON messages(channel_id, pin_order DESC)
  WHERE pin_order IS NOT NULL;

CREATE FUNCTION clear_erased_message_pin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.pin_order := NULL;
  RETURN NEW;
END; $$;
CREATE TRIGGER messages_clear_erased_pin BEFORE UPDATE OF deleted_at, retained_at ON messages
  FOR EACH ROW WHEN (OLD.pin_order IS NOT NULL AND (NEW.deleted_at IS NOT NULL OR NEW.retained_at IS NOT NULL))
  EXECUTE FUNCTION clear_erased_message_pin();

CREATE FUNCTION notify_channel_pins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO chat_delivery_outbox(channel_id,workspace_id) VALUES (OLD.channel_id,OLD.workspace_id);
  RETURN NULL;
END; $$;
CREATE TRIGGER message_pin_changed AFTER UPDATE ON messages FOR EACH ROW
  WHEN (NEW.pin_order IS DISTINCT FROM OLD.pin_order) EXECUTE FUNCTION notify_channel_pins();
CREATE TRIGGER pinned_message_removed AFTER DELETE ON messages FOR EACH ROW
  WHEN (OLD.pin_order IS NOT NULL) EXECUTE FUNCTION notify_channel_pins();
