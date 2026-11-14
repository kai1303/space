import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, uuid } from '@space/contracts';
import type { Delivery } from '@space/core/ports';
import type { Pool } from 'pg';

// Use a purpose-specific proof. The attempt fence itself must never leave Space.
export function pdfToolToken(delivery: Pick<Delivery, 'id' | 'execution_id' | 'lease_token'>, connectionId: string) {
  const proof = createHmac('sha256', delivery.lease_token)
    .update(`read_pdf_page:${delivery.id}:${delivery.execution_id}:${connectionId}`).digest('base64url');
  return `${delivery.id}.${proof}`;
}

export async function authorizedPdfFiles(pool: Pool, token: string) {
  const denied = () => new AppError(403, 'pdf_tool_access_denied');
  if (!/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(token)) throw denied();
  const { rows } = await pool.query<{
    id: string; execution_id: string; lease_token: string; connection_id: string;
    asset_id: string; object_key: string; size: number; name: string;
  }>(`SELECT o.id,o.execution_id,o.lease_token,ac.connection_id,a.id AS asset_id,a.object_key,a.size,a.name
      FROM outbox o JOIN tasks t ON t.id=o.task_id AND t.active_execution_id=o.execution_id
      JOIN executions e ON e.id=o.execution_id AND e.task_id=t.id AND e.installation_id=t.installation_id AND e.session_id=t.session_id
      JOIN agent_sessions s ON s.id=t.session_id AND s.installation_id=t.installation_id AND s.state='active'
      JOIN agent_installations i ON i.id=t.installation_id AND i.workspace_id=t.workspace_id AND i.enabled
      JOIN agent_connections ac ON ac.installation_id=i.id AND ac.revoked_at IS NULL AND ac.auth_status='ready'
        AND ac.last_seen_at>now()-interval '45 seconds' AND ac.connection_id IS NOT NULL
      JOIN threads th ON th.id=t.thread_id AND th.workspace_id=t.workspace_id
      JOIN channels ch ON ch.id=th.channel_id AND ch.archived_at IS NULL
      JOIN workspace_members ow ON ow.workspace_id=t.workspace_id AND ow.user_id=i.owner_id AND ow.active
      JOIN workspace_members rw ON rw.workspace_id=t.workspace_id AND rw.user_id=t.requester_id AND rw.active
      JOIN channel_members oc ON oc.channel_id=th.channel_id AND oc.user_id=i.owner_id
      JOIN channel_members rc ON rc.channel_id=th.channel_id AND rc.user_id=t.requester_id
      JOIN assets a ON a.task_id=t.id AND a.workspace_id=t.workspace_id AND a.channel_id=th.channel_id
        AND a.uploader_id=t.requester_id AND a.status='ready' AND a.preview->>'kind'='pdf'
        AND t.attachments @> jsonb_build_array(jsonb_build_object('id',a.id))
      WHERE o.id=$1 AND o.state='delivering' AND o.lease_until>now() AND o.lease_token IS NOT NULL
        AND (NOT o.direct OR o.direct_connection=ac.connection_id)
        AND i.connector_id IN ('codex.local','claude.local','kiro.local')
        AND e.status IN ('queued','running') AND t.status IN ('queued','running')`, [uuid(token.slice(0,36))]);
  const row = rows[0];
  if (!row || !timingSafeEqual(Buffer.from(pdfToolToken(row, row.connection_id)), Buffer.from(token))) throw denied();
  return rows.map(({asset_id,object_key,size,name}) => ({asset_id,object_key,size,name}));
}
