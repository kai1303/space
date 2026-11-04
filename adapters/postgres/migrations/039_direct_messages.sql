ALTER TABLE channels ADD COLUMN kind text NOT NULL DEFAULT 'channel' CHECK(kind IN ('channel','direct'));
ALTER TABLE channels ADD COLUMN direct_user_low uuid REFERENCES users(id);
ALTER TABLE channels ADD COLUMN direct_user_high uuid REFERENCES users(id);
ALTER TABLE channels ADD CONSTRAINT direct_channel_shape CHECK (
  (kind='channel' AND direct_user_low IS NULL AND direct_user_high IS NULL) OR
  (kind='direct' AND private AND archived_at IS NULL AND NOT memory_enabled AND direct_user_low IS NOT NULL AND direct_user_high IS NOT NULL AND direct_user_low<=direct_user_high)
);
CREATE UNIQUE INDEX direct_channel_pair ON channels(workspace_id,direct_user_low,direct_user_high) WHERE kind='direct';
CREATE TABLE direct_message_views (
  workspace_id uuid NOT NULL, channel_id uuid NOT NULL, user_id uuid NOT NULL, hidden boolean NOT NULL DEFAULT true, last_activity_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(channel_id,user_id),
  FOREIGN KEY(channel_id,user_id) REFERENCES channel_members(channel_id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,channel_id) REFERENCES channels(workspace_id,id)
);
CREATE INDEX direct_message_inbox ON direct_message_views(workspace_id,user_id,last_activity_at DESC,channel_id DESC) WHERE NOT hidden;
CREATE TRIGGER direct_message_views_delivery AFTER INSERT OR UPDATE OR DELETE ON direct_message_views
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
-- The transaction creating a DM owns its newly inserted row; subsequent reads advance atomically.
CREATE OR REPLACE FUNCTION initialize_channel_read() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO channel_reads(channel_id,user_id,last_read_sequence)
    SELECT NEW.channel_id,NEW.user_id,event_sequence FROM channels WHERE id=NEW.channel_id;
  RETURN NEW;
END; $$;
CREATE FUNCTION protect_direct_channel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (NEW.kind,NEW.direct_user_low,NEW.direct_user_high) IS DISTINCT FROM (OLD.kind,OLD.direct_user_low,OLD.direct_user_high) THEN
    RAISE EXCEPTION 'conversation identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER direct_channel_identity BEFORE UPDATE ON channels FOR EACH ROW EXECUTE FUNCTION protect_direct_channel();
CREATE FUNCTION protect_direct_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ch channels;
BEGIN
  IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM channels WHERE id=OLD.channel_id AND kind='direct') THEN
    RAISE EXCEPTION 'direct conversation participants are immutable' USING ERRCODE='23514';
  END IF;
  SELECT * INTO ch FROM channels WHERE id=coalesce(NEW.channel_id,OLD.channel_id);
  IF ch.kind='direct' AND (TG_OP<>'INSERT' OR NEW.user_id NOT IN (ch.direct_user_low,ch.direct_user_high)) THEN
    RAISE EXCEPTION 'direct conversation participants are immutable' USING ERRCODE='23514';
  END IF;
  RETURN coalesce(NEW,OLD);
END; $$;
CREATE TRIGGER direct_members_immutable BEFORE INSERT OR UPDATE OR DELETE ON channel_members FOR EACH ROW EXECUTE FUNCTION protect_direct_member();
CREATE FUNCTION forbid_direct_agent_access() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF EXISTS(SELECT 1 FROM channels WHERE id=NEW.channel_id AND kind='direct') THEN
    RAISE EXCEPTION 'agents cannot access direct conversations' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER direct_agent_grants BEFORE INSERT OR UPDATE ON agent_grants FOR EACH ROW EXECUTE FUNCTION forbid_direct_agent_access();
CREATE TRIGGER direct_agent_memory BEFORE INSERT OR UPDATE ON agent_memory_grants FOR EACH ROW EXECUTE FUNCTION forbid_direct_agent_access();
CREATE TRIGGER direct_memory_connections BEFORE INSERT OR UPDATE ON memory_connections FOR EACH ROW EXECUTE FUNCTION forbid_direct_agent_access();
