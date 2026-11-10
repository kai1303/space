CREATE TABLE channel_webhooks (
  id uuid PRIMARY KEY,
  channel_id uuid NOT NULL REFERENCES channels(id),
  creator_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  token_hash text NOT NULL UNIQUE,
  window_start timestamptz NOT NULL DEFAULT now(),
  posts integer NOT NULL DEFAULT 0
);
CREATE INDEX channel_webhooks_channel ON channel_webhooks(channel_id);

-- Snapshot the author so revoking a credential preserves message history.
ALTER TABLE messages ADD COLUMN webhook_id uuid, ADD COLUMN webhook_name text, ADD COLUMN webhook_key text;
ALTER TABLE messages DROP CONSTRAINT message_author;
ALTER TABLE messages ADD CONSTRAINT message_author CHECK (
  (author_type='app' AND webhook_id IS NOT NULL AND webhook_name IS NOT NULL AND user_id IS NULL AND installation_id IS NULL AND task_id IS NULL AND client_message_id IS NULL AND request_hash IS NOT NULL)
  OR (webhook_id IS NULL AND webhook_name IS NULL AND webhook_key IS NULL AND (
    (author_type IN ('human','workflow') AND user_id IS NOT NULL AND installation_id IS NULL AND task_id IS NULL AND client_message_id IS NOT NULL AND request_hash IS NOT NULL)
    OR (author_type='agent' AND user_id IS NULL AND installation_id IS NOT NULL AND task_id IS NOT NULL AND client_message_id IS NULL AND request_hash IS NULL)
  ))
);
CREATE UNIQUE INDEX messages_webhook_retry ON messages(channel_id,webhook_id,webhook_key) WHERE webhook_key IS NOT NULL;

CREATE OR REPLACE FUNCTION chat_message_payload(m messages) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('id',m.id,'channel_id',m.channel_id,'thread_id',m.thread_id,'task_id',m.task_id,'agent_session_id',m.agent_session_id,'sequence',m.sequence::text,
    'text',m.text,'document',m.document,'attachments',m.attachments,'created_at',m.created_at,'client_message_id',m.client_message_id,
    'reaction_sequence',m.reaction_sequence::text,
    'thread_root_id',coalesce((SELECT id FROM messages WHERE workspace_id=m.workspace_id AND channel_id=m.channel_id
      AND thread_id=m.thread_id AND sequence<m.sequence ORDER BY sequence LIMIT 1),m.id),
    'agent_sessions',CASE WHEN m.id=(SELECT id FROM messages WHERE workspace_id=m.workspace_id AND channel_id=m.channel_id AND thread_id=m.thread_id ORDER BY sequence LIMIT 1)
      THEN coalesce((SELECT jsonb_agg(link) FROM (
        SELECT a.id,a.title,d.name AS agent_name FROM messages ref
        JOIN agent_sessions a ON a.id=ref.agent_session_id
        JOIN agent_installations i ON i.id=a.installation_id JOIN agent_definitions d ON d.id=i.definition_id
        WHERE ref.workspace_id=m.workspace_id AND ref.channel_id=m.channel_id AND ref.thread_id=m.thread_id
        ORDER BY ref.sequence LIMIT 100
      ) link),'[]'::jsonb) ELSE '[]'::jsonb END,
    'reply_count',(SELECT count(*)::int FROM messages WHERE workspace_id=m.workspace_id AND channel_id=m.channel_id
      AND thread_id=m.thread_id AND id<>m.id AND agent_session_id IS NULL),
    'reactions',coalesce((SELECT jsonb_agg(r ORDER BY r.emoji) FROM (
      SELECT emoji,count(*)::int AS count,array_agg(user_id ORDER BY user_id) AS user_ids FROM message_reactions
      WHERE channel_id=m.channel_id AND message_id=m.id GROUP BY emoji
    ) r),'[]'::jsonb),
    'author',jsonb_build_object('kind',m.author_type,'id',coalesce(m.user_id,m.installation_id,m.webhook_id),
      'name',CASE WHEN m.author_type='app' THEN m.webhook_name WHEN m.workflow_name IS NOT NULL THEN m.workflow_name WHEN m.author_type='human' THEN (SELECT display_name FROM users WHERE id=m.user_id)
        ELSE (SELECT d.name FROM agent_installations i JOIN agent_definitions d ON d.id=i.definition_id WHERE i.id=m.installation_id) END))
    || CASE WHEN m.deleted_at IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('deleted_at',m.deleted_at) END
    || CASE WHEN m.agent_response IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('agent_response',m.agent_response) END;
$$;
