CREATE TABLE session_sidebar_preferences (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  anchor_time timestamptz,
  anchor_id uuid,
  position numeric,
  PRIMARY KEY(workspace_id,user_id,session_id),
  FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_members(workspace_id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,session_id) REFERENCES agent_sessions(workspace_id,id) ON DELETE CASCADE,
  CHECK ((anchor_time IS NULL) = (anchor_id IS NULL) AND (anchor_id IS NULL) = (position IS NULL))
);
CREATE INDEX session_sidebar_positions ON session_sidebar_preferences(workspace_id,user_id,anchor_id,position);
CREATE TRIGGER session_sidebar_preferences_delivery AFTER INSERT OR UPDATE OR DELETE ON session_sidebar_preferences
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
