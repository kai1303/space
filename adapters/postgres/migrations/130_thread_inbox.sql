CREATE TABLE thread_reads (
  workspace_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  user_id uuid NOT NULL,
  last_read_sequence bigint NOT NULL CHECK (last_read_sequence>0),
  PRIMARY KEY(thread_id,user_id),
  FOREIGN KEY(workspace_id,channel_id,thread_id) REFERENCES threads(workspace_id,channel_id,id) ON DELETE CASCADE,
  FOREIGN KEY(channel_id,user_id) REFERENCES channel_members ON DELETE CASCADE
);
CREATE INDEX thread_reads_member ON thread_reads(channel_id,user_id);
CREATE INDEX thread_inbox_following ON notification_subscriptions(user_id,thread_id) WHERE following;
CREATE INDEX thread_inbox_live_replies ON messages(workspace_id,channel_id,thread_id,sequence DESC)
  INCLUDE (user_id,created_at) WHERE agent_session_id IS NULL AND deleted_at IS NULL AND retained_at IS NULL;

-- Both sidebar and inbox read updates invalidate only the affected account.
CREATE TRIGGER thread_reads_created AFTER INSERT ON thread_reads
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION deliver_sidebar_changes();
CREATE TRIGGER thread_reads_advanced AFTER UPDATE ON thread_reads
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION deliver_sidebar_changes();
CREATE TRIGGER thread_follow_changed AFTER UPDATE ON notification_subscriptions
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION deliver_sidebar_changes();
CREATE TRIGGER thread_follow_created AFTER INSERT ON notification_subscriptions
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION deliver_sidebar_changes();

-- Sending, editing and deleting a message already wake workspace subscribers.
-- Reaction toggles also change the previews in the Threads inbox.
CREATE FUNCTION deliver_thread_preview_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO chat_delivery_outbox(channel_id,workspace_id,resource_scope)
    VALUES(OLD.channel_id,OLD.workspace_id,'message');
  RETURN NULL;
END; $$;
CREATE TRIGGER thread_preview_reacted AFTER UPDATE OF reaction_sequence ON messages FOR EACH ROW
  WHEN (OLD.agent_session_id IS NULL AND OLD.reaction_sequence<>NEW.reaction_sequence AND
    (OLD.text,OLD.document,OLD.deleted_at) IS NOT DISTINCT FROM (NEW.text,NEW.document,NEW.deleted_at))
  EXECUTE FUNCTION deliver_thread_preview_change();
CREATE TRIGGER thread_preview_removed AFTER DELETE ON messages FOR EACH ROW
  WHEN (OLD.agent_session_id IS NULL) EXECUTE FUNCTION deliver_thread_preview_change();
