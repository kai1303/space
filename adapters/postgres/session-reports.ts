import { sql } from 'drizzle-orm';
import { AppError, record, uuid, type SessionReport } from '@space/contracts';
import { hasChannelAccess } from './access.js';
import type { Database } from './database.js';

export async function readSessionReports(db: Database, actor: string, channel: string, raw: unknown) {
  const { threads } = record(raw, ['threads']);
  if (!Array.isArray(threads) || !threads.length || threads.length > 32) throw new AppError(400, 'invalid_threads');
  const ids = [...new Set(threads.map(id => uuid(id)))];
  return db.transaction(async c => {
    const [room] = (await c.execute<{workspace_id:string}>(sql`SELECT workspace_id FROM channels WHERE id=${channel}`)).rows;
    if (!room || !await hasChannelAccess(c, actor, room.workspace_id, channel)) throw new AppError(404, 'not_found');
    const reports = await c.execute<SessionReport & Record<string, unknown>>(sql`
      SELECT t.id AS thread_id, report.* FROM threads t CROSS JOIN LATERAL (
        SELECT a.id, a.title, coalesce(origin.source_message_id,root.id) AS source_message_id,
          CASE WHEN latest.status='completed' THEN left(latest.result,240) END AS result,
          CASE WHEN jsonb_array_length(a.outputs->'changes')>0 THEN 'changes'
               WHEN a.outputs->'preview'->>'state'='ready' THEN 'preview'
               WHEN jsonb_array_length(a.outputs->'files')>0 THEN 'files'
               WHEN jsonb_array_length(a.outputs->'views')>0 THEN 'artifacts' END AS artifact
        FROM agent_sessions a
        JOIN LATERAL (SELECT m.id FROM messages m WHERE m.channel_id=t.channel_id AND m.thread_id=t.id
          ORDER BY m.sequence LIMIT 1) root ON true
        LEFT JOIN LATERAL (SELECT source_message_id FROM navigator_authorizations n WHERE n.session_id=a.id
          AND n.action='start' AND n.thread_id=t.id ORDER BY n.created_at LIMIT 1) origin ON true
        LEFT JOIN LATERAL (SELECT status,result FROM tasks WHERE session_id=a.id ORDER BY created_at DESC,id DESC LIMIT 1) latest ON true
        WHERE a.origin_thread_id=t.id AND a.managed AND a.handoff_context IS NULL AND a.parent_session_id IS NULL
          AND EXISTS (SELECT 1 FROM messages m WHERE m.id=coalesce(origin.source_message_id,root.id)
            AND m.channel_id=t.channel_id AND m.thread_id=t.id AND m.deleted_at IS NULL AND m.retained_at IS NULL)
        ORDER BY a.created_at DESC,a.id DESC LIMIT 100
      ) report WHERE t.channel_id=${channel} AND t.id IN (${sql.join(ids.map(id=>sql`${id}::uuid`),sql`,`)})`);
    return {items:reports.rows};
  }, {isolationLevel:'repeatable read',accessMode:'read only'});
}
