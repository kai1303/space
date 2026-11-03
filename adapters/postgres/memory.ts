import type { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { AppError, chatCursor, parseMemoryConnection, uuid, type ChatMessage, type MemoryConnection, type MemoryScope } from '@space/contracts';
import { database, type DbSession } from './database.js';
import { hasChannelAccess, lockWorkspace } from './access.js';
import * as s from './schema.js';
import { tokenHash } from './bootstrap.js';
import { assertContextThread } from './thread-context.js';

export type MemoryChannel = MemoryScope & { enabled: boolean; provider: string; can_manage: boolean };
export class MemoryStore {
  readonly db;
  constructor(pool: Pool) { this.db = database(pool); }
  async channel<T>(actor: string, channelId: string, work: (channel: MemoryChannel, c: DbSession) => Promise<T>): Promise<T> {
    const channel = await this.authorize(this.db, actor, channelId);
    const result = await work(channel, this.db);
    const current = await this.authorize(this.db, actor, channelId);
    if (current.enabled !== channel.enabled || current.provider !== channel.provider) throw new AppError(409, 'memory_settings_changed');
    return result;
  }
  private async authorize(c: DbSession, actor: string, channelId: string): Promise<MemoryChannel> {
    const id = uuid(channelId);
    const [channel] = await c.select().from(s.channels).where(eq(s.channels.id, id));
    if (!channel || !await hasChannelAccess(c, actor, channel.workspace_id, id)) throw new AppError(404, 'not_found');
    const [member] = await c.select({ role: s.workspaceMembers.role }).from(s.workspaceMembers)
      .where(and(eq(s.workspaceMembers.workspace_id, channel.workspace_id), eq(s.workspaceMembers.user_id, actor)));
    return { workspace_id: channel.workspace_id, channel_id: id, enabled: channel.memory_enabled,
      provider: channel.memory_provider, can_manage: channel.created_by === actor || member?.role === 'owner' || member?.role === 'admin' };
  }
  private async manage<T>(actor: string, channelId: string, work: (channel: MemoryChannel, c: DbSession) => Promise<T>): Promise<T> {
    return this.db.transaction(async c => {
      const id = uuid(channelId);
      const [ref] = await c.select({ workspace_id: s.channels.workspace_id }).from(s.channels).where(eq(s.channels.id, id));
      if (!ref) throw new AppError(404, 'not_found');
      await lockWorkspace(c, ref.workspace_id);
      const [channel] = await c.select().from(s.channels).where(eq(s.channels.id, id)).for('update');
      if (!channel || !await hasChannelAccess(c, actor, channel.workspace_id, id)) throw new AppError(404, 'not_found');
      const [member] = await c.select({ role: s.workspaceMembers.role }).from(s.workspaceMembers)
        .where(and(eq(s.workspaceMembers.workspace_id, channel.workspace_id), eq(s.workspaceMembers.user_id, actor)));
      return work({ workspace_id: channel.workspace_id, channel_id: id, enabled: channel.memory_enabled,
        provider: channel.memory_provider, can_manage: channel.created_by === actor || member?.role === 'owner' || member?.role === 'admin' }, c);
    });
  }
  async configure(c: DbSession, channel: MemoryChannel, enabled: boolean, provider: string) {
    if (!channel.can_manage) throw new AppError(403, 'channel_management_forbidden');
    await c.update(s.channels).set({ memory_enabled: enabled, memory_provider: provider }).where(eq(s.channels.id, channel.channel_id));
    return Object.assign(channel, { enabled, provider });
  }
  async connections(actor: string, channelId: string): Promise<{ items: MemoryConnection[] }> {
    return this.channel(actor, channelId, async (channel, c) => {
      if (!channel.can_manage) throw new AppError(403, 'channel_management_forbidden');
      const rows = await c.select({ id: s.memoryConnections.id, name: s.memoryConnections.name, access: s.memoryConnections.access, thread_id: s.memoryConnections.thread_id, created_at: s.memoryConnections.created_at })
        .from(s.memoryConnections).where(eq(s.memoryConnections.channel_id, channelId)).orderBy(s.memoryConnections.created_at, s.memoryConnections.id);
      return { items: rows.map(row => ({ ...row, created_at: row.created_at.toISOString() })) };
    });
  }
  async createConnection(actor: string, channelId: string, input: unknown, threadId?: string) {
    const data = parseMemoryConnection(input);
    return this.manage(actor, channelId, async (channel, c) => {
      if (!channel.can_manage) throw new AppError(403, 'channel_management_forbidden');
      if (threadId) await assertContextThread(c, channelId, threadId);
      else if (!channel.enabled) throw new AppError(409, 'memory_disabled');
      const rows = await c.select({ id: s.memoryConnections.id }).from(s.memoryConnections).where(eq(s.memoryConnections.channel_id, channelId)).limit(20);
      if (rows.length >= 20) throw new AppError(409, 'memory_connection_limit');
      const token = `smem_${randomBytes(32).toString('base64url')}`;
      const [row] = await c.insert(s.memoryConnections).values({ id: randomUUID(), workspace_id: channel.workspace_id, channel_id: channelId,
        created_by: actor, thread_id: threadId ?? null, token_hash: tokenHash(token), ...data }).returning({ id: s.memoryConnections.id, name: s.memoryConnections.name, access: s.memoryConnections.access, thread_id: s.memoryConnections.thread_id, created_at: s.memoryConnections.created_at });
      return { connection: { ...row!, created_at: row!.created_at.toISOString() }, token };
    });
  }
  async revokeConnection(actor: string, channelId: string, connectionId: string) {
    return this.channel(actor, channelId, async (channel, c) => {
      if (!channel.can_manage) throw new AppError(403, 'channel_management_forbidden');
      await c.delete(s.memoryConnections).where(and(eq(s.memoryConnections.id, uuid(connectionId)), eq(s.memoryConnections.channel_id, channelId)));
      return { revoked: true };
    });
  }
  async connected<T>(token: unknown, write: boolean, work: (channel: MemoryChannel, c: DbSession, connection: { id: string; name: string; access: 'read' | 'write'; thread_id: string | null }) => Promise<T>): Promise<T> {
    if (typeof token !== 'string' || !/^smem_[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError(401, 'unauthorized');
    const hash = tokenHash(token);
    const [ref] = await this.db.select({ channel_id: s.memoryConnections.channel_id, created_by: s.memoryConnections.created_by, thread_id: s.memoryConnections.thread_id }).from(s.memoryConnections).where(eq(s.memoryConnections.token_hash, hash));
    if (!ref) throw new AppError(401, 'unauthorized');
    try {
      const scope = ref.thread_id ? this.manage.bind(this) : this.channel.bind(this);
      return await scope(ref.created_by, ref.channel_id, async (channel, c) => {
        const [connection] = await c.select({ id: s.memoryConnections.id, name: s.memoryConnections.name, access: s.memoryConnections.access, thread_id: s.memoryConnections.thread_id }).from(s.memoryConnections)
          .where(and(eq(s.memoryConnections.token_hash, hash), eq(s.memoryConnections.channel_id, ref.channel_id)));
        if (!connection) throw new AppError(401, 'unauthorized');
        if (!connection.thread_id && !channel.enabled) throw new AppError(409, 'memory_disabled');
        if (write && connection.access !== 'write') throw new AppError(403, 'memory_write_forbidden');
        const result = await work(channel, c, connection);
        const [current] = await c.select({ id: s.memoryConnections.id }).from(s.memoryConnections)
          .where(eq(s.memoryConnections.token_hash, hash));
        if (!current) throw new AppError(401, 'unauthorized');
        return result;
      });
    } catch (error) {
      if (error instanceof AppError && error.status === 404) throw new AppError(401, 'unauthorized');
      throw error;
    }
  }
  async context(c: DbSession, channel: MemoryScope, after = '0', limit = 20) {
    const cursor = chatCursor(after);
    const rows = await c.select({ sequence: s.channelEvents.sequence, payload: s.channelEvents.payload }).from(s.channelEvents)
      .where(and(eq(s.channelEvents.channel_id, channel.channel_id), eq(s.channelEvents.type, 'message.created'), gt(s.channelEvents.sequence, BigInt(cursor))))
      .orderBy(s.channelEvents.sequence).limit(limit + 1);
    const items = rows.slice(0, limit);
    return { messages: items.map(row => {
      const message = row.payload as ChatMessage;
      return { id: message.id, thread_id: message.thread_id, text: message.text, author: message.author, created_at: message.created_at, attachments: message.attachments ?? [] };
    }), cursor: items.at(-1)?.sequence.toString() ?? cursor, has_more: rows.length > limit };
  }
  async message(c: DbSession, channel: MemoryScope, messageId: string): Promise<ChatMessage> {
    const [row] = await c.select().from(s.messages).where(and(eq(s.messages.id, uuid(messageId)), eq(s.messages.channel_id, channel.channel_id)));
    if (!row) throw new AppError(404, 'not_found');
    let name: string;
    if (row.user_id) {
      const [author] = await c.select({ name: s.users.display_name }).from(s.users).where(eq(s.users.id, row.user_id));
      name = author!.name;
    } else {
      const [author] = await c.select({ name: s.agentDefinitions.name }).from(s.agentInstallations)
        .innerJoin(s.agentDefinitions, eq(s.agentDefinitions.id, s.agentInstallations.definition_id)).where(eq(s.agentInstallations.id, row.installation_id!));
      name = author!.name;
    }
    return { id: row.id, channel_id: row.channel_id, thread_id: row.thread_id, task_id: row.task_id, client_message_id: row.client_message_id,
      text: row.text, document: row.document, created_at: row.created_at.toISOString(),
      author: { kind: row.user_id ? 'human' : 'agent', id: row.user_id ?? row.installation_id!, name }, attachments: row.attachments };
  }
}
