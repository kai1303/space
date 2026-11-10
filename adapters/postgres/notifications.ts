import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { AppError, chatCursor, record, uuid, type MentionReference, type NotificationActivity, type NotificationItem, type NotificationSettings } from '@space/contracts';
import { database, type DbSession } from './database.js';
import { hasThreadAccess, requireWorkspaceAccess } from './access.js';
import { sessionTransaction } from './session-concurrency.js';

type Channel = { id: string; workspace_id: string; kind: 'channel' | 'direct' };
async function rows<T>(c: DbSession, query: Parameters<DbSession['execute']>[0]): Promise<T[]> { return (await c.execute(query)).rows as T[]; }
const missing = () => new AppError(404, 'not_found');
const defaults: NotificationSettings = { mode: 'mentions', desktop_enabled: false, sound_enabled: false, preview_enabled: false, thread_replies: true, paused_until: null };
function booleanInput(input: unknown, key: string) {
  const value = record(input, [key])[key];
  if (typeof value !== 'boolean') throw new AppError(400, 'invalid_boolean');
  return value;
}
// Public mentions remain visible to full workspace members; other activity requires channel membership.
const scope = (actor: string, workspace: string) => sql`n.user_id=${actor} AND n.workspace_id=${workspace}
  AND EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=n.workspace_id AND wm.user_id=n.user_id AND wm.active
    AND (EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id=n.channel_id AND cm.user_id=n.user_id)
      OR (n.kind='mention' AND wm.guest_type='none' AND EXISTS(SELECT 1 FROM channels visible WHERE visible.id=n.channel_id AND visible.kind='channel' AND NOT visible.private))))`;
const selection = sql`n.id::text,n.kind,n.channel_id,
  CASE WHEN ch.kind='direct' THEN (SELECT u.display_name FROM users u WHERE u.id=CASE WHEN ch.direct_user_low=n.user_id THEN ch.direct_user_high ELSE ch.direct_user_low END) ELSE ch.name END AS channel_name,
  ch.kind AS channel_kind,n.message_id,m.thread_id,CASE WHEN n.kind='reaction' THEN u.display_name ELSE coalesce(m.workflow_name,u.display_name) END AS author_name,left(m.text,500) AS text,n.emoji,n.created_at,n.read_at,n.silent`;
const sources = sql`notifications n JOIN channels ch ON ch.id=n.channel_id
  JOIN messages m ON m.channel_id=n.channel_id AND m.id=n.message_id JOIN users u ON u.id=n.actor_id`;

export class NotificationStore {
  readonly db;
  constructor(pool: Pool) { this.db = database(pool); }

  async notify(c: DbSession, actor: string, channel: Channel, message: string, thread: string, refs: MentionReference[], reply: boolean) {
    const followers = [actor, ...refs.filter(ref => ref.kind === 'user').map(ref => ref.id)];
    await c.execute(sql`INSERT INTO notification_subscriptions(thread_id,user_id)
      SELECT ${thread},wm.user_id FROM workspace_members wm JOIN channel_members cm ON cm.workspace_id=wm.workspace_id AND cm.user_id=wm.user_id AND cm.channel_id=${channel.id}
      WHERE wm.workspace_id=${channel.workspace_id} AND wm.active AND wm.user_id=ANY(${sql.param(followers)}::uuid[])
      ON CONFLICT DO NOTHING`);
    await c.execute(sql`INSERT INTO notifications(workspace_id,channel_id,message_id,user_id,actor_id,kind,silent)
      SELECT ${channel.workspace_id},${channel.id},${message},recipient.user_id,${actor},recipient.kind,
        NOT recipient.joined OR coalesce(p.paused_until>now(),false) OR coalesce(p.mode,'mentions')='none' OR (recipient.kind='thread_reply' AND NOT coalesce(p.thread_replies,true))
      FROM (
        SELECT wm.user_id,CASE WHEN mn.id IS NOT NULL THEN 'mention' WHEN ${channel.kind === 'direct'} THEN 'direct_message'
          WHEN ${reply} AND ns.following THEN 'thread_reply' ELSE 'channel_message' END AS kind,cm.user_id IS NOT NULL AS joined
        FROM workspace_members wm LEFT JOIN channel_members cm ON cm.workspace_id=wm.workspace_id AND cm.user_id=wm.user_id AND cm.channel_id=${channel.id}
        LEFT JOIN mention_notifications mn ON mn.message_id=${message} AND mn.user_id=wm.user_id
        LEFT JOIN notification_subscriptions ns ON ns.thread_id=${thread} AND ns.user_id=wm.user_id
        LEFT JOIN mention_preferences p ON p.user_id=wm.user_id
        WHERE wm.workspace_id=${channel.workspace_id} AND wm.active AND wm.user_id<>${actor}
          AND (mn.id IS NOT NULL OR (cm.user_id IS NOT NULL AND (${channel.kind === 'direct'} OR (${reply} AND ns.following) OR (NOT ${reply} AND p.mode='all'))))
      ) recipient LEFT JOIN mention_preferences p ON p.user_id=recipient.user_id
      ORDER BY recipient.user_id ON CONFLICT DO NOTHING`);
  }

  async reaction(c: DbSession, actor: string, channel: Channel, message: string, emoji: string) {
    await c.execute(sql`INSERT INTO notifications(workspace_id,channel_id,message_id,user_id,actor_id,kind,emoji,silent)
      SELECT ${channel.workspace_id},${channel.id},m.id,m.user_id,${actor},'reaction',${emoji},coalesce(p.paused_until>now(),false) OR coalesce(p.mode,'mentions')='none'
      FROM messages m JOIN workspace_members wm ON wm.workspace_id=m.workspace_id AND wm.user_id=m.user_id AND wm.active
      JOIN channel_members cm ON cm.channel_id=m.channel_id AND cm.user_id=m.user_id
      LEFT JOIN mention_preferences p ON p.user_id=m.user_id
      WHERE m.channel_id=${channel.id} AND m.id=${message} AND m.author_type='human' AND m.user_id<>${actor}
      ON CONFLICT DO NOTHING`);
  }

  async activity(actor: string, workspace: string, input: unknown = {}): Promise<NotificationActivity> {
    const v = record(input, ['before', 'kind', 'unread']);
    const before = v.before === undefined ? null : chatCursor(v.before);
    if (v.kind !== undefined && (typeof v.kind !== 'string' || !['mention', 'direct_message', 'thread_reply', 'reaction', 'channel_message'].includes(v.kind))) throw new AppError(400, 'invalid_kind');
    if (v.unread !== undefined && v.unread !== 'true' && v.unread !== 'false') throw new AppError(400, 'invalid_unread');
    return this.db.transaction(async c => {
      await requireWorkspaceAccess(c, actor, uuid(workspace));
      const filter = v.kind === 'direct_message' ? sql`ch.kind='direct' AND n.kind<>'reaction'` : v.kind === undefined ? sql`true` : sql`n.kind=${v.kind}`;
      const items = await rows<NotificationItem>(c, sql`SELECT ${selection} FROM ${sources}
        WHERE ${scope(actor, workspace)} AND (${before}::bigint IS NULL OR n.id<${before}::bigint) AND (${filter}) AND (${v.unread === 'true'}=false OR n.read_at IS NULL)
        ORDER BY n.id DESC LIMIT 51`);
      const [totals] = await rows<Pick<NotificationActivity, 'unread_count' | 'latest_id' | 'sound_enabled'>>(c, sql`SELECT count(*) FILTER(WHERE n.read_at IS NULL)::int AS unread_count,coalesce(max(n.id),0)::text AS latest_id,
        coalesce((SELECT sound_enabled FROM mention_preferences WHERE user_id=${actor}),false) AS sound_enabled
        FROM notifications n WHERE ${scope(actor, workspace)}`);
      return { items: items.slice(0, 50), ...totals!, next_cursor: items.length > 50 ? items[49]!.id : null };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  async markRead(actor: string, workspace: string, id: string, input: unknown) {
    const read = booleanInput(input, 'read'); id = chatCursor(id);
    return sessionTransaction(this.db, async c => {
      await requireWorkspaceAccess(c, actor, uuid(workspace));
      const result = await c.execute(sql`UPDATE notifications n SET read_at=CASE WHEN ${read} THEN coalesce(read_at,now()) ELSE NULL END
        WHERE n.id=${id}::bigint AND ${scope(actor, workspace)} RETURNING n.id`);
      if (!result.rows.length) throw missing();
      return { read };
    });
  }

  async markAllRead(actor: string, workspace: string, input: unknown) {
    const value = record(input, ['through']).through;
    if (typeof value !== 'string') throw new AppError(400, 'invalid_cursor');
    const through = chatCursor(value);
    return sessionTransaction(this.db, async c => {
      await requireWorkspaceAccess(c, actor, uuid(workspace));
      await c.execute(sql`UPDATE notifications n SET read_at=now() WHERE n.id<=${through}::bigint AND n.read_at IS NULL AND ${scope(actor, workspace)}`);
      return { read: true };
    });
  }

  private async preferences(c: DbSession, actor: string): Promise<NotificationSettings> {
    return (await rows<NotificationSettings>(c, sql`SELECT mode,desktop_enabled,sound_enabled,preview_enabled,thread_replies,paused_until FROM mention_preferences WHERE user_id=${actor}`))[0] ?? { ...defaults };
  }
  async settings(actor: string, workspace: string): Promise<NotificationSettings> {
    return this.db.transaction(async c => {
      await requireWorkspaceAccess(c, actor, uuid(workspace));
      return this.preferences(c, actor);
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
  async updateSettings(actor: string, workspace: string, input: unknown) {
    const v = record(input, ['mode', 'desktop_enabled', 'sound_enabled', 'preview_enabled', 'thread_replies', 'paused_until']);
    if (!Object.keys(v).length) throw new AppError(400, 'empty_update');
    if ('mode' in v && (typeof v.mode !== 'string' || !['mentions', 'all', 'none'].includes(v.mode))) throw new AppError(400, 'invalid_mode');
    for (const key of ['desktop_enabled', 'sound_enabled', 'preview_enabled', 'thread_replies']) if (key in v && typeof v[key] !== 'boolean') throw new AppError(400, 'invalid_boolean');
    if ('paused_until' in v && v.paused_until !== null && (typeof v.paused_until !== 'string' || !Number.isFinite(Date.parse(v.paused_until)) || Date.parse(v.paused_until) <= Date.now() || Date.parse(v.paused_until) > Date.now() + 7 * 86400000)) throw new AppError(400, 'invalid_pause');
    return sessionTransaction(this.db, async c => {
      await requireWorkspaceAccess(c, actor, uuid(workspace));
      const next = { ...await this.preferences(c, actor), ...v } as NotificationSettings;
      await c.execute(sql`INSERT INTO mention_preferences(user_id,mode,desktop_enabled,sound_enabled,preview_enabled,thread_replies,paused_until)
        VALUES(${actor},${next.mode},${next.desktop_enabled},${next.sound_enabled},${next.preview_enabled},${next.thread_replies},${next.paused_until}::timestamptz)
        ON CONFLICT(user_id) DO UPDATE SET mode=EXCLUDED.mode,desktop_enabled=EXCLUDED.desktop_enabled,sound_enabled=EXCLUDED.sound_enabled,preview_enabled=EXCLUDED.preview_enabled,thread_replies=EXCLUDED.thread_replies,paused_until=EXCLUDED.paused_until`);
      return this.preferences(c, actor);
    });
  }

  async claim(actor: string, workspace: string, id: string, input: unknown): Promise<{ deliver: boolean; notification?: NotificationItem; preview_enabled?: boolean }> {
    const { channel = 'desktop' } = record(input, ['channel']);
    if (channel !== 'desktop' && channel !== 'sound') throw new AppError(400, 'invalid_channel');
    const claimedAt = channel === 'sound' ? sql`sound_claimed_at` : sql`claimed_at`;
    const enabled = channel === 'sound' ? sql`p.sound_enabled` : sql`p.desktop_enabled`;
    id = chatCursor(id);
    return sessionTransaction(this.db, async c => {
      await requireWorkspaceAccess(c, actor, uuid(workspace));
      const result = await c.execute(sql`UPDATE notifications n SET ${claimedAt}=now() FROM mention_preferences p
        WHERE n.id=${id}::bigint AND ${scope(actor, workspace)} AND p.user_id=n.user_id
          AND EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id=n.channel_id AND cm.user_id=n.user_id)
          AND ${claimedAt} IS NULL AND n.read_at IS NULL AND NOT n.silent AND n.created_at>=now()-interval '2 minutes'
          AND ${enabled} AND p.mode<>'none' AND (p.paused_until IS NULL OR p.paused_until<=now())
          AND (n.kind<>'thread_reply' OR p.thread_replies) AND (n.kind<>'channel_message' OR p.mode='all')
        RETURNING n.id`);
      if (!result.rows.length) return { deliver: false };
      if (channel === 'sound') return { deliver: true };
      const [notification] = await rows<NotificationItem>(c, sql`SELECT ${selection} FROM ${sources} WHERE n.id=${id}::bigint AND ${scope(actor, workspace)}`);
      return { deliver: true, notification: notification!, preview_enabled: (await this.preferences(c, actor)).preview_enabled };
    });
  }

  async subscription(actor: string, thread: string, input?: unknown) {
    const following = input === undefined ? undefined : booleanInput(input, 'following');
    return sessionTransaction(this.db, async c => {
      if (!await hasThreadAccess(c, actor, uuid(thread))) throw missing();
      if (following !== undefined) await c.execute(sql`INSERT INTO notification_subscriptions(thread_id,user_id,following) VALUES(${thread},${actor},${following})
        ON CONFLICT(thread_id,user_id) DO UPDATE SET following=EXCLUDED.following`);
      return { following: (await rows<{ following: boolean }>(c, sql`SELECT following FROM notification_subscriptions WHERE thread_id=${thread} AND user_id=${actor}`))[0]?.following ?? false };
    });
  }
}
