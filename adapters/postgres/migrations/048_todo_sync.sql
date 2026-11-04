CREATE TABLE todo_sync_sources (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  token_hash text CHECK(token_hash IS NULL OR length(token_hash)=64),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_members(workspace_id,user_id),
  UNIQUE(id,workspace_id,user_id)
);
CREATE INDEX todo_sync_sources_owner ON todo_sync_sources(workspace_id,user_id,id);
ALTER TABLE hub_todos
  ADD COLUMN external_source_id uuid,
  ADD COLUMN external_id text,
  ADD COLUMN external_revision bigint,
  ADD COLUMN external_hash text,
  ADD COLUMN external_url text,
  ADD CONSTRAINT hub_todos_external_source FOREIGN KEY(external_source_id,workspace_id,user_id) REFERENCES todo_sync_sources(id,workspace_id,user_id),
  ADD CONSTRAINT hub_todos_external_unique UNIQUE(external_source_id,external_id),
  ADD CONSTRAINT hub_todos_external_fields CHECK (
    (external_source_id IS NULL AND external_id IS NULL AND external_revision IS NULL AND external_hash IS NULL AND external_url IS NULL)
    OR (external_source_id IS NOT NULL AND external_id IS NOT NULL AND length(external_id) BETWEEN 1 AND 200
      AND external_revision IS NOT NULL AND external_revision>0 AND external_hash IS NOT NULL AND length(external_hash)=64 AND channel_id IS NULL)),
  ADD CONSTRAINT hub_todos_external_url_size CHECK(external_url IS NULL OR length(external_url)<=2048);
CREATE INDEX hub_todos_external_page ON hub_todos(external_source_id,id) WHERE external_source_id IS NOT NULL;
