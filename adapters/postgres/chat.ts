import { DirectMessageStore } from './direct-messages.js';
import { sessionTransaction } from './session-concurrency.js';
import { MentionStore } from './mentions.js';
import { UnreadStore } from './unread.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { and, eq, gt, lt, gte, lte, asc, desc, or, exists, inArray, sql } from 'drizzle-orm';
import { AppError, parseReactionInput, parseMessageInput, parseChannelInput, parseChannelUpdate, parseMessagePage, parsePage, record, uuid, chatCursor, type ChatMessage, type ChatEvent, type ChatHistory, type MessagePage, type ChannelSummary, type ChannelDetails } from '@space/contracts';
import { database, type DbSession } from './database.js';
import { hasChannelAccess, requireWorkspaceAccess, lockWorkspace, hasThreadAccess } from './access.js';
import { page } from './membership.js';
import * as s from './schema.js';
const notFound = () => new AppError(404, 'not_found');

export class ChatStore {
  readonly db; readonly mentions; readonly unread; readonly directMessages;
  constructor(readonly pool: Pool) { this.db = database(pool); this.directMessages = new DirectMessageStore(this.db); this.mentions = new MentionStore(pool); this.unread = new UnreadStore(pool); }
  async channels(actor: string, workspace: string, query: unknown = {}) {
    const { after, limit } = parsePage(query);
    return this.db.transaction(async c => {
      await requireWorkspaceAccess(c, actor, workspace);
      const member = c.select({ user_id: s.channelMembers.user_id }).from(s.channelMembers)
        .where(and(eq(s.channelMembers.channel_id, s.channels.id), eq(s.channelMembers.user_id, actor)));
      const rows = await c.select({ channel: s.channels, joined: sql<boolean>`exists (${member})` })
        .from(s.channels).where(and(eq(s.channels.workspace_id, workspace), eq(s.channels.kind, 'channel'), or(eq(s.channels.private, false), exists(member)), after ? gt(s.channels.id, after) : undefined))
        .orderBy(s.channels.id).limit(limit + 1);
      return page(rows.map(row => channelDto(row.channel, row.joined)), limit, row => row.id);
    });
  }
  async createChannel(actor: string, workspace: string, input: unknown) {
    const request = parseChannelInput(input);
    return this.db.transaction(async c => {
      await lockWorkspace(c, workspace);
      await requireWorkspaceAccess(c, actor, workspace);
      const [channel] = await c.insert(s.channels).values({ id: randomUUID(), workspace_id: workspace, created_by: actor, ...request }).returning();
      await c.insert(s.channelMembers).values({ workspace_id: workspace, channel_id: channel!.id, user_id: actor });
      return channelDto(channel!, true);
    });
  }
  private async lockedChannel(c: DbSession, id: string) {
    const [ref] = await c.select().from(s.channels).where(eq(s.channels.id, uuid(id)));
    if (!ref) throw notFound();
    if (ref.kind === 'direct') return ref;
    await lockWorkspace(c, ref.workspace_id);
    return (await c.select().from(s.channels).where(eq(s.channels.id, id)).for('update'))[0]!;
  }
  private async channelTransaction<T>(id: string, work: (c: DbSession) => Promise<T>): Promise<T> {
    const [channel] = await this.db.select({ kind: s.channels.kind }).from(s.channels).where(eq(s.channels.id, uuid(id)));
    return channel?.kind === 'direct' ? sessionTransaction(this.db, work) : this.db.transaction(work);
  }
  private async authorize(c: DbSession, actor: string, channel: string) {
    const [row] = await c.select().from(s.channels).where(eq(s.channels.id, uuid(channel)));
    if (!row || !await hasChannelAccess(c, actor, row.workspace_id, channel)) throw notFound();
    return row;
  }
  async typingActor(actor: string, channelId: string, threadId?: string | null) {
    return this.db.transaction(async c => {
      const channel = await this.authorize(c, actor, channelId);
      if (threadId && !(await c.select({id:s.threads.id}).from(s.threads).where(and(eq(s.threads.id,uuid(threadId)),eq(s.threads.channel_id,channel.id)))).length) throw notFound();
      const [user] = await c.select({id:s.users.id,name:s.users.display_name}).from(s.users).where(eq(s.users.id,actor));
      if (!user) throw notFound();
      return {user,archived:!!channel.archived_at};
    }, {accessMode:'read only'});
  }
  async details(actor: string, id: string): Promise<ChannelDetails> {
    return this.db.transaction(async c => this.detail(c, actor, await this.authorize(c, actor, id)));
  }
  private async detail(c: DbSession, actor: string, channel: typeof s.channels.$inferSelect): Promise<ChannelDetails> {
    if (channel.kind === 'direct') {
      const direct = await this.directMessages.summary(c, actor, channel.workspace_id, channel.id);
      return { ...direct, creator_name: null, member_count: direct.participants.length, can_manage: false };
    }
    const [membership] = await c.select().from(s.workspaceMembers).where(and(eq(s.workspaceMembers.workspace_id, channel.workspace_id), eq(s.workspaceMembers.user_id, actor), eq(s.workspaceMembers.active, true)));
    const [creator] = channel.created_by ? await c.select({ name: s.users.display_name }).from(s.users).where(eq(s.users.id, channel.created_by)) : [];
    const [count] = await c.select({ total: sql<number>`count(*)::int` }).from(s.channelMembers)
      .innerJoin(s.workspaceMembers, and(eq(s.workspaceMembers.workspace_id, s.channelMembers.workspace_id), eq(s.workspaceMembers.user_id, s.channelMembers.user_id)))
      .where(and(eq(s.channelMembers.channel_id, channel.id), eq(s.workspaceMembers.active, true)));
    return { ...channelDto(channel, true), creator_name: creator?.name ?? null, member_count: count!.total,
      can_manage: channel.created_by === actor || membership?.role === 'owner' || membership?.role === 'admin' };
  }
  async updateChannel(actor: string, id: string, input: unknown): Promise<ChannelDetails> {
    const { archived, ...metadata } = parseChannelUpdate(input);
    return this.db.transaction(async c => {
      const channel = await this.lockedChannel(c, id);
      await this.manager(c, actor, channel);
      if (archived === undefined && channel.archived_at) throw new AppError(409, 'channel_archived');
      if (archived && !channel.archived_at) {
        const active = await c.select({ id: s.tasks.id }).from(s.tasks).innerJoin(s.threads, eq(s.threads.id, s.tasks.thread_id))
          .where(and(eq(s.threads.channel_id, id), inArray(s.tasks.status, ['awaiting_approval', 'queued', 'running']))).limit(1);
        if (active.length) throw new AppError(409, 'channel_has_active_tasks');
      }
      const [updated] = await c.update(s.channels).set({ ...metadata, ...(archived === undefined ? {} : { archived_at: archived ? channel.archived_at ?? new Date() : null }) }).where(eq(s.channels.id, id)).returning();
      return this.detail(c, actor, updated!);
    });
  }
  async members(actor: string, id: string, query: unknown = {}) {
    const { after, limit } = parsePage(query);
    return this.db.transaction(async c => {
      await this.authorize(c, actor, id);
      const rows = await c.select({ id: s.users.id, name: s.users.display_name, image: s.users.image, title: s.users.title, presence: s.users.presence }).from(s.channelMembers)
        .innerJoin(s.users, eq(s.users.id, s.channelMembers.user_id))
        .innerJoin(s.workspaceMembers, and(eq(s.workspaceMembers.workspace_id, s.channelMembers.workspace_id), eq(s.workspaceMembers.user_id, s.channelMembers.user_id)))
        .where(and(eq(s.channelMembers.channel_id, id), eq(s.workspaceMembers.active, true), after ? gt(s.users.id, after) : undefined))
        .orderBy(s.users.id).limit(limit + 1);
      return page(rows, limit, row => row.id);
    });
  }
  async join(actor: string, id: string) {
    return this.db.transaction(async c => {
      const channel = await this.lockedChannel(c, id);
      await requireWorkspaceAccess(c, actor, channel.workspace_id);
      if (channel.kind === 'direct') { await this.authorize(c, actor, id); throw new AppError(403, 'direct_message_immutable'); }
      if (channel.private && !await hasChannelAccess(c, actor, channel.workspace_id, id)) throw notFound();
      await c.insert(s.channelMembers).values({ workspace_id: channel.workspace_id, channel_id: id, user_id: actor }).onConflictDoNothing();
      return { joined: true };
    });
  }
  private async manager(c: DbSession, actor: string, channel: typeof s.channels.$inferSelect) {
    await this.authorize(c, actor, channel.id);
    if (channel.kind === 'direct') throw new AppError(403, 'direct_message_immutable');
    const [membership] = await c.select().from(s.workspaceMembers)
      .where(and(eq(s.workspaceMembers.workspace_id, channel.workspace_id), eq(s.workspaceMembers.user_id, actor)));
    if (channel.created_by !== actor && membership?.role === 'member') throw new AppError(403, 'channel_management_forbidden');
  }
  async addMember(actor: string, id: string, input: unknown) {
    const user = uuid(record(input, ['user_id']).user_id);
    return this.db.transaction(async c => {
      const channel = await this.lockedChannel(c, id);
      await this.manager(c, actor, channel);
      if (channel.archived_at) throw new AppError(409, 'channel_archived');
      await requireWorkspaceAccess(c, user, channel.workspace_id);
      await c.insert(s.channelMembers).values({ workspace_id: channel.workspace_id, channel_id: id, user_id: user }).onConflictDoNothing();
      return { user_id: user, channel_id: id };
    });
  }
  async removeMember(actor: string, id: string, user: string) {
    user = uuid(user);
    await this.db.transaction(async c => {
      const channel = await this.lockedChannel(c, id);
      await this.authorize(c, actor, id);
      if (channel.kind === 'direct') throw new AppError(403, 'direct_message_immutable');
      if (actor !== user) await this.manager(c, actor, channel);
      if (channel.private) {
        const managers = await c.select({ id: s.channelMembers.user_id }).from(s.channelMembers)
          .innerJoin(s.workspaceMembers, and(eq(s.workspaceMembers.workspace_id, s.channelMembers.workspace_id), eq(s.workspaceMembers.user_id, s.channelMembers.user_id)))
          .where(and(eq(s.channelMembers.channel_id, id), eq(s.workspaceMembers.active, true),
            or(inArray(s.workspaceMembers.role, ['owner', 'admin']), channel.created_by ? eq(s.channelMembers.user_id, channel.created_by) : undefined))).limit(2);
        if (managers.length === 1 && managers[0]!.id === user) throw new AppError(409, 'channel_needs_manager');
      }
      await c.delete(s.channelMembers).where(and(eq(s.channelMembers.channel_id, id), eq(s.channelMembers.user_id, user)));
    });
  }
  async send(actor: string, channelId: string, input: unknown): Promise<ChatMessage> {
    const request = parseMessageInput(input);
    const hash = createHash('sha256').update(JSON.stringify({ channel_id: channelId, thread_id: request.thread_id, text: request.text, ...(request.document ? { document: request.document } : {}), ...(request.asset_ids?.length ? { asset_ids: request.asset_ids } : {}) })).digest('hex');
    return this.channelTransaction(channelId, async c => {
      const channel = await this.lockedChannel(c, channelId);
      await this.authorize(c, actor, channelId);
      if (channel.kind !== 'direct') await c.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${channel.workspace_id}:${actor}:${request.client_message_id}`}))`);
      const [existing] = await c.select().from(s.messageIdentities).where(and(eq(s.messageIdentities.workspace_id, channel.workspace_id), eq(s.messageIdentities.user_id, actor), eq(s.messageIdentities.client_message_id, request.client_message_id)));
      if (existing) {
        if (existing.request_hash !== hash) throw new AppError(409, 'idempotency_conflict');
        return this.message(c, existing.id, existing.channel_id);
      }
      if (channel.archived_at) throw new AppError(409, 'channel_archived');
      if (channel.kind === 'direct') {
        const inactive = await c.execute(sql`SELECT 1 FROM workspace_members WHERE workspace_id=${channel.workspace_id}
          AND user_id IN (${channel.direct_user_low},${channel.direct_user_high}) AND NOT active LIMIT 1`);
        if (inactive.rows.length) throw new AppError(409, 'direct_message_participant_inactive');
      }
      const prepared = await this.mentions.prepare(c, actor, channel, request.document, !!request.thread_id, !!request.broadcast_confirmed);
      const threadId = request.thread_id ?? randomUUID();
      if (request.thread_id) {
        if (!(await c.select({ id: s.threads.id }).from(s.threads).where(and(eq(s.threads.id, threadId), eq(s.threads.channel_id, channelId)))).length) throw notFound();
      } else await c.insert(s.threads).values({ id: threadId, workspace_id: channel.workspace_id, channel_id: channelId });
      const id = randomUUID();
      const fileQuery = request.asset_ids?.length ? c.select().from(s.assets).where(inArray(s.assets.id, request.asset_ids)).orderBy(s.assets.id) : null;
      const files = fileQuery ? await (channel.kind === 'direct' ? fileQuery : fileQuery.for('update')) : [];
      if (files.length !== (request.asset_ids?.length ?? 0) || files.some(file => file.channel_id !== channelId || file.uploader_id !== actor || file.status !== 'ready' || file.message_id || file.expires_at <= new Date())) throw new AppError(409, 'asset_unavailable');
      const attachments = (request.asset_ids ?? []).map(id => {
        const file = files.find(file => file.id === id)!;
        return { id: file.id, name: file.name, size: file.size, type: file.type };
      });
      await c.insert(s.messages).values({ id, workspace_id: channel.workspace_id, channel_id: channelId, thread_id: threadId,
        author_type: 'human', user_id: actor, client_message_id: request.client_message_id, request_hash: hash, text: prepared.document ? prepared.document.ops.map(op => op.insert).join('').trim() : request.text, document: prepared.document ?? null, attachments });
      await this.mentions.notify(c, actor, channel, id, prepared.refs, !!request.thread_id);
      if (files.length) await c.update(s.assets).set({ message_id: id }).where(inArray(s.assets.id, files.map(file => file.id)));
      if (channel.kind === 'direct') await c.execute(sql`UPDATE direct_message_views SET hidden=false,last_activity_at=now() WHERE channel_id=${channelId}`);
      return this.message(c, id, channelId);
    });
  }
  async react(actor: string, channelId: string, messageId: string, input: unknown): Promise<ChatMessage> {
    const { emoji, active } = parseReactionInput(input);
    messageId = uuid(messageId);
    return this.channelTransaction(channelId, async c => {
      const channel = await this.lockedChannel(c, channelId);
      await this.authorize(c, actor, channelId);
      const [message] = await c.select().from(s.messages).where(and(eq(s.messages.channel_id, channelId), eq(s.messages.id, messageId)));
      if (!message) throw notFound();
      if (channel.archived_at) throw new AppError(409, 'channel_archived');
      const changed = active
        ? await c.execute(sql`INSERT INTO message_reactions(channel_id,message_id,user_id,emoji) VALUES(${channelId},${messageId},${actor},${emoji}) ON CONFLICT DO NOTHING RETURNING emoji`)
        : await c.execute(sql`DELETE FROM message_reactions WHERE channel_id=${channelId} AND message_id=${messageId} AND user_id=${actor} AND emoji=${emoji} RETURNING emoji`);
      if (changed.rows.length) {
        await c.execute(sql`UPDATE messages SET reaction_sequence=${channel.event_sequence + 1n} WHERE channel_id=${channelId} AND id=${messageId}`);
        await c.execute(sql`SELECT append_chat_event(${channelId},${message.thread_id},'message.updated',chat_message_payload(messages)) FROM messages WHERE channel_id=${channelId} AND id=${messageId}`);
      }
      return this.message(c, messageId, channelId);
    });
  }
  private async message(c: DbSession, id: string, channel: string): Promise<ChatMessage> {
    const result = await c.execute<{ message: ChatMessage }>(sql`SELECT chat_message_payload(messages) AS message FROM messages WHERE channel_id=${channel} AND id=${id}`);
    return result.rows[0]!.message;
  }
  async threadMessages(actor: string, thread: string, query: unknown = {}): Promise<ChatMessage[]> {
    const v = record(query, ['before']);
    const before = v.before === undefined ? undefined : uuid(v.before);
    return this.db.transaction(async c => {
      if (!await hasThreadAccess(c, actor, uuid(thread))) throw notFound();
      const [ref] = await c.select({ channel_id: s.threads.channel_id }).from(s.threads).where(eq(s.threads.id, thread));
      const boundary = before ? (await c.select({ sequence: s.channelEvents.sequence }).from(s.channelEvents)
        .where(and(eq(s.channelEvents.channel_id, ref!.channel_id), eq(s.channelEvents.thread_id, thread), eq(s.channelEvents.type, 'message.created'), sql`${s.channelEvents.payload}->>'id'=${before}`)))[0] : undefined;
      if (before && !boundary) throw notFound();
      const rows = await c.select({ payload: s.channelEvents.payload }).from(s.channelEvents)
        .where(and(eq(s.channelEvents.channel_id, ref!.channel_id), eq(s.channelEvents.thread_id, thread), eq(s.channelEvents.type, 'message.created'), boundary ? lt(s.channelEvents.sequence, boundary.sequence) : undefined))
        .orderBy(desc(s.channelEvents.sequence)).limit(200);
      return rows.reverse().map(row => row.payload as ChatMessage);
    });
  }
  async messageHistory(actor: string, channel: string, query: unknown = {}): Promise<MessagePage> {
    const paging = parseMessagePage(query);
    return this.db.transaction(async c => {
      const visible = await this.authorize(c, actor, channel);
      return this.messagePage(c, visible, paging);
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
  async threadHistory(actor: string, thread: string, query: unknown = {}): Promise<MessagePage> {
    const paging = parseMessagePage(query);
    return this.db.transaction(async c => {
      const [ref] = await c.select().from(s.threads).where(eq(s.threads.id, uuid(thread)));
      if (!ref) throw notFound();
      const visible = await this.authorize(c, actor, ref.channel_id);
      return this.messagePage(c, visible, paging, thread);
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
  private async messagePage(c: DbSession, channel: typeof s.channels.$inferSelect, paging: ReturnType<typeof parseMessagePage>, thread?: string): Promise<MessagePage> {
    const { before, after, limit } = paging;
    const scope = and(eq(s.messages.workspace_id, channel.workspace_id), eq(s.messages.channel_id, channel.id), thread ? eq(s.messages.thread_id, thread) : sql`NOT EXISTS (
      SELECT 1 FROM messages earlier WHERE earlier.workspace_id=${s.messages.workspace_id} AND earlier.channel_id=${s.messages.channel_id}
        AND earlier.thread_id=${s.messages.thread_id} AND earlier.sequence<${s.messages.sequence}
    )`);
    const rows = await c.select({ sequence: s.messages.sequence, message: sql<ChatMessage>`chat_message_payload(messages)` }).from(s.messages)
      .where(and(scope, before === undefined ? undefined : lt(s.messages.sequence, BigInt(before)), after === undefined ? undefined : gt(s.messages.sequence, BigInt(after))))
      .orderBy(after === undefined ? desc(s.messages.sequence) : asc(s.messages.sequence)).limit(limit);
    if (after === undefined) rows.reverse();
    const first = rows[0]?.sequence, last = rows.at(-1)?.sequence;
    const older = first === undefined ? after === undefined ? sql`false` : lte(s.messages.sequence, BigInt(after)) : lt(s.messages.sequence, first);
    const newer = last === undefined ? before === undefined ? sql`false` : gte(s.messages.sequence, BigInt(before)) : gt(s.messages.sequence, last);
    const bounds = await c.execute<{ has_older: boolean; has_newer: boolean }>(sql`SELECT
      EXISTS(SELECT 1 FROM ${s.messages} WHERE ${scope} AND ${older}) AS has_older,
      EXISTS(SELECT 1 FROM ${s.messages} WHERE ${scope} AND ${newer}) AS has_newer`);
    // This counter and the rows share a snapshot, so socket replay cannot skip a racing insert.
    return { messages: rows.map(row => row.message), older_cursor: first?.toString() ?? null, newer_cursor: last?.toString() ?? null,
      has_older: bounds.rows[0]!.has_older, has_newer: bounds.rows[0]!.has_newer, event_cursor: channel.event_sequence.toString() };
  }
  async history(actor: string, channel: string, query: unknown = {}): Promise<ChatHistory> {
    const v = record(query, ['before']);
    const before = v.before === undefined ? undefined : BigInt(chatCursor(v.before));
    return this.db.transaction(async c => {
      await this.authorize(c, actor, channel);
      const rows = await c.select().from(s.channelEvents).where(and(eq(s.channelEvents.channel_id, channel), before === undefined ? undefined : lt(s.channelEvents.sequence, before)))
        .orderBy(desc(s.channelEvents.sequence)).limit(101);
      const events = rows.slice(0, 100).reverse().map(eventDto);
      return { events, cursor: events.at(-1)?.sequence ?? '0', oldest_cursor: events[0]?.sequence ?? '0', has_more: rows.length > 100 };
    });
  }
  async events(actor: string, channel: string, after: string): Promise<ChatEvent[]> {
    const cursor = BigInt(chatCursor(after));
    return this.db.transaction(async c => {
      const visible = await this.authorize(c, actor, channel);
      if (cursor > visible.event_sequence) throw new AppError(400, 'invalid_cursor');
      return (await c.select().from(s.channelEvents).where(and(eq(s.channelEvents.channel_id, channel), gt(s.channelEvents.sequence, cursor)))
        .orderBy(s.channelEvents.sequence).limit(100)).map(eventDto);
    });
  }
}
function channelDto(channel: typeof s.channels.$inferSelect, joined: boolean): ChannelSummary {
  return { kind: channel.kind, id: channel.id, workspace_id: channel.workspace_id, name: channel.name, private: channel.private, joined,
    topic: channel.topic, description: channel.description, archived_at: channel.archived_at?.toISOString() ?? null,
    created_by: channel.created_by, created_at: channel.created_at.toISOString() };
}
function eventDto(row: typeof s.channelEvents.$inferSelect): ChatEvent {
  return { channel_id: row.channel_id, thread_id: row.thread_id, sequence: row.sequence.toString(), type: row.type, payload: row.payload, occurred_at: row.occurred_at.toISOString() } as ChatEvent;
}
