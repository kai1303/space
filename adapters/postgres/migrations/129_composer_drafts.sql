CREATE TABLE composer_drafts (
  actor_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  thread_id uuid,
  key text COLLATE "C" NOT NULL,
  revision uuid NOT NULL,
  base uuid,
  value jsonb,
  asset_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(asset_ids)<=5),
  PRIMARY KEY (actor_id,key),
  FOREIGN KEY (channel_id,actor_id) REFERENCES channel_members ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,channel_id) REFERENCES channels(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,channel_id,thread_id) REFERENCES threads(workspace_id,channel_id,id) ON DELETE CASCADE,
  CHECK (CASE WHEN thread_id IS NULL THEN key IN (channel_id::text,'encrypted:'||channel_id)
    ELSE key='thread:'||channel_id||':'||thread_id END)
);
CREATE INDEX composer_drafts_active ON composer_drafts(actor_id,key) WHERE value IS NOT NULL;
CREATE INDEX composer_drafts_channel_member ON composer_drafts(channel_id,actor_id);
CREATE INDEX composer_drafts_thread ON composer_drafts(thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX composer_drafts_workspace_member ON composer_drafts(workspace_id,actor_id);

CREATE INDEX composer_drafts_assets ON composer_drafts USING gin(asset_ids) WHERE cardinality(asset_ids)>0;

-- Ordinary and encrypted draft uploads use the same bounded quota and durable deadline events.
CREATE FUNCTION retain_composer_draft_assets() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_ids uuid[] := coalesce(NEW.asset_ids,'{}'); removed_ids uuid[] := coalesce(OLD.asset_ids,'{}');
BEGIN
  IF cardinality(current_ids)>0 THEN
    UPDATE assets SET expires_at=now()+interval '30 days' WHERE id=ANY(current_ids)
      AND expires_at>now() AND expires_at<now()+interval '29 days'
      AND message_id IS NULL AND task_id IS NULL AND queue_input_id IS NULL;
  END IF;
  IF cardinality(removed_ids)>0 AND NOT removed_ids <@ current_ids THEN
    UPDATE assets a SET expires_at=least(a.expires_at,greatest(now()+interval '1 day',
        (SELECT max(s.send_at)+interval '1 day' FROM scheduled_messages s
          WHERE s.user_id=a.uploader_id AND s.workspace_id=a.workspace_id AND s.status IN ('pending','sending') AND a.id=ANY(s.asset_ids))))
      WHERE a.id=ANY(removed_ids) AND NOT a.id=ANY(current_ids)
        AND a.message_id IS NULL AND a.task_id IS NULL AND a.queue_input_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM composer_drafts d WHERE cardinality(d.asset_ids)>0 AND d.asset_ids @> ARRAY[a.id]);
  END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER composer_drafts_asset_retention AFTER INSERT OR UPDATE OR DELETE ON composer_drafts
  FOR EACH ROW EXECUTE FUNCTION retain_composer_draft_assets();

-- Keep only actor-scoped invalidations in the event stream, never draft contents.
CREATE FUNCTION deliver_composer_draft_changes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text;
BEGIN
  FOR target IN SELECT DISTINCT 'drafts:'||actor_id FROM changed_rows ORDER BY 1 LOOP
    INSERT INTO resource_update_revisions(resource) VALUES(target)
      ON CONFLICT(resource) DO UPDATE SET revision=resource_update_revisions.revision+1;
    INSERT INTO event_outbox(kind,aggregate_id,payload)
      VALUES('chat.changed',split_part(target,':',2),jsonb_build_object('keys',jsonb_build_array(target)));
    PERFORM pg_notify('space_direct_turn',jsonb_build_object('keys',ARRAY[target])::text);
  END LOOP;
  RETURN NULL;
END; $$;
CREATE TRIGGER composer_drafts_created AFTER INSERT ON composer_drafts
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION deliver_composer_draft_changes();
CREATE TRIGGER composer_drafts_updated AFTER UPDATE ON composer_drafts
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION deliver_composer_draft_changes();
CREATE TRIGGER composer_drafts_deleted AFTER DELETE ON composer_drafts
  REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION deliver_composer_draft_changes();

CREATE FUNCTION clear_unavailable_composer_drafts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='channels' THEN
    DELETE FROM composer_drafts WHERE channel_id=NEW.id;
  ELSE
    DELETE FROM composer_drafts WHERE workspace_id=NEW.workspace_id AND actor_id=NEW.user_id;
  END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER clear_plaintext_dm_drafts AFTER UPDATE OF encrypted_since ON channels
  FOR EACH ROW WHEN (OLD.encrypted_since IS NULL AND NEW.encrypted_since IS NOT NULL)
  EXECUTE FUNCTION clear_unavailable_composer_drafts();
CREATE TRIGGER clear_revoked_workspace_drafts AFTER UPDATE OF active ON workspace_members
  FOR EACH ROW WHEN (OLD.active AND NOT NEW.active) EXECUTE FUNCTION clear_unavailable_composer_drafts();
