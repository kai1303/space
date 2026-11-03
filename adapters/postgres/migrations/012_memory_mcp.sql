CREATE TABLE memory_connections (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL, channel_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  access text NOT NULL CHECK (access IN ('read','write')),
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash)=64),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id,channel_id) REFERENCES channels(workspace_id,id)
);
CREATE INDEX memory_connections_channel ON memory_connections(channel_id);
