CREATE TABLE hub_starred_agent_sessions (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  PRIMARY KEY(workspace_id,user_id,session_id),
  FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_members(workspace_id,user_id),
  FOREIGN KEY(workspace_id,session_id) REFERENCES agent_sessions(workspace_id,id)
);
CREATE INDEX hub_starred_agent_sessions_source ON hub_starred_agent_sessions(session_id);
CREATE TRIGGER hub_starred_agent_sessions_delivery AFTER INSERT OR DELETE ON hub_starred_agent_sessions
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
