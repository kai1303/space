ALTER TABLE messages ADD COLUMN deleted_at timestamptz;

-- A cancellation can arrive before the original send. Keep it for as long as
-- a disconnected client could retry the same identity.
CREATE TABLE cancelled_message_sends (
  channel_id uuid NOT NULL REFERENCES channels(id),
  user_id uuid NOT NULL REFERENCES users(id),
  client_message_id uuid NOT NULL,
  PRIMARY KEY(channel_id,user_id,client_message_id)
);

-- A deleted row keeps its identity and position even when a send is retried.
CREATE OR REPLACE FUNCTION protect_retained_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
     OR OLD.retained_at IS NOT NULL AND NEW.retained_at IS DISTINCT FROM OLD.retained_at
     OR NEW.deleted_at IS NOT NULL AND (NEW.author_type<>'human' OR NEW.text<>'Message deleted'
       OR NEW.document IS NOT NULL OR NEW.attachments<>'[]'::jsonb OR NEW.agent_response IS NOT NULL)
     OR NEW.deleted_at IS NULL AND NEW.retained_at IS NOT NULL AND (NEW.text<>'Message removed by workspace retention.'
       OR NEW.document IS NOT NULL OR NEW.attachments<>'[]'::jsonb OR NEW.agent_response IS NOT NULL) THEN
    RAISE EXCEPTION 'erased message content cannot be restored';
  END IF;
  RETURN NEW;
END; $$;

CREATE FUNCTION deleted_message_payload(payload jsonb, deleted_at timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT (payload-'agent_response') || jsonb_build_object('text','Message deleted','document',NULL,
    'attachments','[]'::jsonb,'reactions','[]'::jsonb,'deleted_at',deleted_at);
$$;

CREATE OR REPLACE FUNCTION protect_channel_event_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.type IN ('message.created','message.updated')
     AND (to_jsonb(NEW)-'payload')=(to_jsonb(OLD)-'payload')
     AND EXISTS(SELECT 1 FROM messages m WHERE m.workspace_id=OLD.workspace_id AND m.channel_id=OLD.channel_id AND m.id=(OLD.payload->>'id')::uuid
       AND ((m.deleted_at IS NOT NULL AND NEW.payload=deleted_message_payload(OLD.payload,m.deleted_at))
         OR (m.deleted_at IS NULL AND m.retained_at IS NOT NULL AND NEW.payload=retained_message_payload(OLD.payload)))) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'channel events are append-only except message content erasure';
END; $$;

-- Invalidate even if the user happened to send precisely the tombstone text.
CREATE OR REPLACE FUNCTION advance_message_search_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_order := OLD.search_order;
  IF (NEW.text,NEW.document,NEW.attachments,NEW.agent_session_id,NEW.deleted_at) IS DISTINCT FROM
     (OLD.text,OLD.document,OLD.attachments,OLD.agent_session_id,OLD.deleted_at) THEN
    NEW.search_revision := OLD.search_revision + 1;
  ELSE
    NEW.search_revision := OLD.search_revision;
  END IF;
  RETURN NEW;
END; $$;

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
    'author',jsonb_build_object('kind',m.author_type,'id',coalesce(m.user_id,m.installation_id),
      'name',CASE WHEN m.author_type='human' THEN (SELECT display_name FROM users WHERE id=m.user_id)
        ELSE (SELECT d.name FROM agent_installations i JOIN agent_definitions d ON d.id=i.definition_id WHERE i.id=m.installation_id) END))
    || CASE WHEN m.deleted_at IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('deleted_at',m.deleted_at) END
    || CASE WHEN m.agent_response IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('agent_response',m.agent_response) END;
$$;
