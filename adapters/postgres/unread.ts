import { sessionTransaction } from './session-concurrency.js';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { AppError, chatCursor, record, uuid, type WorkspaceUnread } from '@space/contracts';
import { database, type DbSession } from './database.js';
import { hasChannelAccess, lockWorkspace, requireWorkspaceAccess } from './access.js';

export class UnreadStore {
  readonly db;
  constructor(pool: Pool) { this.db = database(pool); }

  async summary(actor: string, workspace: string): Promise<WorkspaceUnread> {
    workspace = uuid(workspace);
    return this.db.transaction(async c => {
      await requireWorkspaceAccess(c, actor, workspace);
      const root = sql`NOT EXISTS (SELECT 1 FROM messages earlier WHERE earlier.workspace_id=${workspace}
        AND earlier.channel_id=ch.id AND earlier.thread_id=m.thread_id AND earlier.sequence<m.sequence)`;
      const result = await c.execute<WorkspaceUnread['channels'][number] & Record<string, unknown>>(sql`
        SELECT ch.id AS channel_id,coalesce(r.last_read_sequence,0)::text AS last_read_sequence,
          coalesce((SELECT m.sequence FROM messages m WHERE m.workspace_id=${workspace} AND m.channel_id=ch.id AND ${root} ORDER BY m.sequence DESC LIMIT 1),0)::text AS latest_sequence,
          coalesce(m.unread_count,0)::int AS unread_count
        FROM channel_members cm JOIN channels ch ON ch.id=cm.channel_id AND ch.workspace_id=cm.workspace_id
        LEFT JOIN channel_reads r ON r.channel_id=cm.channel_id AND r.user_id=cm.user_id
        LEFT JOIN LATERAL (
          SELECT count(*) FILTER (WHERE m.user_id IS DISTINCT FROM ${actor}::uuid) AS unread_count
          FROM messages m WHERE m.workspace_id=${workspace} AND m.channel_id=ch.id AND m.sequence>coalesce(r.last_read_sequence,0) AND ${root}
        ) m ON true
        WHERE cm.workspace_id=${workspace} AND cm.user_id=${actor} ORDER BY ch.id`);
      return { workspace_id: workspace, channels: result.rows };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  async markRead(actor: string, channel: string, input: unknown) {
    channel = uuid(channel);
    const v = record(input, ['sequence']);
    if (v.sequence === undefined) throw new AppError(400, 'invalid_cursor');
    const sequence = chatCursor(v.sequence);
    const direct = await this.db.execute<{ kind: string }>(sql`SELECT kind FROM channels WHERE id=${channel}`);
    const work = async (c: DbSession) => {
      const ref = await c.execute<{ workspace_id: string }>(sql`SELECT workspace_id FROM channels WHERE id=${channel}`);
      if (!ref.rows[0]) throw new AppError(404, 'not_found');
      const workspace = ref.rows[0].workspace_id;
      if (direct.rows[0]?.kind !== 'direct') {
        await lockWorkspace(c, workspace);
        await c.execute(sql`SELECT id FROM channels WHERE id=${channel} FOR UPDATE`);
      }
      if (!await hasChannelAccess(c, actor, workspace, channel)) throw new AppError(404, 'not_found');
      if (sequence !== '0' && !(await c.execute(sql`SELECT id FROM messages WHERE workspace_id=${workspace} AND channel_id=${channel} AND sequence=${sequence}::bigint`)).rows.length) {
        throw new AppError(400, 'invalid_read_sequence');
      }
      await c.execute(sql`UPDATE channel_reads SET last_read_sequence=${sequence}::bigint
        WHERE channel_id=${channel} AND user_id=${actor} AND last_read_sequence<${sequence}::bigint`);
      const result = await c.execute<{ last_read_sequence: string }>(sql`SELECT last_read_sequence::text FROM channel_reads WHERE channel_id=${channel} AND user_id=${actor}`);
      return result.rows[0]!;
    };
    return direct.rows[0]?.kind === 'direct' ? sessionTransaction(this.db, work) : this.db.transaction(work);
  }
}
