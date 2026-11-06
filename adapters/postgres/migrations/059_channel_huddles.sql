CREATE TABLE channel_huddles (
 id uuid PRIMARY KEY,
 channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 state text NOT NULL DEFAULT 'starting' CHECK(state IN ('starting','active','ended')),
 created_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
 CHECK ((state='ended')=(ended_at IS NOT NULL))
);
CREATE UNIQUE INDEX channel_huddles_open ON channel_huddles(channel_id) WHERE state<>'ended';
CREATE INDEX channel_huddles_workspace ON channel_huddles(workspace_id,id) WHERE state<>'ended';

CREATE FUNCTION channel_huddle_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h channel_huddles;
BEGIN
 IF TG_OP='DELETE' THEN h:=OLD; ELSE h:=NEW; END IF;
 INSERT INTO chat_delivery_outbox(channel_id,workspace_id) VALUES(h.channel_id,h.workspace_id);
 IF TG_OP='INSERT' THEN
  INSERT INTO event_outbox(kind,aggregate_id,payload) VALUES('huddle.provision',h.id::text,'{}');
 ELSIF TG_OP='DELETE' OR (NEW.state='ended' AND OLD.state<>'ended') THEN
  -- This obligation survives cascading workspace/channel deletion.
  INSERT INTO event_outbox(kind,aggregate_id,payload) VALUES('huddle.close',h.id::text,'{}');
 END IF;
 RETURN NULL;
END; $$;
CREATE TRIGGER channel_huddle_changed AFTER INSERT OR UPDATE OR DELETE ON channel_huddles
 FOR EACH ROW EXECUTE FUNCTION channel_huddle_changed();

CREATE FUNCTION huddle_workspace_revoked() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (OLD.active AND NOT NEW.active) THEN
  UPDATE channel_huddles h SET state='ended',ended_at=now() WHERE workspace_id=OLD.workspace_id AND state<>'ended'
   AND EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id=h.channel_id AND cm.user_id=OLD.user_id);
 END IF;
 RETURN NULL;
END; $$;
CREATE TRIGGER huddle_workspace_revoked AFTER UPDATE OF active OR DELETE ON workspace_members
 FOR EACH ROW EXECUTE FUNCTION huddle_workspace_revoked();
CREATE FUNCTION huddle_channel_revoked() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE channel_huddles SET state='ended',ended_at=now() WHERE channel_id=OLD.channel_id AND state<>'ended';
 RETURN NULL;
END; $$;
CREATE TRIGGER huddle_channel_revoked AFTER DELETE ON channel_members
 FOR EACH ROW EXECUTE FUNCTION huddle_channel_revoked();
CREATE FUNCTION huddle_channel_archived() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.archived_at IS NOT NULL OR NEW.private IS DISTINCT FROM OLD.private THEN
  UPDATE channel_huddles SET state='ended',ended_at=now() WHERE channel_id=NEW.id AND state<>'ended';
 END IF;
 RETURN NULL;
END; $$;
CREATE TRIGGER huddle_channel_archived AFTER UPDATE OF archived_at,private ON channels
 FOR EACH ROW EXECUTE FUNCTION huddle_channel_archived();
