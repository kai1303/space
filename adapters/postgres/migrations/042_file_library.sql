CREATE TABLE hub_file_state (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  starred boolean NOT NULL DEFAULT false,
  last_viewed_at timestamptz,
  PRIMARY KEY(workspace_id,user_id,asset_id),
  FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_members(workspace_id,user_id)
);
CREATE INDEX hub_file_state_recent ON hub_file_state(workspace_id,user_id,last_viewed_at DESC,asset_id DESC);
CREATE TRIGGER hub_file_state_delivery AFTER INSERT OR UPDATE OR DELETE ON hub_file_state
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
