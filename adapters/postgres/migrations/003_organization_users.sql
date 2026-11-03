ALTER TABLE users ADD COLUMN display_name text NOT NULL DEFAULT 'User'
  CHECK (length(btrim(display_name)) BETWEEN 1 AND 100);
ALTER TABLE users ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE workspaces ADD COLUMN name text NOT NULL DEFAULT 'Workspace'
  CHECK (length(btrim(name)) BETWEEN 1 AND 100);
ALTER TABLE workspaces ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE workspace_members ADD COLUMN role text NOT NULL DEFAULT 'member'
  CHECK (role IN ('owner','admin','member'));
ALTER TABLE workspace_members ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE workspace_members ADD COLUMN joined_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX workspace_members_user_active ON workspace_members(user_id, workspace_id) WHERE active;

-- Preserve historical references when a member is removed. Application access
-- checks require active membership; only the membership service reactivates rows.
CREATE TABLE organization_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  actor_id uuid NOT NULL REFERENCES users,
  type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organization_events_workspace ON organization_events(workspace_id, occurred_at, id);
CREATE TRIGGER organization_events_immutable BEFORE UPDATE OR DELETE ON organization_events
  FOR EACH ROW EXECUTE FUNCTION immutable_task_event();
