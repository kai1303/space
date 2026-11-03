ALTER TABLE messages ADD COLUMN reaction_sequence bigint NOT NULL DEFAULT 0;
CREATE TABLE message_reactions (
  channel_id uuid NOT NULL,
  message_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  emoji text NOT NULL CHECK (length(emoji) BETWEEN 1 AND 64),
  PRIMARY KEY(channel_id,message_id,user_id,emoji),
  FOREIGN KEY(channel_id,message_id) REFERENCES messages(channel_id,id)
);
ALTER TABLE channel_events DROP CONSTRAINT channel_events_type_check;
ALTER TABLE channel_events ADD CONSTRAINT channel_events_type_check CHECK(type IN ('message.created','message.updated','task.event'));
CREATE OR REPLACE FUNCTION chat_message_payload(m messages) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('id',m.id,'channel_id',m.channel_id,'thread_id',m.thread_id,'task_id',m.task_id,'sequence',m.sequence::text,
    'text',m.text,'document',m.document,'attachments',m.attachments,'created_at',m.created_at,'client_message_id',m.client_message_id,
    'reaction_sequence',m.reaction_sequence::text,
    'reactions',coalesce((SELECT jsonb_agg(r ORDER BY r.emoji) FROM (
      SELECT emoji,count(*)::int AS count,array_agg(user_id ORDER BY user_id) AS user_ids FROM message_reactions
      WHERE channel_id=m.channel_id AND message_id=m.id GROUP BY emoji
    ) r),'[]'::jsonb),
    'author',jsonb_build_object('kind',m.author_type,'id',coalesce(m.user_id,m.installation_id),
      'name',CASE WHEN m.author_type='human' THEN (SELECT display_name FROM users WHERE id=m.user_id)
        ELSE (SELECT d.name FROM agent_installations i JOIN agent_definitions d ON d.id=i.definition_id WHERE i.id=m.installation_id) END))
    || CASE WHEN m.agent_response IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('agent_response',m.agent_response) END;
$$;
