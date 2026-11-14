ALTER TABLE agent_sessions ADD COLUMN project_token text;
ALTER TABLE agent_connections ADD COLUMN project_picker boolean NOT NULL DEFAULT false;
