ALTER TABLE messages ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) <= 5);
CREATE TABLE assets (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL, channel_id uuid NOT NULL, uploader_id uuid NOT NULL REFERENCES users,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  size integer NOT NULL CHECK (size BETWEEN 1 AND 26214400), type text NOT NULL,
  staging_key text NOT NULL UNIQUE, object_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
  message_id uuid REFERENCES messages,
  upload_expires_at timestamptz NOT NULL DEFAULT now() + interval '5 minutes',
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  staging_deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id,channel_id) REFERENCES channels(workspace_id,id),
  CHECK (message_id IS NULL OR status = 'ready')
);
CREATE INDEX assets_expiry ON assets(expires_at) WHERE message_id IS NULL;
CREATE INDEX assets_staging_cleanup ON assets(upload_expires_at) WHERE status = 'ready' AND staging_deleted_at IS NULL;
CREATE INDEX assets_uploader ON assets(workspace_id,uploader_id) WHERE message_id IS NULL;

CREATE OR REPLACE FUNCTION chat_message_payload(m messages) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('id',m.id,'channel_id',m.channel_id,'thread_id',m.thread_id,'task_id',m.task_id,
    'text',m.text,'document',m.document,'attachments',m.attachments,'created_at',m.created_at,'client_message_id',m.client_message_id,
    'author',jsonb_build_object('kind',m.author_type,'id',coalesce(m.user_id,m.installation_id),
      'name',CASE WHEN m.author_type='human' THEN (SELECT display_name FROM users WHERE id=m.user_id)
        ELSE (SELECT d.name FROM agent_installations i JOIN agent_definitions d ON d.id=i.definition_id WHERE i.id=m.installation_id) END));
$$;
