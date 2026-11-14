import { sql, type SQL } from 'drizzle-orm';

// Kept identical for the source message and the session browser.
export function sessionWorkStatus(id: SQL, state: SQL) {
  return sql`CASE WHEN ${state}='ended' THEN 'archived'
    WHEN EXISTS (SELECT 1 FROM agent_session_inputs WHERE session_id=${id} AND kind='queue' AND state='blocked') THEN 'needs_attention'
    ELSE coalesce((SELECT CASE
      WHEN task.status='awaiting_approval' OR (task.status='running' AND EXISTS (
        SELECT 1 FROM agent_tool_approvals WHERE execution_id=task.active_execution_id AND status='pending'
      )) THEN 'needs_attention'
      WHEN task.status IN ('queued','running') THEN 'active'
      WHEN task.status='completed' THEN 'done'
      WHEN task.status='failed' AND NOT EXISTS (
        SELECT 1 FROM task_events WHERE correlation_id=task.id AND type='task.failed' AND payload->>'code'='session_stopped'
      ) THEN 'needs_attention'
      ELSE 'inactive' END FROM tasks task WHERE task.session_id=${id} ORDER BY task.created_at DESC,task.id DESC LIMIT 1),'inactive') END`;
}
