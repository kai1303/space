CREATE TABLE published_help_workflows (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  manager_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  normal_channel uuid NOT NULL,
  urgent_channel uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, manager_id) REFERENCES workspace_members(workspace_id, user_id),
  FOREIGN KEY (workspace_id, normal_channel) REFERENCES channels(workspace_id, id),
  FOREIGN KEY (workspace_id, urgent_channel) REFERENCES channels(workspace_id, id)
);
CREATE INDEX published_help_workflows_workspace ON published_help_workflows(workspace_id, id);
CREATE INDEX published_help_workflows_manager ON published_help_workflows(workspace_id, manager_id, id);
CREATE TRIGGER published_help_workflow_delivery AFTER INSERT ON published_help_workflows
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();

CREATE TABLE help_workflow_requests (
  workflow_id uuid NOT NULL REFERENCES published_help_workflows(id),
  requester_id uuid NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  input_hash text NOT NULL,
  started boolean NOT NULL DEFAULT false,
  PRIMARY KEY (workflow_id, requester_id, request_id)
);
