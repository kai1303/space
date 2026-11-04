CREATE TABLE hub_saved_messages (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  message_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,user_id,message_id),
  FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_members(workspace_id,user_id),
  FOREIGN KEY(workspace_id,channel_id) REFERENCES channels(workspace_id,id),
  FOREIGN KEY(channel_id,message_id) REFERENCES messages(channel_id,id)
);
CREATE TABLE hub_starred_channels (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  PRIMARY KEY(workspace_id,user_id,channel_id),
  FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_members(workspace_id,user_id),
  FOREIGN KEY(workspace_id,channel_id) REFERENCES channels(workspace_id,id)
);
CREATE TABLE hub_todos (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 500),
  completed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_members(workspace_id,user_id)
);
CREATE INDEX hub_todos_owner_page ON hub_todos(workspace_id,user_id,id);
CREATE INDEX hub_saved_messages_source ON hub_saved_messages(channel_id,message_id);
CREATE INDEX hub_starred_channels_source ON hub_starred_channels(channel_id);
CREATE INDEX hub_messages_sent ON messages(workspace_id,user_id,created_at DESC,id DESC) WHERE agent_session_id IS NULL;
CREATE INDEX hub_messages_newest ON messages(workspace_id,created_at DESC,id DESC) WHERE agent_session_id IS NULL;
CREATE INDEX hub_messages_thread ON messages(workspace_id,channel_id,thread_id,sequence) WHERE agent_session_id IS NULL;
CREATE INDEX hub_assets_workspace_page ON assets(workspace_id,id) WHERE status='ready' AND message_id IS NOT NULL;
-- Only workspace revision hints leave these owner-scoped tables; no personal data
-- is included in resource delivery, and each subsequent read rechecks access.
CREATE TRIGGER hub_saved_delivery AFTER INSERT OR DELETE ON hub_saved_messages
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
CREATE TRIGGER hub_starred_delivery AFTER INSERT OR DELETE ON hub_starred_channels
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
CREATE TRIGGER hub_todos_delivery AFTER INSERT OR UPDATE ON hub_todos
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
