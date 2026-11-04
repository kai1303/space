ALTER TABLE workspace_members ADD COLUMN guest_type text NOT NULL DEFAULT 'none' CHECK (guest_type IN ('none','single','multi'));
ALTER TABLE workspace_members ADD COLUMN guest_channel_id uuid;
ALTER TABLE workspace_members ADD CONSTRAINT guest_member_role CHECK (guest_type='none' OR role='member');
ALTER TABLE workspaces ADD COLUMN primary_owner_id uuid REFERENCES users(id);
UPDATE workspaces w SET primary_owner_id=(SELECT user_id FROM workspace_members m WHERE m.workspace_id=w.id AND m.active AND m.role='owner' ORDER BY joined_at,user_id LIMIT 1);

CREATE FUNCTION initialize_primary_workspace_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.active AND NEW.role='owner' THEN
  UPDATE workspaces SET primary_owner_id=NEW.user_id WHERE id=NEW.workspace_id AND primary_owner_id IS NULL;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER initialize_primary_workspace_owner AFTER INSERT OR UPDATE ON workspace_members FOR EACH ROW EXECUTE FUNCTION initialize_primary_workspace_owner();

CREATE FUNCTION protect_primary_workspace_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE workspace uuid; owner_id uuid;
BEGIN
 IF TG_TABLE_NAME='workspaces' THEN workspace:=NEW.id; ELSE workspace:=OLD.workspace_id; END IF;
 SELECT primary_owner_id INTO owner_id FROM workspaces WHERE id=workspace;
 IF owner_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=workspace AND user_id=owner_id AND active AND role='owner') THEN
  RAISE EXCEPTION 'primary_owner_required' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER protect_primary_workspace_owner AFTER UPDATE ON workspaces DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION protect_primary_workspace_owner();
CREATE CONSTRAINT TRIGGER protect_primary_workspace_member AFTER UPDATE OR DELETE ON workspace_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION protect_primary_workspace_owner();

-- A conditional write on one membership serializes competing single-channel assignments.
-- This uses PostgreSQL's normal write locks, not an explicit database lock.
CREATE FUNCTION enforce_guest_channel_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assigned integer;
BEGIN
 IF EXISTS(SELECT 1 FROM channels WHERE id=NEW.channel_id AND kind='channel') AND EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=NEW.user_id AND guest_type='single') THEN
  UPDATE workspace_members SET guest_channel_id=NEW.channel_id
   WHERE workspace_id=NEW.workspace_id AND user_id=NEW.user_id AND guest_type='single' AND (guest_channel_id IS NULL OR guest_channel_id=NEW.channel_id);
  GET DIAGNOSTICS assigned = ROW_COUNT;
  IF assigned=0 THEN RAISE EXCEPTION 'guest_channel_limit' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER enforce_guest_channel_assignment BEFORE INSERT ON channel_members FOR EACH ROW EXECUTE FUNCTION enforce_guest_channel_assignment();
CREATE FUNCTION release_guest_channel_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE workspace_members SET guest_channel_id=NULL WHERE workspace_id=OLD.workspace_id AND user_id=OLD.user_id AND guest_channel_id=OLD.channel_id;
 RETURN OLD;
END; $$;
CREATE TRIGGER release_guest_channel_assignment AFTER DELETE ON channel_members FOR EACH ROW EXECUTE FUNCTION release_guest_channel_assignment();
