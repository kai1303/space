-- Group by public author before resolving profiles, so only the five displayed
-- participants require a profile lookup. The thread sequence index scopes reads.
CREATE FUNCTION chat_reply_summary(workspace uuid, channel uuid, thread uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
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
  FROM participants
$$;
