CREATE TABLE channel_permissions (
  channel_id uuid PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0),
  posting text NOT NULL DEFAULT 'everyone' CHECK (posting IN ('everyone','members','admins','selected')),
  poster_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(poster_ids)<=100),
  manager_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(manager_ids)<=100),
  allow_replies boolean NOT NULL DEFAULT true,
  allow_broadcast boolean NOT NULL DEFAULT true,
  invite text NOT NULL DEFAULT 'managers' CHECK (invite IN ('managers','members')),
  remove text NOT NULL DEFAULT 'managers' CHECK (remove IN ('managers','members')),
  edit_details text NOT NULL DEFAULT 'managers' CHECK (edit_details IN ('managers','members')),
  archive text NOT NULL DEFAULT 'managers' CHECK (archive IN ('managers','members'))
);
INSERT INTO channel_permissions(channel_id,workspace_id,manager_ids)
  SELECT ch.id,ch.workspace_id,CASE WHEN EXISTS (
    SELECT 1 FROM channel_members cm JOIN workspace_members wm ON wm.workspace_id=cm.workspace_id AND wm.user_id=cm.user_id
    WHERE cm.channel_id=ch.id AND cm.user_id=ch.created_by AND wm.active AND wm.guest_type='none'
  ) THEN ARRAY[ch.created_by] ELSE '{}'::uuid[] END FROM channels ch WHERE ch.kind='channel';
CREATE FUNCTION initialize_channel_permissions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='channel' THEN
    INSERT INTO channel_permissions(channel_id,workspace_id,manager_ids)
      VALUES(NEW.id,NEW.workspace_id,CASE WHEN NEW.created_by IS NULL THEN '{}'::uuid[] ELSE ARRAY[NEW.created_by] END);
  END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER channel_permissions_initialize AFTER INSERT ON channels FOR EACH ROW EXECUTE FUNCTION initialize_channel_permissions();
CREATE FUNCTION clear_channel_permission_grants() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE channel_permissions SET manager_ids=array_remove(manager_ids,OLD.user_id),poster_ids=array_remove(poster_ids,OLD.user_id),revision=revision+1
    WHERE channel_id=OLD.channel_id AND (OLD.user_id=ANY(manager_ids) OR OLD.user_id=ANY(poster_ids));
  RETURN NULL;
END; $$;
CREATE TRIGGER channel_permission_grants_cleanup AFTER DELETE ON channel_members FOR EACH ROW EXECUTE FUNCTION clear_channel_permission_grants();
CREATE TRIGGER channel_permissions_resource_delivery AFTER INSERT OR UPDATE OR DELETE ON channel_permissions FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
