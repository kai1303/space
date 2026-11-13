CREATE TABLE channel_memory_documents (
  workspace_id uuid NOT NULL,
  channel_id uuid PRIMARY KEY,
  content text NOT NULL CHECK (octet_length(content) <= 524288),
  FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id, id) ON DELETE CASCADE
);
