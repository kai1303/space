CREATE TABLE agent_memory_grants (
  workspace_id uuid NOT NULL, channel_id uuid NOT NULL, installation_id uuid NOT NULL,
  access text NOT NULL CHECK (access IN ('none','read','contribute')),
  revision integer NOT NULL DEFAULT 1,
  PRIMARY KEY (channel_id,installation_id),
  FOREIGN KEY (workspace_id,channel_id) REFERENCES channels(workspace_id,id),
  FOREIGN KEY (workspace_id,installation_id) REFERENCES agent_installations(workspace_id,id)
);
ALTER TABLE memory_connections ADD COLUMN installation_id uuid;
ALTER TABLE memory_connections ADD FOREIGN KEY (workspace_id,installation_id) REFERENCES agent_installations(workspace_id,id);
ALTER TABLE memory_connections DROP CONSTRAINT memory_connections_access_check;
ALTER TABLE memory_connections ADD CHECK (access IN ('read','contribute','write'));
ALTER TABLE memory_connections ADD CHECK (installation_id IS NULL OR (thread_id IS NULL AND access IN ('read','contribute')));
ALTER TABLE foundation_events DROP CONSTRAINT foundation_events_type_check;
ALTER TABLE foundation_events ADD CONSTRAINT foundation_events_type_check CHECK (type IN (
  'installation.created','installation.enabled','installation.disabled','grant.created','grant.revoked',
  'connection.paired','connection.revoked','memory.access_changed'
));
