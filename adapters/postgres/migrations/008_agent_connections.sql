CREATE TABLE agent_pairings (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  owner_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  code_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  installation_id uuid REFERENCES agent_installations(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_pairings_owner ON agent_pairings(workspace_id, owner_id);
CREATE TABLE agent_connections (
  installation_id uuid PRIMARY KEY REFERENCES agent_installations(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  token_hash text UNIQUE,
  auth_status text NOT NULL DEFAULT 'required' CHECK (auth_status IN ('required','ready','error')),
  connection_id uuid,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE foundation_events DROP CONSTRAINT foundation_events_type_check;
ALTER TABLE foundation_events ADD CONSTRAINT foundation_events_type_check
  CHECK (type IN ('installation.created','installation.enabled','installation.disabled','grant.created','grant.revoked','connection.paired','connection.revoked'));
