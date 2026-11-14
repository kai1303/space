ALTER TABLE channel_huddles ADD COLUMN started_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN thread_id uuid REFERENCES threads(id) ON DELETE SET NULL;
CREATE TABLE huddle_attendance (
  huddle_id uuid NOT NULL REFERENCES channel_huddles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (huddle_id,user_id)
);
CREATE INDEX huddle_attendance_recent ON huddle_attendance(user_id,workspace_id,joined_at DESC,huddle_id);

-- Wake only the two DM participants. Re-reading the authoritative invitation also
-- handles reconnects, repeated notifications, and a room ending on another device.
CREATE FUNCTION notify_direct_huddle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO resource_update_revisions(resource)
    SELECT 'actor:' || cm.user_id FROM channel_members cm JOIN channels c ON c.id=cm.channel_id
    WHERE cm.channel_id=NEW.channel_id AND c.kind='direct' ORDER BY cm.user_id
    ON CONFLICT(resource) DO UPDATE SET revision=resource_update_revisions.revision+1;
  INSERT INTO chat_delivery_outbox(actor_id,resource_scope)
    SELECT cm.user_id,'none' FROM channel_members cm JOIN channels c ON c.id=cm.channel_id
    WHERE cm.channel_id=NEW.channel_id AND c.kind='direct' ORDER BY cm.user_id;
  RETURN NULL;
END; $$;
CREATE TRIGGER direct_huddle_state AFTER UPDATE OF state ON channel_huddles
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION notify_direct_huddle();

CREATE TABLE huddle_dismissals (
  huddle_id uuid NOT NULL REFERENCES channel_huddles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(huddle_id,user_id)
);
CREATE FUNCTION notify_huddle_recipient() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO resource_update_revisions(resource) VALUES('actor:' || NEW.user_id)
    ON CONFLICT(resource) DO UPDATE SET revision=resource_update_revisions.revision+1;
  INSERT INTO chat_delivery_outbox(actor_id,resource_scope) VALUES(NEW.user_id,'none');
  RETURN NULL;
END; $$;
CREATE TRIGGER huddle_invitation_dismissed AFTER INSERT ON huddle_dismissals
  FOR EACH ROW EXECUTE FUNCTION notify_huddle_recipient();
CREATE TRIGGER huddle_admitted AFTER INSERT ON huddle_attendance
  FOR EACH ROW EXECUTE FUNCTION notify_huddle_recipient();
CREATE TABLE huddle_invites (
  huddle_id uuid NOT NULL REFERENCES channel_huddles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(huddle_id,user_id)
);
CREATE INDEX huddle_invites_recipient ON huddle_invites(user_id,huddle_id);
CREATE TRIGGER huddle_person_invited AFTER INSERT ON huddle_invites
  FOR EACH ROW EXECUTE FUNCTION notify_huddle_recipient();
CREATE FUNCTION finish_huddle_invitations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO resource_update_revisions(resource)
    SELECT 'actor:' || user_id FROM huddle_invites WHERE huddle_id=NEW.id ORDER BY user_id
    ON CONFLICT(resource) DO UPDATE SET revision=resource_update_revisions.revision+1;
  INSERT INTO chat_delivery_outbox(actor_id,resource_scope)
    SELECT user_id,'none' FROM huddle_invites WHERE huddle_id=NEW.id ORDER BY user_id;
  RETURN NULL;
END; $$;
CREATE TRIGGER huddle_invites_ended AFTER UPDATE OF state ON channel_huddles
  FOR EACH ROW WHEN (NEW.state='ended' AND OLD.state<>'ended') EXECUTE FUNCTION finish_huddle_invitations();
