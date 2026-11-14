import {DmEncryptionStore,dmDevices} from './dm-encryption.js';
import {encryptedMessageLabel,parseEncryptedDm,parseRichDocument} from '@space/contracts';
import { ChannelWebhooks } from './channel-webhooks.js';
import {ChannelPermissionStore,readChannelPermissions,requireChannelCapability,requireRemainingChannelManager} from './channel-permissions.js';
import { requireWorkspacePolicy } from './workspace-settings.js';
import { NotificationStore } from './notifications.js';
import { DirectMessageStore } from './direct-messages.js';
import { syncSavedMemory } from './memory-sources.js';
import { eraseMessageReferences } from './workspace-retention.js';
import { retrySessionConflict, SessionConflict, sessionTransaction } from './session-concurrency.js';
import { MentionStore } from './mentions.js';
import { UnreadStore } from './unread.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { and, eq, gt, lt, gte, lte, asc, desc, or, exists, inArray, isNull, sql } from 'drizzle-orm';
import { AppError, parseReactionInput, parseMessageInput, parseChannelInput, parseChannelUpdate, parseMessagePage, parsePage, record, uuid, chatCursor, type ChatMessage, type ChatEvent, type ChatHistory, type MessagePage, type ChannelNotificationPreferences, type ChannelSummary, type ChannelDetails, type ChannelPin, type ChannelTabsState, type ChannelLinkMessage } from '@space/contracts';
import { database, type DbSession } from './database.js';
import { requireWorkspaceAccess, hasThreadAccess } from './access.js';
import { page } from './membership.js';
import * as s from './schema.js';
const notFound = () => new AppError(404, 'not_found');

function parseOutgoingMessage(input: unknown) {
  const wire=input && typeof input==='object' && 'encrypted' in input ? record(input,['client_message_id','encrypted']) : undefined;
  const encrypted=wire ? parseEncryptedDm(wire.encrypted) : undefined;
  const request=parseMessageInput(wire ? {client_message_id:wire.client_message_id,text:encryptedMessageLabel,...(encrypted?.asset_ids?.length ? {asset_ids:encrypted.asset_ids} : {})} : input);
  return { request, encrypted };
}

export class ChatStore {
  readonly db; readonly webhooks; readonly permissions; readonly notifications; readonly mentions; readonly unread; readonly directMessages; readonly encryption;
  constructor(readonly pool: Pool) { this.db = database(pool); this.webhooks = new ChannelWebhooks(this.db); this.permissions = new ChannelPermissionStore(this.db); this.notifications = new NotificationStore(pool); this.directMessages = new DirectMessageStore(this.db); this.encryption=new DmEncryptionStore(this.db); this.mentions = new MentionStore(pool); this.unread = new UnreadStore(pool); }
  // Admit overlapping message writes in arrival order before opening their snapshots.
  // PostgreSQL remains authoritative for other processes and database writers.
  private readonly pendingWrites = new Map<string, { tail: Promise<void>; count: number }>();
  private writes = 0;
  private async channelWrite<T>(channelId: string, work: () => Promise<T>): Promise<T> {
    const key = uuid(channelId).toLowerCase();
    let queue = this.pendingWrites.get(key);
    if (this.writes >= 1024 || (queue?.count ?? 0) >= 32) throw new AppError(503, 'channel_write_busy');
    if (!queue) {
      queue = { tail: Promise.resolve(), count: 0 };
      this.pendingWrites.set(key, queue);
    }
    const previous = queue.tail;
    let release!: () => void;
    queue.tail = new Promise<void>(resolve => { release = resolve; });
    queue.count++;
    this.writes++;
    try {
      await previous;
      return await work();
    } finally {
      this.writes--;
      if (--queue.count === 0) this.pendingWrites.delete(key);
      release();
    }
  }
  async channels(actor: string, workspace: string, query: unknown = {}, channelIds?: string[]) {
    const filters = record(query,['after','limit','directory','q','membership','type','sort']);
    const { after, limit } = parsePage({after:filters.after,limit:filters.limit});
    const directory = filters.directory === '1';
    const q = filters.q ?? '', membership = filters.membership ?? 'all', type = filters.type ?? 'all', sort = filters.sort ?? 'id';
    if(typeof q!=='string' || q.length>100 || !['all','joined','other'].includes(String(membership))
      || !['all','public','private','archived'].includes(String(type)) || !['id','name','name_desc'].includes(String(sort)))
      throw new AppError(400,'invalid_directory_filter');
    return this.db.transaction(async c => {
      await requireWorkspaceAccess(c, actor, workspace);
      const member = c.select({ user_id: s.channelMembers.user_id }).from(s.channelMembers)
        .where(and(eq(s.channelMembers.channel_id, s.channels.id), eq(s.channelMembers.user_id, actor)));
      const nameOrder=sql`lower(${s.channels.name})`;
      const visible=or(and(eq(s.channels.private,false),sql`EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=${workspace} AND wm.user_id=${actor} AND wm.guest_type='none')`),exists(member));
      let boundary=after?gt(s.channels.id,after):undefined;
      if(after && sort!=='id'){
        const [anchor]=await c.select({name:nameOrder}).from(s.channels).where(and(eq(s.channels.workspace_id,workspace),eq(s.channels.kind,'channel'),eq(s.channels.id,after),visible));
        if(!anchor)throw new AppError(400,'invalid_cursor');
        boundary=sql`(${nameOrder},${s.channels.id}) ${sort==='name_desc'?sql`<`:sql`>`} (${anchor.name},${after}::uuid)`;
      }
      const rows = await c.select({ channel: s.channels, ...(directory ? {member_count:sql<number>`(SELECT count(*)::int FROM channel_members cm WHERE cm.channel_id=${s.channels.id})`} : {}), joined: sql<boolean>`exists (${member})`,
        active_huddle: sql<boolean>`exists(select 1 from channel_huddles h
          join channel_members hm on hm.channel_id=h.channel_id and hm.user_id=${actor}
          where h.channel_id=channels.id and h.state='active')`,
        preferences: sql<ChannelNotificationPreferences | null>`(SELECT jsonb_build_object(
          'mode',cm.notification_mode,'effective_mode',coalesce(cm.notification_mode,p.mode,'mentions'),
          'muted_until',cm.muted_until,'thread_replies',cm.notify_thread_replies,
          'desktop_enabled',coalesce(cm.channel_desktop_enabled,p.desktop_enabled,false),
          'badge_every_post',cm.badge_every_post,'follow_every_thread',cm.follow_every_thread)
          FROM channel_members cm LEFT JOIN mention_preferences p ON p.user_id=cm.user_id
          WHERE cm.channel_id=${s.channels.id} AND cm.user_id=${actor})` })
        .from(s.channels).where(and(eq(s.channels.workspace_id, workspace), eq(s.channels.kind, 'channel'), channelIds && inArray(s.channels.id, channelIds), visible,boundary,
          q ? sql`strpos(lower(concat_ws(' ',${s.channels.name},${s.channels.topic},${s.channels.description})),lower(${q}))>0` : undefined,
          membership==='joined'?exists(member):membership==='other'?sql`NOT EXISTS (${member})`:undefined,
          type==='archived'?sql`${s.channels.archived_at} IS NOT NULL`:type==='all'?undefined:eq(s.channels.private,type==='private')))
        .orderBy(...(sort==='id'?[s.channels.id]:sort==='name_desc'?[desc(nameOrder),desc(s.channels.id)]:[nameOrder,s.channels.id])).limit(limit + 1);
      return page(rows.map(row => ({...channelDto(row.channel, row.joined), ...(directory && {member_count:row.member_count}), ...(row.active_huddle && {active_huddle:true}), ...(row.preferences && {notification_preferences:row.preferences})})), limit, row => row.id);
    });
  }
  async createChannel(actor: string, workspace: string, input: unknown) {
    const request = parseChannelInput(input);
    return sessionTransaction(this.db, async c => {
      await requireWorkspacePolicy(c, actor, workspace, 'create_channel', 'guest_action_forbidden');
      const [channel] = await c.insert(s.channels).values({ id: randomUUID(), workspace_id: workspace, created_by: actor, ...request }).returning();
      await c.insert(s.channelMembers).values({ workspace_id: workspace, channel_id: channel!.id, user_id: actor });
      return channelDto(channel!, true);
    });
  }
  private async authorize(c: DbSession, actor: string, channel: string) {
    const [row] = await c.select({ channel: s.channels }).from(s.channels)
      .innerJoin(s.channelMembers, and(eq(s.channelMembers.channel_id, s.channels.id),
        eq(s.channelMembers.workspace_id, s.channels.workspace_id), eq(s.channelMembers.user_id, uuid(actor))))
      .innerJoin(s.workspaceMembers, and(eq(s.workspaceMembers.workspace_id, s.channels.workspace_id),
        eq(s.workspaceMembers.user_id, s.channelMembers.user_id), eq(s.workspaceMembers.active, true)))
      .where(eq(s.channels.id, uuid(channel)));
    if (!row) throw notFound();
    return row.channel;
  }
  async typingActor(actor: string, channelId: string, threadId?: string | null) {
    return this.db.transaction(async c => {
      const channel = await this.authorize(c, actor, channelId);
      if (threadId && !(await c.select({id:s.threads.id}).from(s.threads).where(and(eq(s.threads.id,uuid(threadId)),eq(s.threads.channel_id,channel.id)))).length) throw notFound();
      const [user] = await c.select({id:s.users.id,name:s.users.display_name}).from(s.users).where(eq(s.users.id,actor));
      if (!user) throw notFound();
      const peer = channel.direct_user_low === actor ? channel.direct_user_high : channel.direct_user_low;
      return {user, archived: !!channel.archived_at,
        sidebarPeer: channel.kind === 'direct' && !threadId && peer && peer !== actor ? peer : undefined,
        workspace: channel.workspace_id};
    }, {accessMode:'read only'});
  }
  async conversationLocation(actor: string, channel: string, thread?: string) {
    const result = await this.db.execute<{workspace_id: string}>(sql`
      SELECT ch.workspace_id FROM channels ch
      JOIN workspace_members wm ON wm.workspace_id = ch.workspace_id AND wm.user_id = ${actor} AND wm.active
      LEFT JOIN channel_members cm ON cm.channel_id = ch.id AND cm.user_id = wm.user_id
      WHERE ch.id = ${channel}
        AND (cm.user_id IS NOT NULL OR (ch.kind = 'channel' AND NOT ch.private AND wm.guest_type = 'none'))
        ${thread ? sql`AND cm.user_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM threads t WHERE t.channel_id = ch.id AND t.id = ${thread}
        )` : sql``}
    `);
    if (!result.rows[0]) throw notFound();
    return { workspace_id: result.rows[0].workspace_id };
  }
  async details(actor: string, id: string): Promise<ChannelDetails> {
    return this.db.transaction(async c => this.detail(c, actor, await this.authorize(c, actor, id)));
  }
  private async detail(c: DbSession, actor: string, channel: typeof s.channels.$inferSelect): Promise<ChannelDetails> {
    if (channel.kind === 'direct') {
      const direct = await this.directMessages.summary(c, actor, channel.workspace_id, channel.id);
      return { ...direct, creator_name: null, member_count: direct.participants.length, can_manage: false };
    }
    const permissions = await readChannelPermissions(c, actor, channel.id);
    const [creator] = channel.created_by ? await c.select({ name: s.users.display_name }).from(s.users).where(eq(s.users.id, channel.created_by)) : [];
    const [count] = await c.select({ total: sql<number>`count(*)::int` }).from(s.channelMembers)
      .innerJoin(s.workspaceMembers, and(eq(s.workspaceMembers.workspace_id, s.channelMembers.workspace_id), eq(s.workspaceMembers.user_id, s.channelMembers.user_id)))
      .where(and(eq(s.channelMembers.channel_id, channel.id), eq(s.workspaceMembers.active, true)));
    return { ...channelDto(channel, true), creator_name: creator?.name ?? null, member_count: count!.total,
      permissions, can_manage: permissions.capabilities.manage };
  }
  async updateChannel(actor: string, id: string, input: unknown): Promise<ChannelDetails> {
    const { archived, ...metadata } = parseChannelUpdate(input);
    return sessionTransaction(this.db, async c => {
      const channel = await this.authorize(c, actor, id);
      if (archived === undefined && channel.archived_at) throw new AppError(409, 'channel_archived');
      await this.manager(c, actor, channel, archived === undefined ? 'edit_details' : 'archive');
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
      const rows = await c.select({ id: s.users.id, name: s.users.display_name, image: s.users.image, title: s.users.title, presence: s.users.presence, guest_type:s.workspaceMembers.guest_type, is_manager:sql<boolean>`EXISTS(SELECT 1 FROM channel_permissions cp WHERE cp.channel_id=${s.channelMembers.channel_id} AND ${s.channelMembers.user_id}=ANY(cp.manager_ids))` }).from(s.channelMembers)
        .innerJoin(s.users, eq(s.users.id, s.channelMembers.user_id))
        .innerJoin(s.workspaceMembers, and(eq(s.workspaceMembers.workspace_id, s.channelMembers.workspace_id), eq(s.workspaceMembers.user_id, s.channelMembers.user_id)))
        .where(and(eq(s.channelMembers.channel_id, id), eq(s.workspaceMembers.active, true), after ? gt(s.users.id, after) : undefined))
        .orderBy(s.users.id).limit(limit + 1);
      return page(rows, limit, row => row.id);
    });
  }
  async join(actor: string, id: string) {
    return sessionTransaction(this.db, async c => {
      const { rows: [channel] } = await c.execute<{workspace_id: string; kind: string; private: boolean; guest_type: string; joined: boolean}>(sql`
        SELECT ch.workspace_id,ch.kind,ch.private,wm.guest_type,cm.user_id IS NOT NULL AS joined
        FROM channels ch JOIN workspace_members wm ON wm.workspace_id=ch.workspace_id AND wm.user_id=${uuid(actor)} AND wm.active
        LEFT JOIN channel_members cm ON cm.workspace_id=ch.workspace_id AND cm.channel_id=ch.id AND cm.user_id=wm.user_id
        WHERE ch.id=${uuid(id)}`);
      if (!channel) throw notFound();
      if (!channel.joined && channel.private) throw notFound();
      if (channel.kind === 'direct') throw new AppError(403, 'direct_message_immutable');
      if (channel.joined) return { joined: true };
      if (channel.guest_type !== 'none') throw new AppError(403, 'guest_action_forbidden');
      await c.insert(s.channelMembers).values({ workspace_id: channel.workspace_id, channel_id: id, user_id: actor }).onConflictDoNothing();
      return { joined: true };
    }, 'serializable', 3);
  }
  private async manager(c: DbSession, actor: string, channel: typeof s.channels.$inferSelect, action: 'invite'|'remove'|'edit_details'|'archive') {
    if (channel.kind === 'direct') throw new AppError(403, 'direct_message_immutable');
    await requireChannelCapability(c, actor, channel.id, action);
  }
  async addMember(actor: string, id: string, input: unknown) {
    const user = uuid(record(input, ['user_id']).user_id);
    return sessionTransaction(this.db, async c => {
      const channel = await this.authorize(c, actor, id);
      if (channel.archived_at) throw new AppError(409, 'channel_archived');
      await this.manager(c, actor, channel, 'invite');
      const [target] = await c.select({guest_type: s.workspaceMembers.guest_type, guest_channel_id: s.workspaceMembers.guest_channel_id})
        .from(s.workspaceMembers).where(and(eq(s.workspaceMembers.workspace_id,channel.workspace_id),eq(s.workspaceMembers.user_id,user),eq(s.workspaceMembers.active,true)));
      if (!target) throw notFound();
      if(target.guest_type !== 'none') {
        const [manager] = await c.select().from(s.workspaceMembers).where(and(eq(s.workspaceMembers.workspace_id,channel.workspace_id),eq(s.workspaceMembers.user_id,actor)));
        if(manager?.role==='member') throw new AppError(403,'member_management_forbidden');
        if(target.guest_type==='single' && target.guest_channel_id && target.guest_channel_id!==id) throw new AppError(409,'guest_channel_limit');
      }
      await c.insert(s.channelMembers).values({ workspace_id: channel.workspace_id, channel_id: id, user_id: user }).onConflictDoNothing();
      return { user_id: user, channel_id: id };
    }, 'serializable', 3);
  }
  async removeMember(actor: string, id: string, user: string) {
    user = uuid(user);
    await sessionTransaction(this.db, async c => {
      const channel = await this.authorize(c, actor, id);
      if (channel.kind === 'direct') throw new AppError(403, 'direct_message_immutable');
      if (actor !== user) await this.manager(c, actor, channel, 'remove');
      if (channel.private) {
        const permissions = await readChannelPermissions(c, actor, id);
        await requireRemainingChannelManager(c, id, permissions.manager_ids, user);
      }
      await c.delete(s.channelMembers).where(and(eq(s.channelMembers.channel_id, id), eq(s.channelMembers.user_id, user)));
    });
  }
  // Only ordinary channel mutations use statement snapshots. DMs and mutations
  // with additional authorization dependencies keep their serializable transaction.
  private channelMutation<T>(channelId: string, simple: boolean, work: (c: DbSession, ordinary: boolean) => Promise<T>) {
    return this.channelWrite(channelId, async () => {
      const [channel] = simple ? await this.db.select({ kind: s.channels.kind }).from(s.channels).where(eq(s.channels.id, uuid(channelId))) : [];
      const ordinary = channel?.kind === 'channel';
      return sessionTransaction(this.db, c => work(c, ordinary), ordinary ? 'read committed' : 'serializable');
    });
  }
  async send(actor: string, channelId: string, input: unknown, newMessageId?: string, workflow?: { name: string; workspace: string }): Promise<ChatMessage> {
    const parsed = parseOutgoingMessage(input);
    const { request, encrypted } = parsed;
    const simple = !encrypted && !workflow && !request.asset_ids?.length && !request.also_send_to_channel
      && !request.document?.ops.some(op => op.attributes?.mention);
    return this.channelMutation(channelId, simple, (c, ordinary) => this.writeMessage(c, actor, channelId, parsed, newMessageId, workflow, ordinary));
  }
  async sendInTransaction(c: DbSession, actor: string, channelId: string, input: unknown, newMessageId?: string, workflow?: { name: string; workspace: string }): Promise<ChatMessage> {
    return this.writeMessage(c, actor, channelId, parseOutgoingMessage(input), newMessageId, workflow, false);
  }
  private async writeMessage(c: DbSession, actor: string, channelId: string, parsed: ReturnType<typeof parseOutgoingMessage>, newMessageId: string | undefined, workflow: { name: string; workspace: string } | undefined, plainChannel: boolean): Promise<ChatMessage> {
    const { request, encrypted } = parsed;
    const hash = createHash('sha256').update(JSON.stringify({ ...(request.also_send_to_channel ? {also_send_to_channel:true} : {}), ...(encrypted ? {encrypted} : {}), ...(workflow ? { workflow_name: workflow.name } : {}), channel_id: channelId, thread_id: request.thread_id, text: request.text, ...(request.document ? { document: request.document } : {}), ...(request.asset_ids?.length ? { asset_ids: request.asset_ids } : {}), ...(request.asset_descriptions ? { asset_descriptions: request.asset_descriptions } : {}) })).digest('hex');
    const channel = await this.authorize(c, actor, channelId);
    if (workflow && channel.workspace_id !== workflow.workspace) throw notFound();
    const [existing] = await c.select().from(s.messageIdentities).where(and(eq(s.messageIdentities.workspace_id, channel.workspace_id), eq(s.messageIdentities.user_id, actor), eq(s.messageIdentities.client_message_id, request.client_message_id)));
    if (existing) {
      if (existing.request_hash !== hash) throw new AppError(409, 'idempotency_conflict');
      return this.message(c, existing.id, existing.channel_id);
    }
    if (Boolean(channel.encrypted_since)!==Boolean(encrypted)) throw new AppError(409,'dm_encryption_mode_changed');
    if(encrypted){
      const live=(await dmDevices(c,channelId)).filter(d=>!d.revoked);
      if(channel.kind!=='direct'||workflow||!live.some(d=>d.id===encrypted.sender&&d.user_id===actor)
        || ![channel.direct_user_low,channel.direct_user_high].every(user=>live.some(d=>d.user_id===user))
        || live.length!==encrypted.recipients.length || live.some(d=>!encrypted.recipients.includes(d.id))) throw new AppError(409,'devices_changed');
    }
    // New cancellations and message inserts both advance the channel sequence.
    if (!plainChannel) {
      const cancelled = await c.execute(sql`SELECT 1 FROM cancelled_message_sends
        WHERE channel_id=${channelId} AND user_id=${actor} AND client_message_id=${request.client_message_id}`);
      if (cancelled.rows.length) throw new AppError(409, 'message_cancelled');
    }
    if (channel.archived_at) throw new AppError(409, 'channel_archived');
    if (channel.kind !== 'direct' && !plainChannel) {
      await requireChannelCapability(c, actor, channel.id, request.thread_id ? 'reply' : 'post');
      if (request.document?.ops.some(op => op.attributes?.mention?.kind === 'broadcast')) await requireChannelCapability(c, actor, channel.id, 'broadcast');
    }
    if (channel.kind === 'direct') {
      const inactive = await c.execute(sql`SELECT 1 FROM workspace_members WHERE workspace_id=${channel.workspace_id}
        AND user_id IN (${channel.direct_user_low},${channel.direct_user_high}) AND NOT active LIMIT 1`);
      if (inactive.rows.length) throw new AppError(409, 'direct_message_participant_inactive');
    }
    if (request.also_send_to_channel) {
      if (workflow) throw new AppError(403, 'thread_broadcast_forbidden');
      await this.requireBroadcast(c, actor, channel, request.thread_id!);
    }
    const prepared = await this.mentions.prepare(c, actor, channel, request.document, !!request.thread_id, !!request.broadcast_confirmed);
    const threadId = request.thread_id ?? randomUUID();
    if (request.thread_id) {
      if (!(await c.select({ id: s.threads.id }).from(s.threads).where(and(eq(s.threads.id, threadId), eq(s.threads.channel_id, channelId)))).length) throw notFound();
    } else await c.insert(s.threads).values({ id: threadId, workspace_id: channel.workspace_id, channel_id: channelId });
    const id = newMessageId ?? randomUUID();
    const fileQuery = request.asset_ids?.length ? c.select().from(s.assets).where(inArray(s.assets.id, request.asset_ids)).orderBy(s.assets.id) : null;
    const files = fileQuery ? await fileQuery : [];
    if (files.length !== (request.asset_ids?.length ?? 0) || files.some(file => file.channel_id !== channelId || file.uploader_id !== actor || file.status !== 'ready' || file.encrypted !== Boolean(encrypted) || file.message_id || file.task_id || file.expires_at <= new Date())) throw new AppError(409, 'asset_unavailable');
    const attachments = (request.asset_ids ?? []).map(id => {
      const file = files.find(file => file.id === id)!;
      return { id: file.id, name: file.name, size: file.size, type: file.type, ...(request.asset_descriptions?.[id] ? { description: request.asset_descriptions[id] } : {}) };
    });
    const [inserted] = await c.insert(s.messages).values({ id, workspace_id: channel.workspace_id, channel_id: channelId, thread_id: threadId,
      channel_broadcast_sequence: request.also_send_to_channel ? 0n : null, workflow_name: workflow?.name, author_type: workflow ? 'workflow' : 'human', user_id: actor, client_message_id: request.client_message_id, request_hash: hash, encrypted, text: prepared.document ? prepared.document.ops.map(op => op.insert).join('').trim() : request.text, document: prepared.document ?? null, attachments: encrypted ? [] : attachments }).returning({ sequence: s.messages.sequence });
    if (plainChannel) {
      // The insert advanced the channel sequence. A waiting writer now sees the
      // preceding commit, including an archive or cancellation that won the race.
      const state = await c.execute<{ archived: boolean; cancelled: boolean }>(sql`SELECT archived_at IS NOT NULL AS archived,
        EXISTS(SELECT 1 FROM cancelled_message_sends WHERE channel_id=${channelId} AND user_id=${actor}
          AND client_message_id=${request.client_message_id}) AS cancelled FROM channels WHERE id=${channelId}`);
      if (state.rows[0]!.cancelled) throw new AppError(409, 'message_cancelled');
      if (state.rows[0]!.archived) throw new AppError(409, 'channel_archived');
      await requireChannelCapability(c, actor, channel.id, request.thread_id ? 'reply' : 'post');
    }
    await this.mentions.notify(c, actor, channel, id, prepared.refs, !!request.thread_id);
    await this.notifications.notify(c, actor, channel, id, threadId, prepared.refs, !!request.thread_id, request.also_send_to_channel);
    if (files.length) {
      const attached = await c.update(s.assets).set({ message_id: id }).where(and(
        inArray(s.assets.id, files.map(file => file.id)), eq(s.assets.channel_id, channelId), eq(s.assets.uploader_id, actor),
        eq(s.assets.status, 'ready'), isNull(s.assets.message_id), isNull(s.assets.task_id), isNull(s.assets.queue_input_id), gt(s.assets.expires_at, sql`clock_timestamp()`),
      )).returning({ id: s.assets.id });
      if (attached.length !== files.length) throw new AppError(409, 'asset_unavailable');
    }
    if (channel.kind === 'direct') await c.execute(sql`UPDATE direct_message_views SET hidden=false,last_activity_at=now() WHERE channel_id=${channelId}`);
    if (plainChannel) {
      // The insert trigger already built the creation payload in this transaction.
      // Only the live reply summary is absent from the immutable event.
      // The new thread is still private to this transaction and has exactly one message.
      const summaryQuery = request.thread_id ? sql`chat_reply_summary(workspace_id,channel_id,thread_id)` : sql`NULL`;
      const { rows: [row] } = await c.execute<{ payload: ChatMessage; summary: ChatMessage['reply_summary'] | null }>(sql`
        SELECT payload,${summaryQuery} AS summary FROM channel_events
        WHERE channel_id=${channelId} AND sequence=${inserted!.sequence} AND type='message.created'`);
      if (!row) throw new Error('Missing creation event for inserted message');
      const summary = row.summary ?? { count: 0, participant_count: 0, participants: [], last_reply_at: null, revision: inserted!.sequence.toString() };
      return { ...row.payload, reply_summary: summary, reply_count: summary.count };
    }
    return this.message(c, id, channelId);
  }
  async requireBroadcast(c: DbSession, actor: string, channel: {id:string; kind:string}, thread: string) {
    if (channel.kind !== 'direct') await requireChannelCapability(c, actor, channel.id, 'post');
    const root = await c.execute(sql`SELECT 1 FROM messages m WHERE m.channel_id=${channel.id} AND m.thread_id=${thread}
      AND m.agent_session_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM agent_sessions a WHERE a.origin_thread_id=m.thread_id AND a.handoff_context IS NOT NULL) LIMIT 1`);
    if (!root.rowCount) throw new AppError(404, 'not_found');
  }

  async broadcastReply(actor: string, channelId: string, messageId: string) {
    return this.channelMutation(channelId, false, async c => {
      const channel = await this.authorize(c, actor, channelId);
      const current = await this.message(c, messageId, channelId);
      if (current.author.kind !== 'human' || current.author.id !== actor || !current.thread_root_id ||
          current.id === current.thread_root_id || current.agent_session_id || current.deleted_at) throw notFound();
      if (channel.archived_at) throw new AppError(409, 'channel_archived');
      if (channel.encrypted_since) throw new AppError(409, 'dm_encryption_mode_changed');
      if (channel.kind !== 'direct') await requireChannelCapability(c, actor, channel.id, 'reply');
      else if ((await c.execute(sql`SELECT 1 FROM workspace_members WHERE workspace_id=${channel.workspace_id}
        AND user_id IN (${channel.direct_user_low},${channel.direct_user_high}) AND NOT active`)).rowCount) {
        throw new AppError(409, 'direct_message_participant_inactive');
      }
      await this.requireBroadcast(c, actor, channel, current.thread_id);
      if (current.channel_broadcast_sequence) return current;
      const { rows: [row] } = await c.execute<{sequence:string}>(sql`UPDATE channels SET event_sequence=event_sequence+1
        WHERE id=${channelId} RETURNING event_sequence::text AS sequence`);
      const sequence = row!.sequence;
      await c.execute(sql`UPDATE messages SET channel_broadcast_sequence=${sequence},reaction_sequence=${sequence}
        WHERE channel_id=${channelId} AND id=${messageId} AND channel_broadcast_sequence IS NULL AND deleted_at IS NULL AND retained_at IS NULL`);
      const updated = await this.message(c, messageId, channelId);
      if (!updated.channel_broadcast_sequence) throw notFound();
      await c.execute(sql`INSERT INTO channel_events(workspace_id,channel_id,thread_id,sequence,type,payload)
        VALUES(${channel.workspace_id},${channelId},${current.thread_id},${sequence},'message.updated',${JSON.stringify(updated)}::jsonb)`);
      await this.notifications.notify(c, actor, channel, messageId, current.thread_id, [], true, true);
      if (channel.kind === 'direct') await c.execute(sql`UPDATE direct_message_views SET hidden=false,last_activity_at=now() WHERE channel_id=${channelId}`);
      await c.execute(sql`INSERT INTO chat_delivery_outbox(workspace_id,channel_id,resource_scope) VALUES(${channel.workspace_id},${channelId},'message')`);
      return updated;
    });
  }

  async cancelOutgoing(actor: string, channelId: string, clientId: string): Promise<{message: ChatMessage | null}> {
    clientId = uuid(clientId);
    return this.channelMutation(channelId, false, async c => {
      const channel = await this.authorize(c, actor, channelId);
      const [sent] = await c.select({ id: s.messageIdentities.id }).from(s.messageIdentities).where(and(
        eq(s.messageIdentities.workspace_id, channel.workspace_id), eq(s.messageIdentities.channel_id, channelId),
        eq(s.messageIdentities.user_id, actor), eq(s.messageIdentities.client_message_id, clientId),
      ));
      if (sent) return { message: await this.eraseMessage(c, actor, channel.workspace_id, channelId, sent.id) };
      await c.execute(sql`INSERT INTO cancelled_message_sends(channel_id,user_id,client_message_id)
        VALUES(${channelId},${actor},${clientId}) ON CONFLICT DO NOTHING`);
      return { message: null };
    });
  }

  async deleteMessage(actor: string, channelId: string, messageId: string): Promise<ChatMessage> {
    return this.channelMutation(channelId, true, async c => {
      const id = uuid(messageId);
      const reserved = await c.execute<{ sequence: string }>(sql`UPDATE channels SET event_sequence=event_sequence+1
        WHERE id=${channelId} AND EXISTS (SELECT 1 FROM messages WHERE channel_id=${channelId} AND id=${id}
          AND user_id=${actor} AND author_type='human' AND deleted_at IS NULL) RETURNING event_sequence::text AS sequence`);
      const channel = await this.authorize(c, actor, channelId);
      return this.eraseMessage(c, actor, channel.workspace_id, channelId, id, reserved.rows[0]?.sequence);
    });
  }

  async editMessage(actor: string, channelId: string, messageId: string, input: unknown): Promise<ChatMessage> {
    const fields = record(input, ['document', 'revision', 'broadcast_confirmed']);
    if (typeof fields.revision !== 'string') throw new AppError(400, 'invalid_revision');
    const revision = chatCursor(fields.revision);
    const draft = parseRichDocument(fields.document);
    const simpleEdit = !draft.ops.some(op => op.attributes?.mention);
    return this.channelMutation(channelId, simpleEdit, async (c, ordinary) => {
      // Take the required sequence as the first write for an ordinary edit.
      // Skip allocation for identical retries. Mention canonicalization can change
      // the stored document, so allocate those after preparing it.
      const draftText = draft.ops.map(op => op.insert).join('').trim();
      const reserved = ordinary ? (await c.execute<{ sequence: string }>(sql`UPDATE channels SET event_sequence=event_sequence+1
        WHERE id=${channelId} AND EXISTS (SELECT 1 FROM messages WHERE channel_id=${channelId} AND id=${uuid(messageId)}
          AND user_id=${actor} AND deleted_at IS NULL AND retained_at IS NULL AND (document IS DISTINCT FROM ${JSON.stringify(draft)}::jsonb OR text IS DISTINCT FROM ${draftText}))
        RETURNING event_sequence::text AS sequence`)).rows[0]?.sequence : undefined;
      const channel = await this.authorize(c, actor, channelId);
      const current = await this.message(c, uuid(messageId), channelId);
      if (current.author.kind !== 'human' || current.author.id !== actor || current.deleted_at) throw notFound();
      if (channel.archived_at) throw new AppError(409, 'channel_archived');
      if (channel.encrypted_since || current.encrypted) throw new AppError(409, 'dm_encryption_mode_changed');
      const reply = current.thread_root_id !== current.id;
      if (channel.kind !== 'direct') {
        await requireChannelCapability(c, actor, channelId, reply ? 'reply' : 'post');
        if (current.channel_broadcast_sequence) await requireChannelCapability(c, actor, channelId, 'post');
        if (draft.ops.some(op => op.attributes?.mention?.kind === 'broadcast')) await requireChannelCapability(c, actor, channelId, 'broadcast');
      } else if ((await c.execute(sql`SELECT 1 FROM workspace_members WHERE workspace_id=${channel.workspace_id}
        AND user_id IN (${channel.direct_user_low},${channel.direct_user_high}) AND NOT active`)).rowCount) {
        throw new AppError(409, 'direct_message_participant_inactive');
      }
      const prepared = await this.mentions.prepare(c, actor, channel, draft, reply, fields.broadcast_confirmed === true);
      const document = prepared.document!;
      const text = document.ops.map(op => op.insert).join('').trim();
      if (!text && !current.attachments?.length) throw new AppError(400, 'invalid_text');
      const body = JSON.stringify(document);
      const target = sql`channel_id=${channelId} AND id=${messageId} AND retained_at IS NULL AND deleted_at IS NULL`;
      if ((await c.execute(sql`SELECT 1 FROM messages WHERE ${target} AND document=${body}::jsonb AND text=${text}`)).rowCount) return current;
      if (ordinary && reserved === undefined) throw new SessionConflict();
      if ((current.reaction_sequence ?? '0') !== revision) throw new AppError(409, 'message_changed');
      const sequence = reserved ?? (await c.execute<{sequence:string}>(sql`UPDATE channels SET event_sequence=event_sequence+1
        WHERE id=${channelId} RETURNING event_sequence::text AS sequence`)).rows[0]!.sequence;
      if (!(await c.execute(sql`UPDATE messages SET text=${text},document=${body}::jsonb,reaction_sequence=${sequence}::bigint
        WHERE ${target} AND reaction_sequence=${revision}::bigint`)).rowCount) throw new AppError(409, 'message_changed');
      await syncSavedMemory(c, channelId);
      const updated = await this.message(c, messageId, channelId);
      await c.execute(sql`INSERT INTO channel_events(workspace_id,channel_id,thread_id,sequence,type,payload)
        VALUES(${channel.workspace_id},${channelId},${updated.thread_id},${sequence}::bigint,'message.updated',${JSON.stringify(updated)}::jsonb)`);
      await c.execute(sql`INSERT INTO chat_delivery_outbox(workspace_id,channel_id,resource_scope) VALUES(${channel.workspace_id},${channelId},'message'),(${channel.workspace_id},${channelId},'metadata')`);
      return updated;
    });
  }

  private async eraseMessage(c: DbSession, actor: string, workspace: string, channelId: string, messageId: string, reserved?: string): Promise<ChatMessage> {
    const [target] = await c.select({ deleted_at: s.messages.deleted_at }).from(s.messages).where(and(
      eq(s.messages.channel_id, channelId), eq(s.messages.id, messageId), eq(s.messages.user_id, actor), eq(s.messages.author_type, 'human'),
    ));
    if (!target) throw notFound();
    if (target.deleted_at) return this.message(c, messageId, channelId);

    // Preview generation can write into object storage until its processing claim ends.
    const busy = await c.execute(sql`SELECT 1 FROM assets WHERE channel_id=${channelId} AND message_id=${messageId} AND processing_until>now() LIMIT 1`);
    if (busy.rows.length) throw new AppError(409, 'asset_processing_busy');

    const sequence = reserved ?? (await c.execute<{sequence: string}>(sql`UPDATE channels SET event_sequence=event_sequence+1 WHERE id=${channelId} RETURNING event_sequence::text AS sequence`)).rows[0]!.sequence;
    await c.execute(sql`UPDATE messages SET text='Message deleted',document=NULL,attachments='[]'::jsonb,agent_response=NULL,
      deleted_at=now(),reaction_sequence=${sequence}::bigint WHERE channel_id=${channelId} AND id=${messageId}`);
    await eraseMessageReferences(c, workspace, channelId, messageId);
    await c.execute(sql`UPDATE channel_events e SET payload=deleted_message_payload(e.payload,m.deleted_at)
      FROM messages m WHERE m.channel_id=${channelId} AND m.id=${messageId} AND e.channel_id=m.channel_id
        AND e.type IN ('message.created','message.updated') AND e.payload->>'id'=${messageId}`);
    await c.execute(sql`INSERT INTO channel_events(workspace_id,channel_id,thread_id,sequence,type,payload)
      SELECT workspace_id,channel_id,thread_id,${sequence}::bigint,'message.updated',chat_message_payload(m)
      FROM messages m WHERE channel_id=${channelId} AND id=${messageId}`);
    await c.execute(sql`INSERT INTO chat_delivery_outbox(workspace_id,channel_id,resource_scope)
      VALUES(${workspace},${channelId},'message'),(${workspace},${channelId},'metadata')`);
    return this.message(c, messageId, channelId);
  }

  async react(actor: string, channelId: string, messageId: string, input: unknown): Promise<ChatMessage> {
    const { emoji, active } = parseReactionInput(input);
    const reaction = sql`apply_message_reaction(${uuid(actor)},${uuid(channelId)},${uuid(messageId)},${emoji},${active})`;
    return this.channelWrite(channelId, async () => {
      try {
        // The function performs the entire mutation and access checks atomically.
        // A channel's kind is immutable. DMs retain their serializable transaction.
        const ordinary = await retrySessionConflict(() => this.db.execute<{message: ChatMessage}>(sql`
          SELECT ${reaction} AS message FROM channels WHERE id=${channelId} AND kind='channel'`));
        if (ordinary.rows.length) return ordinary.rows[0]!.message;
        return await sessionTransaction(this.db, async c => {
          const { rows } = await c.execute<{message: ChatMessage}>(sql`SELECT ${reaction} AS message`);
          return rows[0]!.message;
        });
      } catch (error) {
        const failure = error as { cause?: { code?: string } };
        if (failure.cause?.code === 'SP404') throw notFound();
        if (failure.cause?.code === 'SP409') throw new AppError(409, 'channel_archived');
        throw error;
      }
    });
  }
  async channelTabs(actor: string, channelId: string) {
    return this.db.transaction(async c => {
      const channel = await this.authorize(c, actor, channelId);
      if (channel.kind !== 'channel') throw notFound();
      const visible = sql`channel_id=${channelId} AND agent_session_id IS NULL AND deleted_at IS NULL AND retained_at IS NULL`;
      const result = await c.execute<ChannelTabsState & Record<string, unknown>>(sql`SELECT
        EXISTS(SELECT 1 FROM messages WHERE ${visible} AND attachments <> '[]') AS has_files,
        EXISTS(SELECT 1 FROM messages WHERE ${visible} AND cardinality(channel_shared_urls(text,document)) > 0) AS has_links,
        EXISTS(SELECT 1 FROM messages WHERE ${visible} AND pin_order IS NOT NULL) AS has_pins,
        coalesce((SELECT jsonb_object_agg(tab,visible) FROM channel_tab_visibility WHERE channel_id=${channelId}), '{}') AS visibility,
        tab_order AS "order" FROM channels WHERE id=${channelId}`);
      return result.rows[0]!;
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  async moveChannelTab(actor: string, channelId: string, input: unknown) {
    const {tab, target, side} = record(input, ['tab','target','side']);
    if (typeof tab !== 'string' || typeof target !== 'string' || tab === target || (side !== 'before' && side !== 'after'))
      throw new AppError(400, 'invalid_tab_move');
    return sessionTransaction(this.db, async c => {
      const channel = await this.authorize(c, actor, channelId);
      if (channel.kind !== 'channel') throw notFound();
      if (channel.archived_at) throw new AppError(409, 'channel_archived');
      const result = await c.execute<{tab_order: string[]}>(sql`SELECT tab_order FROM channels WHERE id=${channelId}`);
      const order = result.rows[0]!.tab_order;
      if (!order.includes(tab) || !order.includes(target)) throw new AppError(400, 'invalid_tab_move');
      // Apply the relative move to the latest committed order on serialization retries.
      const next = order.filter(id => id !== tab);
      next.splice(next.indexOf(target) + (side === 'after' ? 1 : 0), 0, tab);
      if (order.indexOf(tab) === next.indexOf(tab)) return;
      await c.execute(sql`UPDATE channels SET tab_order=ARRAY[${sql.join(next.map(id => sql`${id}`), sql`,`)}]::text[] WHERE id=${channelId}`);
    });
  }

  async setTabVisibility(actor: string, channelId: string, tab: string, input: unknown) {
    const { visible } = record(input, ['visible']);
    if (!['files','pins','memory','navigator'].includes(tab) || typeof visible !== 'boolean') throw new AppError(400, 'invalid_tab');
    return sessionTransaction(this.db, async c => {
      const channel = await this.authorize(c, actor, channelId);
      if (channel.kind !== 'channel') throw notFound();
      if (channel.archived_at) throw new AppError(409, 'channel_archived');
      await c.execute(sql`INSERT INTO channel_tab_visibility(channel_id,workspace_id,tab,visible)
        VALUES(${channelId},${channel.workspace_id},${tab},${visible})
        ON CONFLICT (channel_id,tab) DO UPDATE SET visible=excluded.visible
        WHERE channel_tab_visibility.visible IS DISTINCT FROM excluded.visible`);
    });
  }

  async channelLinks(actor: string, channelId: string, input: unknown) {
    const query = record(input, ['before']);
    const before = query.before === undefined ? undefined : chatCursor(query.before);
    return this.db.transaction(async c => {
      const channel = await this.authorize(c, actor, channelId);
      if (channel.kind !== 'channel') throw notFound();
      const result = await c.execute<ChannelLinkMessage & { sequence: string }>(sql`
        SELECT id, created_at, sequence::text AS sequence, channel_shared_urls(text,document) AS urls
        FROM messages m WHERE channel_id=${channelId} AND agent_session_id IS NULL AND deleted_at IS NULL AND retained_at IS NULL
          AND cardinality(channel_shared_urls(text,document)) > 0 ${before ? sql`AND m.sequence < ${before}::bigint` : sql``}
        ORDER BY m.sequence DESC LIMIT 21`);
      return page(result.rows, 20, row => row.sequence);
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  async channelPins(actor: string, channelId: string, input: unknown) {
    const query = record(input, ['before']);
    const before = query.before === undefined ? undefined : chatCursor(query.before);
    return this.db.transaction(async c => {
      const channel = await this.authorize(c, actor, channelId);
      if (channel.kind !== 'channel') throw notFound();
      const result = await c.execute<ChannelPin & { pin_order: string }>(sql`
        SELECT m.id, m.pin_order::text, m.created_at, left(m.text,1200) AS text,
          chat_message_payload(m)->'author'->>'name' AS author
        FROM messages m
        WHERE m.channel_id=${channelId} AND m.pin_order IS NOT NULL
          ${before ? sql`AND m.pin_order < ${before}::bigint` : sql``}
        ORDER BY m.pin_order DESC LIMIT 26`);
      return page(result.rows, 25, row => row.pin_order);
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  async setChannelPin(actor: string, channelId: string, messageId: string, active: boolean) {
    return sessionTransaction(this.db, async c => {
      const channel = await this.authorize(c, actor, channelId);
      if (channel.kind !== 'channel') throw notFound();
      if (channel.archived_at) throw new AppError(409, 'channel_archived');
      const eligible = sql`channel_id=${channelId} AND id=${messageId} AND deleted_at IS NULL
        AND retained_at IS NULL AND agent_session_id IS NULL`;
      const changed = await c.execute(sql`UPDATE messages
        SET pin_order=${active ? sql`nextval('channel_pin_order_seq')` : sql`NULL`}
        WHERE ${eligible} AND ${active ? sql`pin_order IS NULL` : sql`pin_order IS NOT NULL`} RETURNING id`);
      if (!changed.rows.length && !(await c.execute(sql`SELECT 1 FROM messages WHERE ${eligible}`)).rows.length) throw notFound();
    });
  }
  async sourceMessage(actor: string, channel: string, id: string): Promise<ChatMessage> {
    return this.db.transaction(async c => {
      await this.authorize(c, actor, channel);
      return this.message(c, uuid(id), channel);
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
  private async message(c: DbSession, id: string, channel: string): Promise<ChatMessage> {
    const result = await c.execute<{ message: ChatMessage }>(sql`
      SELECT chat_message_payload(m) || CASE WHEN ch.encrypted_since IS NULL AND m.agent_session_id IS NULL
        THEN jsonb_build_object('reply_summary',chat_reply_summary(m.workspace_id,m.channel_id,m.thread_id)) ELSE '{}'::jsonb END AS message
      FROM messages m JOIN channels ch ON ch.id=m.channel_id WHERE m.channel_id=${channel} AND m.id=${id}`);
    if (!result.rows[0]) throw notFound();
    const message = result.rows[0].message;
    if (message.reply_summary) message.reply_count = message.reply_summary.count;
    return message;
  }
  async requireThreadAccess(actor: string, thread: string, c: DbSession = this.db) {
    if (!await hasThreadAccess(c, actor, thread)) throw notFound();
  }
  async replySuggestionContext(actor: string, thread: string) {
    return this.db.transaction(async c => {
      await this.requireThreadAccess(actor, thread, c);
      const state = (await c.execute<{ summary: string; through: string; offset: number; revision: string; viewer: string }>(sql`
        SELECT t.reply_summary AS summary, t.reply_summary_through::text AS through,
          t.reply_summary_offset AS offset, t.reply_history_revision::text AS revision, left(u.display_name, 80) AS viewer
        FROM threads t JOIN users u ON u.id=${actor} WHERE t.id=${thread}`)).rows[0]!;
      type Turn = { speaker: string; text: string; sequence: string };
      const visible = sql`FROM threads t JOIN messages m ON m.workspace_id=t.workspace_id AND m.channel_id=t.channel_id AND m.thread_id=t.id
        LEFT JOIN users u ON u.id=m.user_id WHERE t.id=${thread} AND m.agent_session_id IS NULL
        AND m.deleted_at IS NULL AND m.retained_at IS NULL`;
      const participant = sql`CASE WHEN m.workflow_name IS NOT NULL THEN concat('workflow: ',m.workflow_name) WHEN m.author_type='agent' THEN 'agent' ELSE concat('participant: ', left(u.display_name, 80)) END`;
      const columns = sql`left(m.text, 1000) AS text, m.sequence::text AS sequence`;
      const recent = (await c.execute<Turn>(sql`
        SELECT CASE WHEN m.user_id=${actor} THEN 'me' ELSE ${participant} END AS speaker, ${columns}
        ${visible} ORDER BY m.sequence DESC LIMIT 51`)).rows;
      const lastOlder = recent[50];
      const messages = recent.slice(0, 50).reverse();
      const older: (Turn & { nextOffset: number })[] = [];
      if (lastOlder && (lastOlder.sequence !== state.through || state.offset > 0)) {
        // Page large turns by Unicode code point. A successful batch can end inside a message.
        const start = sql`CASE WHEN m.sequence=${state.through}::bigint THEN ${state.offset}::int ELSE 0 END`;
        const rows = (await c.execute<Turn & { start: number; length: number }>(sql`
          SELECT ${participant} AS speaker, m.sequence::text AS sequence, ${start} AS start,
            substr(m.text, ${start} + 1, 4096) AS text, length(m.text) AS length ${visible}
          AND m.sequence >= ${state.through}::bigint AND (m.sequence > ${state.through}::bigint OR ${state.offset}::int > 0)
          AND m.sequence <= ${lastOlder.sequence}::bigint ORDER BY m.sequence LIMIT 50`)).rows;
        for (const row of rows) {
          const chars = Array.from(row.text);
          for (let i = 0; i < Math.max(1, chars.length); i += 512) {
            const end = row.start + Math.min(i + 512, chars.length);
            older.push({ sequence: row.sequence, speaker: row.speaker, text: chars.slice(i, i + 512).join(''),
              nextOffset: end < row.length ? end : 0 });
          }
          if (older.length >= 50 || older.at(-1)!.nextOffset) break;
        }
      }
      return { ...state, messages, older };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
  async saveReplySummary(actor: string, thread: string, previous: { through: string; offset: number; revision: string }, end: { sequence: string; nextOffset: number }, summary: string) {
    await this.db.transaction(async c => {
      await this.requireThreadAccess(actor, thread, c);
      // Another request can win this update. The caller always reloads the winning summary.
      await c.execute(sql`UPDATE threads SET reply_summary=${summary}, reply_summary_through=${end.sequence}::bigint, reply_summary_offset=${end.nextOffset}
        WHERE id=${thread} AND reply_history_revision=${previous.revision}::bigint AND reply_summary_through=${previous.through}::bigint
          AND reply_summary_offset=${previous.offset}`);
    });
  }
  async threadMessages(actor: string, thread: string, query: unknown = {}): Promise<ChatMessage[]> {
    const v = record(query, ['before']);
    const before = v.before === undefined ? undefined : uuid(v.before);
    return this.db.transaction(async c => {
      await this.requireThreadAccess(actor, thread, c);
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
    const position = (thread ? sql`${s.messages.sequence}` : sql`coalesce(${s.messages.channel_broadcast_sequence},${s.messages.sequence})`).mapWith(s.messages.sequence);
    const scope = and(eq(s.messages.workspace_id, channel.workspace_id), eq(s.messages.channel_id, channel.id), thread ? eq(s.messages.thread_id, thread) : sql`(${s.messages.channel_broadcast_sequence} IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM messages earlier WHERE earlier.workspace_id=${s.messages.workspace_id} AND earlier.channel_id=${s.messages.channel_id}
        AND earlier.thread_id=${s.messages.thread_id} AND earlier.sequence<${s.messages.sequence}
    ))`);
    const rows = await c.select({ sequence: position, message: sql<ChatMessage>`chat_message_payload(messages)` }).from(s.messages)
      .where(and(scope, before === undefined ? undefined : lt(position, BigInt(before)), after === undefined ? undefined : gt(position, BigInt(after))))
      .orderBy(after === undefined ? desc(position) : asc(position)).limit(limit);
    if (after === undefined) rows.reverse();
    const first = rows[0]?.sequence, last = rows.at(-1)?.sequence;
    const older = first === undefined ? after === undefined ? sql`false` : lte(position, BigInt(after)) : lt(position, first);
    const newer = last === undefined ? before === undefined ? sql`false` : gte(position, BigInt(before)) : gt(position, last);
    const bounds = await c.execute<{ has_older: boolean; has_newer: boolean }>(sql`SELECT
      EXISTS(SELECT 1 FROM ${s.messages} WHERE ${scope} AND ${older}) AS has_older,
      EXISTS(SELECT 1 FROM ${s.messages} WHERE ${scope} AND ${newer}) AS has_newer`);
    await attachReplySummaries(c, channel, rows.map(row => row.message));
    // This counter and the rows share a snapshot, so socket replay cannot skip a racing insert.
    return { messages: rows.map(row => !thread && row.message.channel_broadcast_sequence ? { ...row.message, sequence: row.message.channel_broadcast_sequence } : row.message), older_cursor: first?.toString() ?? null, newer_cursor: last?.toString() ?? null,
      has_older: bounds.rows[0]!.has_older, has_newer: bounds.rows[0]!.has_newer, event_cursor: channel.event_sequence.toString() };
  }
  async history(actor: string, channel: string, query: unknown = {}): Promise<ChatHistory> {
    const v = record(query, ['before']);
    const before = v.before === undefined ? undefined : BigInt(chatCursor(v.before));
    return this.db.transaction(async c => {
      const visible = await this.authorize(c, actor, channel);
      const rows = await c.select().from(s.channelEvents).where(and(eq(s.channelEvents.channel_id, channel), before === undefined ? undefined : lt(s.channelEvents.sequence, before)))
        .orderBy(desc(s.channelEvents.sequence)).limit(101);
      const events = rows.slice(0, 100).reverse().map(eventDto);
      await attachReplySummaries(c, visible, events.flatMap(e => e.type === 'task.event' ? [] : [e.payload]));
      return { events, cursor: events.at(-1)?.sequence ?? '0', oldest_cursor: events[0]?.sequence ?? '0', has_more: rows.length > 100 };
    });
  }
  async events(actor: string, channel: string, after: string): Promise<ChatEvent[]> {
    const cursor = BigInt(chatCursor(after));
    return this.db.transaction(async c => {
      const visible = await this.authorize(c, actor, channel);
      if (cursor > visible.event_sequence) throw new AppError(400, 'invalid_cursor');
      const events = (await c.select().from(s.channelEvents).where(and(eq(s.channelEvents.channel_id, channel), gt(s.channelEvents.sequence, cursor)))
        .orderBy(s.channelEvents.sequence).limit(100)).map(eventDto);
      await attachReplySummaries(c, visible, events.flatMap(e => e.type === 'task.event' ? [] : [e.payload]));
      return events;
    });
  }
}
// Message pages and replay batches contain at most 100 rows. Resolve each distinct public thread once.
async function attachReplySummaries(c: DbSession, channel: typeof s.channels.$inferSelect, messages: ChatMessage[]) {
  if (channel.encrypted_since) return;
  const publicMessages = messages.filter(message => !message.agent_session_id && !message.encrypted);
  const threads = [...new Set(publicMessages.map(message => message.thread_id))];
  if (!threads.length) return;
  const rows = await c.execute<{id: string; summary: NonNullable<ChatMessage['reply_summary']>}>(sql`
    SELECT id,chat_reply_summary(workspace_id,channel_id,id) AS summary FROM threads
    WHERE workspace_id=${channel.workspace_id} AND channel_id=${channel.id} AND id IN (${sql.join(threads.map(id => sql`${id}::uuid`),sql`,`)})`);
  const summaries = new Map(rows.rows.map(row => [row.id, row.summary]));
  for (const message of publicMessages) {
    message.reply_summary = summaries.get(message.thread_id);
    if (message.reply_summary) message.reply_count = message.reply_summary.count;
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
