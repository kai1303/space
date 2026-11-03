CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE organization_members (
  organization_id uuid NOT NULL REFERENCES organizations,
  user_id uuid NOT NULL REFERENCES users,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  active boolean NOT NULL DEFAULT true,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX organization_members_user_active ON organization_members(user_id, organization_id) WHERE active;
ALTER TABLE workspaces ADD COLUMN organization_id uuid;
UPDATE workspaces SET organization_id = gen_random_uuid();
INSERT INTO organizations(id, name, created_at)
  SELECT organization_id, name, created_at FROM workspaces;
ALTER TABLE workspaces ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE workspaces ADD FOREIGN KEY (organization_id) REFERENCES organizations;
ALTER TABLE workspaces ADD UNIQUE (organization_id, id);
INSERT INTO organization_members(organization_id, user_id, role, active, joined_at)
  SELECT w.organization_id, m.user_id, m.role, m.active, m.joined_at
  FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id;
ALTER TABLE workspace_members ADD COLUMN organization_id uuid;
UPDATE workspace_members m SET organization_id = w.organization_id FROM workspaces w WHERE w.id = m.workspace_id;
ALTER TABLE workspace_members ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE workspace_members ADD FOREIGN KEY (organization_id, workspace_id) REFERENCES workspaces(organization_id, id);
ALTER TABLE workspace_members ADD FOREIGN KEY (organization_id, user_id) REFERENCES organization_members(organization_id, user_id);

-- Keep historical events unchanged; those events belong to workspaces.
ALTER TABLE organization_events RENAME TO workspace_events;
ALTER INDEX organization_events_pkey RENAME TO workspace_events_pkey;
ALTER INDEX organization_events_workspace RENAME TO workspace_events_workspace;
CREATE TABLE organization_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations,
  actor_id uuid NOT NULL REFERENCES users,
  type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organization_events_org ON organization_events(organization_id, occurred_at, id);
CREATE TRIGGER organization_events_immutable BEFORE UPDATE OR DELETE ON organization_events
  FOR EACH ROW EXECUTE FUNCTION immutable_task_event();
