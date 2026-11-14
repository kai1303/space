import { sql } from 'drizzle-orm';
import { AppError, record, uuid, type Page, type SessionResourceMessage } from '@space/contracts';
import type { DbSession } from './database.js';

export async function readSessionResources(c:DbSession, session:{id:string;origin_thread_id:string;workspace_id:string}, query:unknown):Promise<Page<SessionResourceMessage>> {
  const {before} = record(query,['before']);
  let cursor: {id:string; kind:string; stamp:string} | undefined;
  if (before !== undefined) {
    if (typeof before !== 'string') throw new AppError(400,'invalid_cursor');
    const [kind, key, extra] = before.split(':');
    if (extra !== undefined || (kind !== 'task' && kind !== 'steer')) throw new AppError(400,'invalid_cursor');
    const id = uuid(key);
    const anchor = await c.execute<{stamp:string}>(kind === 'task'
      ? sql`SELECT created_at::text AS stamp FROM tasks WHERE session_id=${session.id} AND id=${id}`
      : sql`SELECT created_at::text AS stamp FROM agent_session_inputs WHERE session_id=${session.id} AND id=${id} AND kind='steer' AND state='sent'`);
    if (!anchor.rows[0]) throw new AppError(400,'invalid_cursor');
    cursor = {id,kind,stamp:anchor.rows[0].stamp};
  }
  const after = (kind:'task'|'steer') => cursor
    ? sql`AND (created_at,id,${kind}::text)<(${cursor.stamp}::timestamptz,${cursor.id}::uuid,${cursor.kind}::text)` : sql``;
  const queryResult = await c.execute<SessionResourceMessage & {kind:string} & Record<string,unknown>>(sql`
    WITH inputs AS (
      (SELECT 'task'::text AS kind,id,requester_id AS actor,created_at,channel_shared_urls(goal,request_document) AS links
       FROM tasks WHERE session_id=${session.id}
       AND (attachments <> '[]' OR cardinality(channel_shared_urls(goal,request_document))>0)
       ${after('task')} ORDER BY created_at DESC,id DESC LIMIT 21)
      UNION ALL
      (SELECT 'steer'::text,id,actor_id,created_at,channel_shared_urls(body->>'text',body->'document')
       FROM agent_session_inputs WHERE session_id=${session.id} AND kind='steer' AND state='sent'
       AND cardinality(channel_shared_urls(body->>'text',body->'document'))>0
       ${after('steer')} ORDER BY created_at DESC,id DESC LIMIT 21)
    )
    SELECT r.kind,r.id,u.display_name AS author,r.created_at::text,r.links,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'type',a.type,'size',a.size) ORDER BY a.created_at,a.id)
        FROM assets a WHERE r.kind='task' AND a.task_id=r.id AND a.workspace_id=${session.workspace_id}
        AND a.channel_id=(SELECT channel_id FROM threads WHERE id=${session.origin_thread_id})
        AND a.status='ready' AND NOT a.encrypted),'[]') AS files
    FROM inputs r JOIN users u ON u.id=r.actor ORDER BY r.created_at DESC,r.id DESC,r.kind DESC LIMIT 21`);
  const page = queryResult.rows.slice(0,20);
  return {
    items:page.filter(row=>row.files.length || row.links.length).map(({kind,id,author,created_at,files,links})=>({
      id:kind+':'+id, author,created_at:new Date(created_at).toISOString(),files,links,
    })),
    next_cursor:queryResult.rows.length>20 ? page[19]!.kind+':'+page[19]!.id : null,
  };
}
