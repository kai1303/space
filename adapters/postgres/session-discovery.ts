import { sql } from 'drizzle-orm';
import { AppError, record, sessionWorkStatusLabels, text, uuid, type SessionDiscoveryItem, type SessionDiscoveryPage, type SessionWorkStatus } from '@space/contracts';
import { requireWorkspaceAccess } from './access.js';
import type { Database } from './database.js';
import { sessionSidebarActivity } from './session-sidebar-activity.js';
import { sessionWorkStatus } from './session-work-status.js';

export async function discoverSessions(db: Database, actor: string, workspace: string, raw: unknown): Promise<SessionDiscoveryPage> {
  const input = record(raw, ['q','agent','creator','channel','status','archived','scope','before']);
  const term = (value: unknown) => value === undefined ? '' : text(value,160).trim();
  const q = term(input.q), agent = term(input.agent), creator = term(input.creator), channel = term(input.channel);
  const status = input.status === undefined ? '' : text(input.status,32);
  if (status && !Object.hasOwn(sessionWorkStatusLabels,status)) throw new AppError(400,'invalid_session_status');
  const archived = input.archived ?? 'all';
  if (typeof archived!=='string' || !['all','true','false'].includes(archived)) throw new AppError(400,'invalid_archive_filter');
  const scope = input.scope ?? 'all';
  if (scope !== 'all' && scope !== 'workspace') throw new AppError(400,'invalid_session_scope');
  const sharedWithWorkspace = scope === 'workspace' ? sql`AND EXISTS (SELECT 1 FROM session_team_visibility WHERE session_id=a.id)` : sql``;
  const before = input.before === undefined ? undefined : uuid(input.before);
  return db.transaction(async c => {
    await requireWorkspaceAccess(c,actor,workspace);
    const sharedReview = sql`a.handoff_context IS NULL AND EXISTS (
      SELECT 1 FROM workspace_members w WHERE w.workspace_id=a.workspace_id AND w.user_id=${actor} AND w.active AND w.guest_type='none'
    ) AND (EXISTS (SELECT 1 FROM session_reviewers r WHERE r.session_id=a.id AND r.user_id=${actor})
      OR EXISTS (SELECT 1 FROM session_team_visibility v WHERE v.session_id=a.id))`;
    const cursor = before ? (await c.execute<{created_at:string}>(sql`
      SELECT a.created_at::text FROM agent_sessions a JOIN threads t ON t.id=a.origin_thread_id
      WHERE a.id=${before} AND a.workspace_id=${workspace} AND a.managed AND (
        EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id=t.channel_id AND m.user_id=${actor}) OR (${sharedReview}))`)).rows[0] : undefined;
    if (before && !cursor) throw new AppError(404,'not_found');
    const continuation = cursor ? sql`AND (a.created_at,a.id)<(${cursor.created_at}::timestamptz,${before}::uuid)` : sql``;
    const wordQuery = sql`plainto_tsquery('simple',${q})`;
    // Keep the reviewer branch independent: filtering by private channel, creator,
    // provider, status or conversation text must never reveal a source-room match.
    const reviewers = !agent && !creator && !channel && !status && archived === 'all' ? sql`
      UNION ALL
      SELECT a.id,a.title,a.created_at,true,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL
      FROM agent_sessions a JOIN threads t ON t.id=a.origin_thread_id
      WHERE a.workspace_id=${workspace} AND a.managed AND ${sharedReview} ${sharedWithWorkspace}
        AND NOT EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id=t.channel_id AND m.user_id=${actor})
        ${q ? sql`AND strpos(lower(a.title),lower(${q}))>0` : sql``} ${continuation}` : sql``;
    const result = await c.execute<{id:string; title:string; review_only:boolean; origin_thread_id:string; channel_id:string;
      agent_name:string; channel_archived:boolean; channel_name:string; creator_name:string|null; sidebar_archived:boolean; sidebar_inactive:boolean; status:SessionWorkStatus}>(sql`
      SELECT * FROM (
        SELECT a.id,a.title,a.created_at,false AS review_only,a.origin_thread_id,t.channel_id,ch.archived_at IS NOT NULL AS channel_archived,
          coalesce(ac.name,d.name) AS agent_name,CASE WHEN ch.kind='direct' THEN 'Direct message' ELSE ch.name END AS channel_name,
          u.display_name AS creator_name,coalesce(p.archived,false) AS sidebar_archived,coalesce(idle.expires<=now(),false) AS sidebar_inactive,${sessionWorkStatus(sql`a.id`,sql`a.state`)} AS status
        FROM channel_members m JOIN threads t ON t.channel_id=m.channel_id JOIN agent_sessions a ON a.origin_thread_id=t.id
        JOIN channels ch ON ch.id=t.channel_id JOIN agent_installations i ON i.id=a.installation_id
        JOIN agent_definitions d ON d.id=i.definition_id LEFT JOIN agent_connections ac ON ac.installation_id=i.id
        LEFT JOIN users u ON u.id=a.created_by LEFT JOIN session_sidebar_preferences p ON p.session_id=a.id AND p.user_id=m.user_id
        ${sessionSidebarActivity}
        WHERE m.workspace_id=${workspace} AND m.user_id=${actor} AND a.workspace_id=${workspace} AND a.managed ${sharedWithWorkspace} ${continuation}
          ${agent ? sql`AND strpos(lower(coalesce(ac.name,d.name)),lower(${agent}))>0` : sql``}
          ${creator ? sql`AND strpos(lower(u.display_name),lower(${creator}))>0` : sql``}
          ${channel ? sql`AND strpos(lower(CASE WHEN ch.kind='direct' THEN 'Direct message' ELSE ch.name END),lower(${channel}))>0` : sql``}
          ${archived === 'all' ? sql`` : archived === 'true' ? sql`AND p.archived` : sql`AND NOT coalesce(p.archived,false) AND (idle.expires IS NULL OR idle.expires>now())`}
          ${q ? sql`AND (strpos(lower(a.title),lower(${q}))>0 OR EXISTS (
            SELECT 1 FROM tasks v WHERE v.session_id=a.id AND to_tsvector('simple',v.goal||' '||coalesce(v.result,'')) @@ ${wordQuery}
          ) OR EXISTS (
            SELECT 1 FROM task_events e JOIN tasks v ON v.id=e.correlation_id
            WHERE v.session_id=a.id AND e.type IN ('task.completed','task.failed') AND e.payload ? 'response'
              AND session_response_words(e.payload) @@ ${wordQuery}
          ) OR EXISTS (
            SELECT 1 FROM session_discussion_messages n WHERE n.session_id=a.id AND to_tsvector('simple',n.body) @@ ${wordQuery}
          ) OR EXISTS (
            SELECT 1 FROM agent_session_inputs inp WHERE inp.session_id=a.id AND inp.kind='steer' AND inp.state='sent'
              AND to_tsvector('simple',inp.body->>'text') @@ ${wordQuery}
          ))` : sql``}
        ${reviewers}
      ) hits ${status ? sql`WHERE status=${status}` : sql``}
      ORDER BY created_at DESC,id DESC LIMIT 26`);
    const items = result.rows.slice(0,25).map((row):SessionDiscoveryItem => row.review_only
      ? {access:'reviewer',id:row.id,title:row.title}
      : {access:'source',id:row.id,title:row.title,status:row.status,origin_thread_id:row.origin_thread_id,channel_id:row.channel_id,
        channel_name:row.channel_name,channel_archived:row.channel_archived,creator_name:row.creator_name,agent_name:row.agent_name,sidebar_archived:row.sidebar_archived,...(row.sidebar_inactive ? {sidebar_inactive:true} : {})});
    return {items,next_cursor: result.rows.length>25 ? items.at(-1)!.id : null};
  }, {isolationLevel:'repeatable read',accessMode:'read only'});
}
