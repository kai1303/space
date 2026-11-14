-- Keep the partitioned message queries as cached SPI plans across calls on each connection.
CREATE OR REPLACE FUNCTION chat_message_payload(m messages) RETURNS jsonb LANGUAGE plpgsql STABLE
SET plan_cache_mode = force_generic_plan
SET jit = off AS $$
BEGIN
  RETURN (SELECT jsonb_build_object('id',m.id,'channel_id',m.channel_id,'thread_id',m.thread_id,'task_id',m.task_id,'agent_session_id',m.agent_session_id,'sequence',m.sequence::text,
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
    || CASE WHEN m.agent_response IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('agent_response',m.agent_response) END
    || CASE WHEN m.encrypted IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('encrypted',m.encrypted) END
    || CASE WHEN m.channel_broadcast_sequence IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('channel_broadcast_sequence',m.channel_broadcast_sequence::text) END);
END;
$$;

CREATE OR REPLACE FUNCTION chat_reply_summary(workspace uuid, channel uuid, thread uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE
SET plan_cache_mode = force_generic_plan
SET jit = off AS $$
BEGIN
  RETURN (
  WITH participants AS MATERIALIZED (
    SELECT m.author_type AS kind, coalesce(m.user_id,m.installation_id,m.webhook_id) AS id,
      CASE WHEN m.author_type='workflow' THEN m.workflow_name END AS workflow,
      max(m.webhook_name) AS app_name,
      count(*)::int AS total, max(m.sequence) AS latest, max(m.created_at) AS last_reply
    FROM messages m
    WHERE m.workspace_id=workspace AND m.channel_id=channel AND m.thread_id=thread
      AND m.sequence > (SELECT min(r.sequence) FROM messages r
        WHERE r.workspace_id=workspace AND r.channel_id=channel AND r.thread_id=thread)
      AND NOT EXISTS (SELECT 1 FROM agent_sessions private_session
        WHERE private_session.origin_thread_id=thread AND private_session.handoff_context IS NOT NULL)
      AND m.agent_session_id IS NULL AND m.deleted_at IS NULL AND m.retained_at IS NULL
    GROUP BY 1,2,3
  ), faces AS (
    SELECT p.kind,p.id,coalesce(p.workflow,p.app_name,u.display_name,d.name) AS name,
      CASE WHEN p.kind='human' THEN u.image END AS image, p.latest
    FROM (SELECT * FROM participants ORDER BY latest DESC LIMIT 5) p
    LEFT JOIN users u ON p.kind='human' AND u.id=p.id
    LEFT JOIN agent_installations i ON p.kind='agent' AND i.id=p.id
    LEFT JOIN agent_definitions d ON d.id=i.definition_id
  )
  SELECT jsonb_build_object('count',coalesce(sum(total),0),'participant_count',count(*),
    'last_reply_at',max(last_reply),'participants',coalesce(
      (SELECT jsonb_agg((to_jsonb(f)-'latest') ORDER BY latest DESC) FROM faces f),'[]'::jsonb),
    'revision',(SELECT event_sequence::text FROM channels WHERE workspace_id=workspace AND id=channel))
  FROM participants);
END;
$$;
