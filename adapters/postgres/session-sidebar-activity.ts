import { sql } from 'drizzle-orm';

// Both queries already restrict a to the viewer's accessible managed sessions.
// Personal sidebar choices and starred sessions are exempt from idle expiry.
export const sessionSidebarActivity = sql`LEFT JOIN LATERAL (
  SELECT greatest(a.created_at, a.sidebar_activity_at,
    (SELECT updated_at FROM tasks WHERE session_id=a.id ORDER BY updated_at DESC LIMIT 1),
    (SELECT created_at FROM agent_session_inputs WHERE session_id=a.id ORDER BY created_at DESC LIMIT 1),
    (SELECT created_at FROM session_discussion_messages WHERE session_id=a.id ORDER BY created_at DESC LIMIT 1)
  ) + interval '168 hours' AS expires
  WHERE a.handoff_context IS NULL AND p.session_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM hub_starred_agent_sessions star WHERE star.workspace_id=a.workspace_id AND star.user_id=m.user_id AND star.session_id=a.id)
    AND NOT EXISTS (SELECT 1 FROM tasks WHERE session_id=a.id AND status IN ('running','queued'))
) idle ON true`;
