CREATE TABLE channel_reads (
  channel_id uuid NOT NULL,
  user_id uuid NOT NULL,
  last_read_sequence bigint NOT NULL DEFAULT 0 CHECK (last_read_sequence >= 0),
  PRIMARY KEY(channel_id,user_id),
  FOREIGN KEY(channel_id,user_id) REFERENCES channel_members(channel_id,user_id) ON DELETE CASCADE
);

-- Introducing unread tracking must not turn all historical messages into alerts.
INSERT INTO channel_reads(channel_id,user_id,last_read_sequence)
  SELECT cm.channel_id,cm.user_id,ch.event_sequence FROM channel_members cm JOIN channels ch ON ch.id=cm.channel_id;

CREATE FUNCTION initialize_channel_read() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO channel_reads(channel_id,user_id,last_read_sequence)
    SELECT NEW.channel_id,NEW.user_id,event_sequence FROM channels WHERE id=NEW.channel_id FOR UPDATE;
  RETURN NEW;
END; $$;
CREATE TRIGGER channel_members_read AFTER INSERT ON channel_members
  FOR EACH ROW EXECUTE FUNCTION initialize_channel_read();
CREATE TRIGGER channel_reads_delivery AFTER UPDATE ON channel_reads
  FOR EACH ROW WHEN (NEW.last_read_sequence IS DISTINCT FROM OLD.last_read_sequence)
  EXECUTE FUNCTION enqueue_chat_delivery();
