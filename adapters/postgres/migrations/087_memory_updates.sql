-- Every saved checkpoint tells open memory views in the channel to re-read. One row per insert.
CREATE FUNCTION enqueue_memory_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO chat_delivery_outbox(channel_id, workspace_id, resource_scope)
    SELECT NEW.channel_id, c.workspace_id, 'metadata' FROM channels c WHERE c.id = NEW.channel_id;
  RETURN NULL;
END; $$;
CREATE TRIGGER thread_checkpoints_memory_update AFTER INSERT ON thread_checkpoints
  FOR EACH ROW EXECUTE FUNCTION enqueue_memory_update();
