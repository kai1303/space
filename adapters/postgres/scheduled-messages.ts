import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { AppError, MAX_PENDING_SCHEDULED, parseScheduledMessageInput, parseScheduledMessageUpdate, uuid, type ScheduledMessage } from '@space/contracts';
import { database, type DbSession } from './database.js';
import { hasChannelAccess, requireWorkspaceAccess } from './access.js';
import { requireChannelCapability } from './channel-permissions.js';
import { sessionTransaction } from './session-concurrency.js';
import type { ChatStore } from './chat.js';

// Uploads normally expire 24 hours after upload. A scheduled file must outlive its send time;
// after sending, it is attached and no longer expires. A cancelled schedule returns it to a one-day lifetime.
const ASSET_GRACE = "interval '1 day'";
const notFound = () => new AppError(404, 'not_found');
// A bound text parameter cast to uuid[]; every element is validated first.
const uuids = (ids: string[]) => sql`${`{${ids.map(id => uuid(id)).join(',')}}`}::uuid[]`;
// Errors that will not change by retrying: the send is marked failed instead of retried.
const PERMANENT = new Set(['not_found', 'forbidden', 'channel_archived', 'asset_unavailable', 'channel_posting_forbidden', 'channel_replies_forbidden',
  'channel_broadcast_forbidden', 'direct_message_participant_inactive', 'idempotency_conflict', 'message_cancelled', 'broadcast_confirmation_required']);

type Row = { id: string; workspace_id: string; channel_id: string; channel_name: string | null; thread_id: string | null; user_id: string; text: string;
  document: ScheduledMessage['document']; asset_ids: string[]; asset_descriptions: Record<string, string> | null; send_at: Date; status: ScheduledMessage['status'];
  message_id: string | null; error: string | null; created_at: Date; version: number; request_hash: string; attachments: ScheduledMessage['attachments'] | null };

const select = `SELECT sm.*, c.name AS channel_name, (SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'size',a.size,'type',a.type) ORDER BY a.id),'[]')
  FROM assets a WHERE a.id = ANY(sm.asset_ids)) AS attachments FROM scheduled_messages sm JOIN channels c ON c.id=sm.channel_id`;

function dto(row: Row): ScheduledMessage {
  return { id: row.id, workspace_id: row.workspace_id, channel_id: row.channel_id, channel_name: row.channel_name ?? '', thread_id: row.thread_id,
    text: row.text, document: row.document, attachments: row.attachments ?? [], send_at: new Date(row.send_at).toISOString(), status: row.status,
    message_id: row.message_id, error: row.error, created_at: new Date(row.created_at).toISOString() };
}

export class ScheduledMessageStore {
  readonly db;
  constructor(readonly pool: Pool, private readonly chat: ChatStore) { this.db = database(pool); }

  private async one(c: DbSession, id: string): Promise<Row | undefined> {
    return (await c.execute(sql`${sql.raw(select)} WHERE sm.id=${uuid(id)}`)).rows[0] as Row | undefined;
  }

  async schedule(actor: string, channelId: string, input: unknown): Promise<ScheduledMessage> {
    const request = parseScheduledMessageInput(input);
    const { message } = request;
    const hash = createHash('sha256').update(JSON.stringify({ channel_id: channelId, thread_id: message.thread_id, text: message.text, document: message.document ?? null,
      asset_ids: message.asset_ids ?? [], asset_descriptions: message.asset_descriptions ?? null, send_at: request.send_at })).digest('hex');
    return sessionTransaction(this.db, async c => {
      const channel = (await c.execute(sql`SELECT id,workspace_id,kind,archived_at FROM channels WHERE id=${uuid(channelId)}`)).rows[0] as
        { id: string; workspace_id: string; kind: string; archived_at: Date | null } | undefined;
      if (!channel || !await hasChannelAccess(c, actor, channel.workspace_id, channel.id)) throw notFound();
      // A retried request returns the stored schedule; a different request under the same id is a conflict.
      const existing = (await c.execute(sql`SELECT user_id,request_hash FROM scheduled_messages WHERE id=${request.id}`)).rows[0] as { user_id: string; request_hash: string } | undefined;
      if (existing) {
        if (existing.user_id !== actor || existing.request_hash !== hash) throw new AppError(409, 'idempotency_conflict');
        return dto((await this.one(c, request.id))!);
      }
      if (channel.archived_at) throw new AppError(409, 'channel_archived');
      if (channel.kind !== 'direct') await requireChannelCapability(c, actor, channel.id, message.thread_id ? 'reply' : 'post');
      if (message.thread_id && !(await c.execute(sql`SELECT 1 FROM threads WHERE id=${message.thread_id} AND channel_id=${channel.id}`)).rows.length) throw notFound();
      const pending = (await c.execute(sql`SELECT count(*)::int AS n FROM scheduled_messages
        WHERE workspace_id=${channel.workspace_id} AND user_id=${actor} AND status IN ('pending','sending')`)).rows[0] as { n: number };
      if (pending.n >= MAX_PENDING_SCHEDULED) throw new AppError(409, 'too_many_scheduled_messages');
      const assets = message.asset_ids ?? [];
      if (assets.length) {
        // Serializable isolation makes two schedules that claim the same upload conflict; one retries and sees the other.
        const held = await c.execute(sql`SELECT 1 FROM scheduled_messages WHERE status IN ('pending','sending') AND asset_ids && ${uuids(assets)} LIMIT 1`);
        if (held.rows.length) throw new AppError(409, 'asset_unavailable');
        const extended = await c.execute(sql`UPDATE assets SET expires_at=greatest(expires_at, ${request.send_at}::timestamptz + ${sql.raw(ASSET_GRACE)})
          WHERE id = ANY(${uuids(assets)}) AND channel_id=${channel.id} AND uploader_id=${actor}
            AND status='ready' AND message_id IS NULL AND task_id IS NULL AND queue_input_id IS NULL AND expires_at > clock_timestamp() RETURNING id`);
        if (extended.rows.length !== assets.length) throw new AppError(409, 'asset_unavailable');
      }
      await c.execute(sql`INSERT INTO scheduled_messages(id,workspace_id,channel_id,thread_id,user_id,request_hash,text,document,asset_ids,asset_descriptions,send_at)
        VALUES(${request.id},${channel.workspace_id},${channel.id},${message.thread_id},${actor},${hash},${message.text},
          ${message.document ? JSON.stringify(message.document) : null}::jsonb,${uuids(assets)},
          ${message.asset_descriptions ? JSON.stringify(message.asset_descriptions) : null}::jsonb,${request.send_at}::timestamptz)`);
      return dto((await this.one(c, request.id))!);
    });
  }

  async list(actor: string, workspace: string): Promise<{ items: ScheduledMessage[] }> {
    return this.db.transaction(async c => {
      await requireWorkspaceAccess(c, actor, uuid(workspace));
      const rows = (await c.execute(sql`${sql.raw(select)} WHERE sm.workspace_id=${uuid(workspace)} AND sm.user_id=${actor}
        AND sm.status IN ('pending','sending','failed') ORDER BY sm.send_at, sm.id LIMIT ${MAX_PENDING_SCHEDULED * 2}`)).rows as Row[];
      return { items: rows.map(dto) };
    }, { accessMode: 'read only' });
  }

  async reschedule(actor: string, id: string, input: unknown): Promise<ScheduledMessage> {
    const { send_at } = parseScheduledMessageUpdate(input);
    return this.move(actor, id, send_at);
  }

  // Sending now reuses the deadline path: an immediate send_at publishes the due event without delay.
  async sendNow(actor: string, id: string): Promise<ScheduledMessage> { return this.move(actor, id, null); }

  private async move(actor: string, id: string, sendAt: string | null): Promise<ScheduledMessage> {
    return sessionTransaction(this.db, async c => {
      const at = sendAt ? sql`${sendAt}::timestamptz` : sql`clock_timestamp()`;
      // A failed schedule can be retried by moving it; that also clears its error.
      const moved = await c.execute(sql`UPDATE scheduled_messages SET send_at=${at}, status='pending', error=NULL
        WHERE id=${uuid(id)} AND user_id=${actor} AND status IN ('pending','failed') RETURNING asset_ids, send_at`);
      const row = moved.rows[0] as { asset_ids: string[]; send_at: Date } | undefined;
      if (!row) throw await this.missing(c, actor, id);
      if (row.asset_ids.length) await c.execute(sql`UPDATE assets SET expires_at=greatest(expires_at, ${new Date(row.send_at).toISOString()}::timestamptz + ${sql.raw(ASSET_GRACE)})
        WHERE id = ANY(${uuids(row.asset_ids)}) AND message_id IS NULL`);
      return dto((await this.one(c, id))!);
    });
  }

  async cancel(actor: string, id: string): Promise<ScheduledMessage> {
    return sessionTransaction(this.db, async c => {
      const cancelled = await c.execute(sql`UPDATE scheduled_messages SET status='cancelled'
        WHERE id=${uuid(id)} AND user_id=${actor} AND status IN ('pending','failed') RETURNING asset_ids`);
      const row = cancelled.rows[0] as { asset_ids: string[] } | undefined;
      if (!row) throw await this.missing(c, actor, id);
      if (row.asset_ids.length) await c.execute(sql`UPDATE assets SET expires_at=least(expires_at, clock_timestamp() + ${sql.raw(ASSET_GRACE)})
        WHERE id = ANY(${uuids(row.asset_ids)}) AND message_id IS NULL`);
      return dto((await this.one(c, id))!);
    });
  }

  private async missing(c: DbSession, actor: string, id: string) {
    const row = (await c.execute(sql`SELECT status FROM scheduled_messages WHERE id=${uuid(id)} AND user_id=${actor}`)).rows[0] as { status: string } | undefined;
    return row ? new AppError(409, `scheduled_message_${row.status}`) : notFound();
  }

  /**
   * Handles one deadline event. Returns the milliseconds to wait when the event arrived early, otherwise 0.
   * The pending→sending write is conditional on the event's version, so stale or duplicate events do nothing.
   * The send itself is idempotent on (author, client_message_id = schedule id), so a crash between steps repeats safely.
   */
  async deliver(id: string, version: number): Promise<number> {
    const claimed = (await this.pool.query<{ user_id: string; channel_id: string; thread_id: string | null; text: string; document: unknown; asset_ids: string[]; asset_descriptions: Record<string, string> | null }>(
      `UPDATE scheduled_messages SET status='sending' WHERE id=$1 AND version=$2 AND status IN ('pending','sending') AND send_at<=now()
       RETURNING user_id, channel_id, thread_id, text, document, asset_ids, asset_descriptions`, [uuid(id), version])).rows[0];
    if (!claimed) {
      const early = (await this.pool.query<{ remaining: number }>(`SELECT greatest(0, extract(epoch FROM (send_at-now()))*1000)::float AS remaining
        FROM scheduled_messages WHERE id=$1 AND version=$2 AND status='pending'`, [uuid(id), version])).rows[0];
      return early?.remaining ? Math.ceil(early.remaining) : 0;
    }
    try {
      const sent = await this.chat.send(claimed.user_id, claimed.channel_id, {
        client_message_id: id, text: claimed.text, ...(claimed.thread_id ? { thread_id: claimed.thread_id } : {}),
        ...(claimed.document ? { document: claimed.document } : {}), ...(claimed.asset_ids.length ? { asset_ids: claimed.asset_ids } : {}),
        ...(claimed.asset_descriptions ? { asset_descriptions: claimed.asset_descriptions } : {}),
        // Broadcast mentions were authorized when scheduling; the capability is re-checked by send.
        broadcast_confirmed: true,
      });
      await this.pool.query(`UPDATE scheduled_messages SET status='sent', message_id=$2, error=NULL WHERE id=$1 AND status='sending'`, [uuid(id), sent.id]);
    } catch (error) {
      const code = error instanceof AppError ? error.message : '';
      if (!(error instanceof AppError) || !PERMANENT.has(code)) throw error;
      await this.pool.query(`UPDATE scheduled_messages SET status='failed', error=$2 WHERE id=$1 AND status='sending'`, [uuid(id), code]);
    }
    return 0;
  }
}
