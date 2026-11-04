import { visibleWorkspacePeer } from './workspace-access.js';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { AppError, parsePage, record, uuid, type DirectMessageSummary, type ChannelMember } from '@space/contracts';
import type { Database, DbSession } from './database.js';
import { hasChannelAccess, requireWorkspaceAccess } from './access.js';
import { sessionTransaction } from './session-concurrency.js';
import { page } from './membership.js';

type DirectMessageRow = DirectMessageSummary & { activity_at: string };
function directCursor(input: unknown): { at: string; id: string } {
  try {
    if (typeof input !== 'string' || input.length > 240 || !/^[A-Za-z0-9_-]+$/.test(input)) throw new Error();
    const value = record(JSON.parse(Buffer.from(input, 'base64url').toString('utf8')), ['at', 'id']);
    const at = value.at;
    if (typeof at !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at)
      || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== `${at.slice(0,23)}Z`) throw new Error();
    return { at, id: uuid(value.id) };
  } catch { throw new AppError(400, 'invalid_cursor'); }
}
function search(input: unknown, direct = false) {
  const v = record(input, ['after', 'limit', 'q', 'unread']);
  if (v.q !== undefined && (typeof v.q !== 'string' || v.q.length > 100 || v.q.includes('\0'))) throw new AppError(400, 'invalid_query');
  if (v.unread !== undefined && v.unread !== 'true' && v.unread !== 'false') throw new AppError(400, 'invalid_unread');
  return { cursor: direct && v.after !== undefined ? directCursor(v.after) : undefined, unread: v.unread === 'true', ...parsePage({ ...(direct || v.after === undefined ? {} : { after: v.after }), ...(v.limit === undefined ? {} : { limit: v.limit }) }), q: (v.q as string | undefined)?.trim() ?? '' };
}
export class DirectMessageStore {
  constructor(readonly db: Database) {}
  async people(actor: string, workspace: string, input: unknown = {}) {
    const { after, limit, q } = search(input);
    return this.db.transaction(async c => {
      await requireWorkspaceAccess(c, actor, workspace);
      const rows = await c.execute<ChannelMember & Record<string, unknown>>(sql`SELECT u.id,u.display_name AS name,u.image,u.title,u.presence
        FROM workspace_members wm JOIN users u ON u.id=wm.user_id
        WHERE wm.workspace_id=${workspace} AND wm.active AND (${after ?? null}::uuid IS NULL OR u.id>${after ?? null}::uuid)
          AND ${visibleWorkspacePeer(workspace,actor,sql`u.id`)}
          AND position(lower(${q}) IN lower(u.display_name||' '||u.full_name))>0 ORDER BY u.id LIMIT ${limit + 1}`);
      return page(rows.rows, limit, row => row.id);
    });
  }
  private async summaries(c: DbSession, actor: string, workspace: string, channel?: string, input: unknown = {}) {
    const { cursor, limit, q, unread } = search(input, true);
    if (cursor && !(await c.execute(sql`SELECT 1 FROM direct_message_views WHERE workspace_id=${workspace} AND user_id=${actor} AND channel_id=${cursor.id}`)).rows.length) throw new AppError(400, 'invalid_cursor');
    const rows = await c.execute<DirectMessageRow & Record<string, unknown>>(sql`SELECT ch.id,ch.workspace_id,'direct' AS kind,
      CASE WHEN ch.direct_user_low=ch.direct_user_high THEN peer.display_name||' (you)' ELSE peer.display_name END AS name,
      true AS private,true AS joined,ch.topic,ch.description,NULL::text AS archived_at,ch.created_by,ch.created_at::text,
      v.hidden,p.participants,l.last_message,to_char(v.last_activity_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS activity_at
      FROM direct_message_views v JOIN channels ch ON ch.id=v.channel_id AND ch.workspace_id=v.workspace_id
      JOIN users peer ON peer.id=CASE WHEN ch.direct_user_low=${actor}::uuid THEN ch.direct_user_high ELSE ch.direct_user_low END
      JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('id',u.id,'name',u.display_name,'image',u.image,'title',u.title,'presence',u.presence) ORDER BY u.id) AS participants
        FROM users u WHERE u.id IN (ch.direct_user_low,ch.direct_user_high)) p ON true
      LEFT JOIN LATERAL (SELECT jsonb_build_object('text',m.text,'created_at',m.created_at,'author_name',u.display_name) AS last_message
        FROM messages m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=ch.workspace_id AND m.channel_id=ch.id ORDER BY m.sequence DESC LIMIT 1) l ON true
      WHERE v.workspace_id=${workspace} AND v.user_id=${actor} AND (${channel ?? null}::uuid IS NOT NULL OR NOT v.hidden)
        AND (${channel ?? null}::uuid IS NULL OR ch.id=${channel ?? null}::uuid)
        AND (${cursor?.id ?? null}::uuid IS NULL OR (v.last_activity_at,ch.id)<(${cursor?.at ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
        AND position(lower(${q}) IN lower(peer.display_name||' '||peer.full_name))>0
        AND (${unread}=false OR EXISTS(SELECT 1 FROM messages um JOIN channel_reads cr ON cr.channel_id=um.channel_id AND cr.user_id=${actor}
          WHERE um.workspace_id=ch.workspace_id AND um.channel_id=ch.id AND um.user_id IS DISTINCT FROM ${actor}::uuid AND um.sequence>cr.last_read_sequence
            AND NOT EXISTS(SELECT 1 FROM messages earlier WHERE earlier.workspace_id=um.workspace_id AND earlier.channel_id=um.channel_id AND earlier.thread_id=um.thread_id AND earlier.sequence<um.sequence)))
      ORDER BY v.last_activity_at DESC,ch.id DESC LIMIT ${limit + 1}`);
    return rows.rows;
  }
  async summary(c: DbSession, actor: string, workspace: string, channel: string) {
    const [row] = await this.summaries(c, actor, workspace, channel);
    if (!row) throw new AppError(404, 'not_found');
    const { activity_at, ...summary } = row;
    return summary;
  }
  async list(actor: string, workspace: string, input: unknown = {}) {
    const { limit } = search(input, true);
    return this.db.transaction(async c => {
      await requireWorkspaceAccess(c, actor, workspace);
      const result = page(await this.summaries(c, actor, workspace, undefined, input), limit,
        row => Buffer.from(JSON.stringify({ at: row.activity_at, id: row.id })).toString('base64url'));
      return { ...result, items: result.items.map(({ activity_at, ...summary }) => summary) };
    });
  }
  async open(actor: string, workspace: string, input: unknown) {
    const user = uuid(record(input, ['user_id']).user_id);
    const [low, high] = [actor, user].sort() as [string, string];
    return sessionTransaction(this.db, async c => {
      await requireWorkspaceAccess(c, actor, workspace); await requireWorkspaceAccess(c, user, workspace);
      const found = await c.execute<{ id: string }>(sql`SELECT id FROM channels WHERE workspace_id=${workspace} AND kind='direct' AND direct_user_low=${low} AND direct_user_high=${high}`);
      const id = found.rows[0]?.id ?? randomUUID();
      if (!found.rows.length) {
        const permitted = await c.execute(sql`SELECT 1 WHERE ${visibleWorkspacePeer(workspace,actor,sql`${user}::uuid`)} AND ${visibleWorkspacePeer(workspace,user,sql`${actor}::uuid`)}`);
        if (!permitted.rows.length) throw new AppError(403,'guest_direct_message_forbidden');
        await c.execute(sql`INSERT INTO channels(id,workspace_id,name,private,kind,direct_user_low,direct_user_high,created_by)
          VALUES(${id},${workspace},'Direct message',true,'direct',${low},${high},${actor})`);
        for (const member of [...new Set([low, high])]) {
          await c.execute(sql`INSERT INTO channel_members(workspace_id,channel_id,user_id) VALUES(${workspace},${id},${member})`);
          await c.execute(sql`INSERT INTO direct_message_views(workspace_id,channel_id,user_id,hidden) VALUES(${workspace},${id},${member},${member !== actor})`);
        }
      }
      await c.execute(sql`UPDATE direct_message_views SET hidden=false WHERE channel_id=${id} AND user_id=${actor} AND hidden`);
      return this.summary(c, actor, workspace, id);
    });
  }
  async visibility(actor: string, channel: string, input: unknown) {
    const v = record(input, ['hidden']);
    if (typeof v.hidden !== 'boolean') throw new AppError(400, 'invalid_hidden');
    return sessionTransaction(this.db, async c => {
      const found = await c.execute<{ workspace_id: string }>(sql`SELECT workspace_id FROM channels WHERE id=${channel} AND kind='direct'`);
      const workspace = found.rows[0]?.workspace_id;
      if (!workspace || !await hasChannelAccess(c, actor, workspace, channel)) throw new AppError(404, 'not_found');
      await c.execute(sql`UPDATE direct_message_views SET hidden=${v.hidden} WHERE channel_id=${channel} AND user_id=${actor} AND hidden<>${v.hidden}`);
      return this.summary(c, actor, workspace, channel);
    });
  }
}
