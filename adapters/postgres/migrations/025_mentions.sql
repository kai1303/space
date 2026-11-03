CREATE TABLE workspace_mention_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  general_channel_id uuid,
  broadcast_permission text NOT NULL DEFAULT 'all' CHECK(broadcast_permission IN ('all','admins')),
  FOREIGN KEY(workspace_id,general_channel_id) REFERENCES channels(workspace_id,id)
);
INSERT INTO workspace_mention_settings(workspace_id,general_channel_id)
  SELECT DISTINCT ON (workspace_id) workspace_id,id FROM channels WHERE lower(name)='general' AND NOT private ORDER BY workspace_id,created_at,id;
CREATE FUNCTION initialize_general_mention_channel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF lower(NEW.name)='general' AND NOT NEW.private THEN
    INSERT INTO workspace_mention_settings(workspace_id,general_channel_id) VALUES(NEW.workspace_id,NEW.id)
      ON CONFLICT(workspace_id) DO UPDATE SET general_channel_id=coalesce(workspace_mention_settings.general_channel_id,EXCLUDED.general_channel_id);
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER channels_general_mention AFTER INSERT ON channels FOR EACH ROW EXECUTE FUNCTION initialize_general_mention_channel();
CREATE TABLE mention_preferences(user_id uuid PRIMARY KEY REFERENCES users(id),paused_until timestamptz);
CREATE TABLE mention_notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  message_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  silent boolean NOT NULL DEFAULT false,
  UNIQUE(message_id,user_id),
  FOREIGN KEY(channel_id,message_id) REFERENCES messages(channel_id,id),
  FOREIGN KEY(workspace_id,channel_id) REFERENCES channels(workspace_id,id)
);
CREATE INDEX mention_notifications_inbox ON mention_notifications(user_id,workspace_id,id DESC);
