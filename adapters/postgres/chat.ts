import {DmEncryptionStore,dmDevices} from './dm-encryption.js';
import {encryptedMessageLabel,parseEncryptedDm,parseRichDocument} from '@space/contracts';
import { ChannelWebhooks } from './channel-webhooks.js';
import {ChannelPermissionStore,readChannelPermissions,requireChannelCapability,requireRemainingChannelManager} from './channel-permissions.js';
import { requireFullWorkspaceMember } from './workspace-access.js';
import { requireWorkspacePolicy } from './workspace-settings.js';
import { NotificationStore } from './notifications.js';
import { DirectMessageStore } from './direct-messages.js';
import { syncSavedMemory } from './memory-sources.js';
import { eraseMessageReferences } from './workspace-retention.js';
import { sessionTransaction } from './session-concurrency.js';
import { MentionStore } from './mentions.js';
import { UnreadStore } from './unread.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { and, eq, gt, lt, gte, lte, asc, desc, or, exists, inArray, isNull, sql } from 'drizzle-orm';
import { AppError, parseReactionInput, parseMessageInput, parseChannelInput, parseChannelUpdate, parseMessagePage, parsePage, record, uuid, chatCursor, type ChatMessage, type ChatEvent, type ChatHistory, type MessagePage, type ChannelNotificationPreferences, type ChannelSummary, type ChannelDetails, type ChannelPin, type ChannelTabsState, type ChannelLinkMessage } from '@space/contracts';
import { database, type DbSession } from './database.js';
import { hasChannelAccess, requireWorkspaceAccess, lockWorkspace, hasThreadAccess } from './access.js';
import { page } from './membership.js';
import * as s from './schema.js';
const notFound = () => new AppError(404, 'not_found');

export class ChatStore {
  readonly db; readonly webhooks; readonly permissions; readonly notifications; readonly mentions; readonly unread; readonly directMessages; readonly encryption;
  constructor(readonly pool: Pool) { this.db = database(pool); this.webhooks = new ChannelWebhooks(this.db); this.permissions = new ChannelPermissionStore(this.db); this.notifications = new NotificationStore(pool); this.directMessages = new DirectMessageStore(this.db); this.encryption=new DmEncryptionStore(this.db); this.mentions = new MentionStore(pool); this.unread = new UnreadStore(pool); }
  async channels(actor: string, workspace: string, query: unknown = {}, channelIds?: string[]) {
    const { after, limit } = parsePage(query);
    return this.db.transaction(async c => {
      await requireWorkspaceAccess(c, actor, workspace);
      const member = c.select({ user_id: s.channelMembers.user_id }).from(s.channelMembers)
        .where(and(eq(s.channelMembers.channel_id, s.channels.id), eq(s.channelMembers.user_id, actor)));
      const rows = await c.select({ channel: s.channels, joined: sql<boolean>`exists (${member})`,
        preferences: sql<ChannelNotificationPreferences | null>`(SELECT jsonb_build_object(
          'mode',cm.notification_mode,'effective_mode',coalesce(cm.notification_mode,p.mode,'mentions'),
          'muted_until',cm.muted_until,'thread_replies',cm.notify_thread_replies,
          'desktop_enabled',coalesce(cm.channel_desktop_enabled,p.desktop_enabled,false),
          'badge_every_post',cm.badge_every_post,'follow_every_thread',cm.follow_every_thread)
          FROM channel_members cm LEFT JOIN mention_preferences p ON p.user_id=cm.user_id
          WHERE cm.channel_id=${s.channels.id} AND cm.user_id=${actor})` })
        .from(s.channels).where(and(eq(s.channels.workspace_id, workspace), eq(s.channels.kind, 'channel'), channelIds && inArray(s.channels.id, channelIds), or(and(eq(s.channels.private, false),sql`EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=${workspace} AND wm.user_id=${actor} AND wm.guest_type='none')`), exists(member)), after ? gt(s.channels.id, after) : undefined))
        .orderBy(s.channels.id).limit(limit + 1);
      return page(rows.map(row => ({...channelDto(row.channel, row.joined), ...(row.preferences && {notification_preferences:row.preferences})})), limit, row => row.id);
    });
  }
  async createChannel(actor: string, workspace: string, input: unknown) {
    const request = parseChannelInput(input);
    return sessionTransaction(this.db, async c => {
      await requireWorkspaceAccess(c, actor, workspace);
      await requireFullWorkspaceMember(c, actor, workspace);
      await requireWorkspacePolicy(c, actor, workspace, 'create_channel');
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
    return sessionTransaction(this.db, work, channel?.kind === 'direct' ? 'serializable' : 'read committed');
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
      const [channel] = await c.select().from(s.channels).where(eq(s.channels.id, uuid(id)));
      if (!channel) throw notFound();
      await requireWorkspaceAccess(c, actor, channel.workspace_id);
      if (channel.kind === 'direct') { await this.authorize(c, actor, id); throw new AppError(403, 'direct_message_immutable'); }
      if (!await hasChannelAccess(c, actor, channel.workspace_id, id)) {
        if (channel.private) throw notFound();
        await requireFullWorkspaceMember(c,actor,channel.workspace_id);
      }
      await c.insert(s.channelMembers).values({ workspace_id: channel.workspace_id, channel_id: id, user_id: actor }).onConflictDoNothing();
      return { joined: true };
    });
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
      await requireWorkspaceAccess(c, user, channel.workspace_id);
      const [target] = await c.select().from(s.workspaceMembers).where(and(eq(s.workspaceMembers.workspace_id,channel.workspace_id),eq(s.workspaceMembers.user_id,user)));
      if(target!.guest_type !== 'none') {
        const [manager] = await c.select().from(s.workspaceMembers).where(and(eq(s.workspaceMembers.workspace_id,channel.workspace_id),eq(s.workspaceMembers.user_id,actor)));
        if(manager?.role==='member') throw new AppError(403,'member_management_forbidden');
        if(target!.guest_type==='single' && target!.guest_channel_id && target!.guest_channel_id!==id) throw new AppError(409,'guest_channel_limit');
      }
      await c.insert(s.channelMembers).values({ workspace_id: channel.workspace_id, channel_id: id, user_id: user }).onConflictDoNothing();
      return { user_id: user, channel_id: id };
    });
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
  async send(actor: string, channelId: string, input: unknown, newMessageId?: string, workflow?: { name: string; workspace: string }): Promise<ChatMessage> {
    const wire=input && typeof input==='object' && 'encrypted' in input ? record(input,['client_message_id','encrypted']) : undefined;
    const encrypted=wire ? parseEncryptedDm(wire.encrypted) : undefined;
    const request=parseMessageInput(wire ? {client_message_id:wire.client_message_id,text:encryptedMessageLabel,...(encrypted?.asset_ids?.length ? {asset_ids:encrypted.asset_ids} : {})} : input);
    const hash = createHash('sha256').update(JSON.stringify({ ...(encrypted ? {encrypted} : {}), ...(workflow ? { workflow_name: workflow.name } : {}), channel_id: channelId, thread_id: request.thread_id, text: request.text, ...(request.document ? { document: request.document } : {}), ...(request.asset_ids?.length ? { asset_ids: request.asset_ids } : {}), ...(request.asset_descriptions ? { asset_descriptions: request.asset_descriptions } : {}) })).digest('hex');
    return sessionTransaction(this.db, async c => {
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
      // Both the send and cancellation check the other's identity in serializable
      // transactions. If both observe an absence, PostgreSQL retries one of them.
      const cancelled = await c.execute(sql`SELECT 1 FROM cancelled_message_sends
        WHERE channel_id=${channelId} AND user_id=${actor} AND client_message_id=${request.client_message_id}`);
      if (cancelled.rows.length) throw new AppError(409, 'message_cancelled');
      if (channel.archived_at) throw new AppError(409, 'channel_archived');
      if (channel.kind !== 'direct') {
        await requireChannelCapability(c, actor, channel.id, request.thread_id ? 'reply' : 'post');
        if (request.document?.ops.some(op => op.attributes?.mention?.kind === 'broadcast')) await requireChannelCapability(c, actor, channel.id, 'broadcast');
      }
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
      const id = newMessageId ?? randomUUID();
      const fileQuery = request.asset_ids?.length ? c.select().from(s.assets).where(inArray(s.assets.id, request.asset_ids)).orderBy(s.assets.id) : null;
      const files = fileQuery ? await fileQuery : [];
      if (files.length !== (request.asset_ids?.length ?? 0) || files.some(file => file.channel_id !== channelId || file.uploader_id !== actor || file.status !== 'ready' || file.encrypted !== Boolean(encrypted) || file.message_id || file.task_id || file.expires_at <= new Date())) throw new AppError(409, 'asset_unavailable');
      const attachments = (request.asset_ids ?? []).map(id => {
        const file = files.find(file => file.id === id)!;
        return { id: file.id, name: file.name, size: file.size, type: file.type, ...(request.asset_descriptions?.[id] ? { description: request.asset_descriptions[id] } : {}) };
      });
      await c.insert(s.messages).values({ id, workspace_id: channel.workspace_id, channel_id: channelId, thread_id: threadId,
        workflow_name: workflow?.name, author_type: workflow ? 'workflow' : 'human', user_id: actor, client_message_id: request.client_message_id, request_hash: hash, encrypted, text: prepared.document ? prepared.document.ops.map(op => op.insert).join('').trim() : request.text, document: prepared.document ?? null, attachments: encrypted ? [] : attachments });
      await this.mentions.notify(c, actor, channel, id, prepared.refs, !!request.thread_id);
      await this.notifications.notify(c, actor, channel, id, threadId, prepared.refs, !!request.thread_id);
      if (files.length) {
        const attached = await c.update(s.assets).set({ message_id: id }).where(and(
          inArray(s.assets.id, files.map(file => file.id)), eq(s.assets.channel_id, channelId), eq(s.assets.uploader_id, actor),
          eq(s.assets.status, 'ready'), isNull(s.assets.message_id), isNull(s.assets.task_id), isNull(s.assets.queue_input_id), gt(s.assets.expires_at, sql`clock_timestamp()`),
        )).returning({ id: s.assets.id });
        if (attached.length !== files.length) throw new AppError(409, 'asset_unavailable');
      }
      if (channel.kind === 'direct') await c.execute(sql`UPDATE direct_message_views SET hidden=false,last_activity_at=now() WHERE channel_id=${channelId}`);
      return this.message(c, id, channelId);
    // Spread channel/recipient contention across five attempts, with less than 3s total backoff.
    }, 'serializable', 100);
  }
  async cancelOutgoing(actor: string, channelId: string, clientId: string): Promise<{message: ChatMessage | null}> {
    clientId = uuid(clientId);
    return sessionTransaction(this.db, async c => {
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
    return sessionTransaction(this.db, async c => {
      const channel = await this.authorize(c, actor, channelId);
      return this.eraseMessage(c, actor, channel.workspace_id, channelId, uuid(messageId));
    });
  }

  async editMessage(actor: string, channelId: string, messageId: string, input: unknown): Promise<ChatMessage> {
    const fields = record(input, ['document', 'revision', 'broadcast_confirmed']);
    if (typeof fields.revision !== 'string') throw new AppError(400, 'invalid_revision');
    const revision = chatCursor(fields.revision);
    const draft = parseRichDocument(fields.document);
    return sessionTransaction(this.db, async c => {
      const channel = await this.authorize(c, actor, channelId);
      const current = await this.message(c, uuid(messageId), channelId);
      if (current.author.kind !== 'human' || current.author.id !== actor || current.deleted_at) throw notFound();
      if (channel.archived_at) throw new AppError(409, 'channel_archived');
      if (channel.encrypted_since || current.encrypted) throw new AppError(409, 'dm_encryption_mode_changed');
      const reply = current.thread_root_id !== current.id;
      if (channel.kind !== 'direct') {
        await requireChannelCapability(c, actor, channelId, reply ? 'reply' : 'post');
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
      if ((current.reaction_sequence ?? '0') !== revision) throw new AppError(409, 'message_changed');
      const sequence = (await c.execute<{sequence:string}>(sql`UPDATE channels SET event_sequence=event_sequence+1
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

  private async eraseMessage(c: DbSession, actor: string, workspace: string, channelId: string, messageId: string): Promise<ChatMessage> {
    const [target] = await c.select({ deleted_at: s.messages.deleted_at }).from(s.messages).where(and(
      eq(s.messages.channel_id, channelId), eq(s.messages.id, messageId), eq(s.messages.user_id, actor), eq(s.messages.author_type, 'human'),
    ));
    if (!target) throw notFound();
    if (target.deleted_at) return this.message(c, messageId, channelId);

    // Preview generation can write into object storage until its processing claim ends.
    const busy = await c.execute(sql`SELECT 1 FROM assets WHERE channel_id=${channelId} AND message_id=${messageId} AND processing_until>now() LIMIT 1`);
    if (busy.rows.length) throw new AppError(409, 'asset_processing_busy');

    const revision = await c.execute<{sequence: string}>(sql`UPDATE channels SET event_sequence=event_sequence+1 WHERE id=${channelId} RETURNING event_sequence::text AS sequence`);
    const sequence = revision.rows[0]!.sequence;
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
    messageId = uuid(messageId);
    return this.channelTransaction(channelId, async c => {
      const channel = await this.lockedChannel(c, channelId);
      await this.authorize(c, actor, channelId);
      const [message] = await c.select().from(s.messages).where(and(eq(s.messages.channel_id, channelId), eq(s.messages.id, messageId)));
      if (!message || message.deleted_at) throw notFound();
      if (channel.archived_at) throw new AppError(409, 'channel_archived');
      const changed = active
        ? await c.execute(sql`INSERT INTO message_reactions(channel_id,message_id,user_id,emoji) VALUES(${channelId},${messageId},${actor},${emoji}) ON CONFLICT DO NOTHING RETURNING emoji`)
        : await c.execute(sql`DELETE FROM message_reactions WHERE channel_id=${channelId} AND message_id=${messageId} AND user_id=${actor} AND emoji=${emoji} RETURNING emoji`);
      if (changed.rows.length) {
        if (active) await this.notifications.reaction(c, actor, channel, messageId, emoji);
        await c.execute(sql`UPDATE messages SET reaction_sequence=${channel.event_sequence + 1n} WHERE channel_id=${channelId} AND id=${messageId}`);
        await c.execute(sql`SELECT append_chat_event(${channelId},${message.thread_id},'message.updated',chat_message_payload(messages)) FROM messages WHERE channel_id=${channelId} AND id=${messageId}`);
      }
      return this.message(c, messageId, channelId);
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
    const result = await c.execute<{ message: ChatMessage }>(sql`SELECT chat_message_payload(messages) AS message FROM messages WHERE channel_id=${channel} AND id=${id}`);
    if (!result.rows[0]) throw notFound();
    return result.rows[0].message;
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
