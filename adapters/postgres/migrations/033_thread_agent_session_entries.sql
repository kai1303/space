ALTER TABLE messages ADD COLUMN agent_session_id uuid REFERENCES agent_sessions(id);
ALTER TABLE messages ADD CONSTRAINT messages_session_author CHECK (agent_session_id IS NULL OR author_type='agent');
CREATE FUNCTION immutable_message_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.agent_session_id IS DISTINCT FROM OLD.agent_session_id THEN RAISE EXCEPTION 'message session is immutable'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER messages_immutable_session BEFORE UPDATE OF agent_session_id ON messages FOR EACH ROW EXECUTE FUNCTION immutable_message_session();
-- Old thread subscriptions no longer route ordinary discussion into agent turns.
UPDATE agent_thread_subscriptions SET status='closed' WHERE status='active';
CREATE OR REPLACE FUNCTION chat_message_payload(m messages) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('id',m.id,'channel_id',m.channel_id,'thread_id',m.thread_id,'task_id',m.task_id,'agent_session_id',m.agent_session_id,'sequence',m.sequence::text,
    'text',m.text,'document',m.document,'attachments',m.attachments,'created_at',m.created_at,'client_message_id',m.client_message_id,
    'reaction_sequence',m.reaction_sequence::text,
    'thread_root_id',coalesce((SELECT id FROM messages WHERE workspace_id=m.workspace_id AND channel_id=m.channel_id
      AND thread_id=m.thread_id AND sequence<m.sequence ORDER BY sequence LIMIT 1),m.id),
    'reply_count',(SELECT count(*)::int FROM messages WHERE workspace_id=m.workspace_id AND channel_id=m.channel_id
      AND thread_id=m.thread_id AND id<>m.id),
    'reactions',coalesce((SELECT jsonb_agg(r ORDER BY r.emoji) FROM (
      SELECT emoji,count(*)::int AS count,array_agg(user_id ORDER BY user_id) AS user_ids FROM message_reactions
      WHERE channel_id=m.channel_id AND message_id=m.id GROUP BY emoji
    ) r),'[]'::jsonb),
    'author',jsonb_build_object('kind',m.author_type,'id',coalesce(m.user_id,m.installation_id),
      'name',CASE WHEN m.author_type='human' THEN (SELECT display_name FROM users WHERE id=m.user_id)
        ELSE (SELECT d.name FROM agent_installations i JOIN agent_definitions d ON d.id=i.definition_id WHERE i.id=m.installation_id) END))
    || CASE WHEN m.agent_response IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('agent_response',m.agent_response) END;
$$;
