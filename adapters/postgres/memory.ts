import type { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { AppError, chatCursor, parseMemoryConnection, parseAgentMemoryAccess, uuid, type AgentMemoryPermission, type AgentMemoryAccess, type Task, type ChatMessage, type MemoryConnection, type MemoryScope } from '@space/contracts';
import { database, type DbSession } from './database.js';
import { hasChannelAccess } from './access.js';
import * as s from './schema.js';
import { sessionTransaction } from './session-concurrency.js';
import { tokenHash } from './bootstrap.js';
import { assertContextThread } from './thread-context.js';

export type MemoryChannel = MemoryScope & { enabled: boolean; provider: string; can_manage: boolean; knowledge_enabled: boolean };
export async function agentMemoryAccess(c: DbSession, channel: MemoryScope, installationId: string): Promise<{ access: AgentMemoryAccess; revision: number } | undefined> {
  const rows = await c.execute<{ access: AgentMemoryAccess; revision: number; owner_id: string }>(sql`
    SELECT g.access,g.revision,i.owner_id FROM agent_memory_grants g
    JOIN agent_installations i ON i.id=g.installation_id AND i.workspace_id=g.workspace_id
    LEFT JOIN agent_connections ac ON ac.installation_id=i.id
    WHERE g.channel_id=${channel.channel_id} AND g.workspace_id=${channel.workspace_id} AND g.installation_id=${installationId}
      AND g.access<>'none' AND i.enabled AND ac.revoked_at IS NULL
      AND (ac.installation_id IS NOT NULL OR EXISTS (SELECT 1 FROM agent_grants ag JOIN agent_definitions d ON d.id=i.definition_id
        WHERE ag.installation_id=i.id AND ag.channel_id=g.channel_id AND d.capabilities->'skills' ? ag.skill))`);
  const grant = rows.rows[0];
  if (!grant || !await hasChannelAccess(c, grant.owner_id, channel.workspace_id, channel.channel_id)) return undefined;
  return { access: grant.access, revision: grant.revision };
}
export class MemoryStore {
  readonly db;
  constructor(readonly pool: Pool) { this.db = database(pool); }
  async channel<T>(actor: string, channelId: string, work: (channel: MemoryChannel, c: DbSession) => Promise<T>): Promise<T> {
    const channel = await this.authorize(this.db, actor, channelId);
    const result = await work(channel, this.db);
    const current = await this.authorize(this.db, actor, channelId);
    if (current.enabled !== channel.enabled || current.provider !== channel.provider || current.knowledge_enabled !== channel.knowledge_enabled) throw new AppError(409, 'memory_settings_changed');
    return result;
  }
  private async authorize(c: DbSession, actor: string, channelId: string): Promise<MemoryChannel> {
    const id = uuid(channelId);
    const [channel] = await c.select().from(s.channels).where(eq(s.channels.id, id));
    if (!channel || !await hasChannelAccess(c, actor, channel.workspace_id, id)) throw new AppError(404, 'not_found');
    if (channel.kind === 'direct') throw new AppError(403, 'direct_message_memory_forbidden');
    const [member] = await c.select({ role: s.workspaceMembers.role, guest_type: s.workspaceMembers.guest_type }).from(s.workspaceMembers)
      .where(and(eq(s.workspaceMembers.workspace_id, channel.workspace_id), eq(s.workspaceMembers.user_id, actor), eq(s.workspaceMembers.active, true)));
    return { workspace_id: channel.workspace_id, channel_id: id, enabled: channel.memory_enabled, knowledge_enabled: channel.knowledge_enabled,
      provider: channel.memory_provider, can_manage: member?.guest_type === 'none' && (channel.created_by === actor || member.role === 'owner' || member.role === 'admin') };
  }
  private async manage<T>(actor: string, channelId: string, work: (channel: MemoryChannel, c: DbSession) => Promise<T>): Promise<T> {
    return sessionTransaction(this.db, async c => work(await this.authorize(c, actor, channelId), c));
  }
  async agents(actor: string, channelId: string): Promise<{ items: AgentMemoryPermission[] }> {
    return this.channel(actor, channelId, async (channel, c) => {
      if (!channel.can_manage) throw new AppError(403, 'channel_management_forbidden');
      const rows = await c.execute<AgentMemoryPermission & { owner_id: string }>(sql`
        SELECT i.id,coalesce(ac.name,d.name) AS name,coalesce(g.access,'none') AS access,i.owner_id
        FROM agent_installations i JOIN agent_definitions d ON d.id=i.definition_id
        LEFT JOIN agent_connections ac ON ac.installation_id=i.id
        LEFT JOIN agent_memory_grants g ON g.installation_id=i.id AND g.channel_id=${channelId}
        WHERE i.workspace_id=${channel.workspace_id} AND i.enabled AND ac.revoked_at IS NULL
        ORDER BY i.id LIMIT 100`);
      const items: AgentMemoryPermission[] = [];
      for (const row of rows.rows) if (await hasChannelAccess(c, row.owner_id, channel.workspace_id, channelId)) {
        items.push({ id: row.id, name: row.name, access: row.access });
      }
      return { items };
    });
  }
  async setAgentAccess(actor: string, channelId: string, installationId: string, input: unknown) {
    const access = parseAgentMemoryAccess(input); uuid(installationId);
    return this.manage(actor, channelId, async (channel, c) => {
      if (!channel.can_manage) throw new AppError(403, 'channel_management_forbidden');
      const [installation] = await c.select().from(s.agentInstallations).where(and(eq(s.agentInstallations.id, installationId), eq(s.agentInstallations.workspace_id, channel.workspace_id)));
      if (!installation) throw new AppError(404, 'not_found');
      if (access !== 'none' && ((!channel.enabled && !channel.knowledge_enabled) || !installation.enabled || !await hasChannelAccess(c, installation.owner_id, channel.workspace_id, channelId))) throw new AppError(403, 'memory_agent_forbidden');
      await c.insert(s.agentMemoryGrants).values({ workspace_id: channel.workspace_id, channel_id: channelId, installation_id: installationId, access })
        .onConflictDoUpdate({ target: [s.agentMemoryGrants.channel_id, s.agentMemoryGrants.installation_id], set: { access, revision: sql`${s.agentMemoryGrants.revision}+1` } });
      await c.insert(s.foundationEvents).values({ id: randomUUID(), workspace_id: channel.workspace_id, installation_id: installationId, actor_id: actor, type: 'memory.access_changed', payload: { channel_id: channelId, access } });
      return { access };
    });
  }
  private async agentAccess(c: DbSession, channel: MemoryScope, installationId: string) {
    return agentMemoryAccess(c, channel, installationId);
  }
  async agentContext<T>(task: Pick<Task, 'installation_id' | 'requester_id' | 'thread_id'>, read: (channel: MemoryChannel) => Promise<T>): Promise<T | undefined> {
    const [thread] = await this.db.select({channel_id:s.threads.channel_id,workspace_id:s.threads.workspace_id,kind:s.channels.kind}).from(s.threads).innerJoin(s.channels,eq(s.channels.id,s.threads.channel_id)).where(eq(s.threads.id, task.thread_id));
    if (!thread) throw new AppError(404, 'not_found');
    if (thread.kind === 'direct') {
      if (!await hasChannelAccess(this.db,task.requester_id,thread.workspace_id,thread.channel_id)) throw new AppError(404, 'not_found');
      return undefined; // DMs have conversation context, but no optional channel memory.
    }
    const channel = await this.authorize(this.db, task.requester_id, thread.channel_id);
    const grant = channel.enabled ? await this.agentAccess(this.db, channel, task.installation_id) : undefined;
    if (!grant) return undefined;
    const result = await read(channel);
    const current = await this.authorize(this.db, task.requester_id, thread.channel_id);
    const permission = current.enabled ? await this.agentAccess(this.db, current, task.installation_id) : undefined;
    if (!permission || current.provider !== channel.provider || permission.revision !== grant.revision) throw new AppError(409, 'memory_settings_changed');
    return result;
  }
  async configure(c: DbSession, channel: MemoryChannel, enabled: boolean, provider: string) {
    if (!channel.can_manage) throw new AppError(403, 'channel_management_forbidden');
    await c.update(s.channels).set({ memory_enabled: enabled, memory_provider: provider }).where(eq(s.channels.id, channel.channel_id));
    return Object.assign(channel, { enabled, provider });
  }
  async configureKnowledge(c: DbSession, channel: MemoryChannel, enabled: boolean) {
    if (!channel.can_manage) throw new AppError(403, 'channel_management_forbidden');
    await c.update(s.channels).set({ knowledge_enabled: enabled }).where(eq(s.channels.id, channel.channel_id));
    return Object.assign(channel, { knowledge_enabled: enabled });
  }
  async connections(actor: string, channelId: string): Promise<{ items: MemoryConnection[] }> {
    return this.channel(actor, channelId, async (channel, c) => {
      if (!channel.can_manage) throw new AppError(403, 'channel_management_forbidden');
      const rows = await c.select({ id: s.memoryConnections.id, name: s.memoryConnections.name, access: s.memoryConnections.access, thread_id: s.memoryConnections.thread_id, installation_id: s.memoryConnections.installation_id, created_at: s.memoryConnections.created_at })
        .from(s.memoryConnections).where(eq(s.memoryConnections.channel_id, channelId)).orderBy(s.memoryConnections.created_at, s.memoryConnections.id);
      return { items: rows.map(row => ({ ...row, created_at: row.created_at.toISOString() })) };
    });
  }
  async createConnection(actor: string, channelId: string, input: unknown, threadId?: string) {
    const data = parseMemoryConnection(input);
    return this.manage(actor, channelId, async (channel, c) => {
      if (!channel.can_manage) throw new AppError(403, 'channel_management_forbidden');
      if (threadId && (data.installation_id || data.access === 'contribute')) throw new AppError(400, 'invalid_memory_access');
      if (data.installation_id) {
        const permission = await this.agentAccess(c, channel, data.installation_id);
        if (!permission || data.access === 'write' || (data.access === 'contribute' && permission.access !== 'contribute')) throw new AppError(403, 'memory_agent_forbidden');
      }
      if (threadId) await assertContextThread(c, channelId, threadId);
      else if (!channel.enabled && !channel.knowledge_enabled) throw new AppError(409, 'memory_disabled');
      const rows = await c.select({ id: s.memoryConnections.id }).from(s.memoryConnections).where(eq(s.memoryConnections.channel_id, channelId)).limit(20);
      if (rows.length >= 20) throw new AppError(409, 'memory_connection_limit');
      const token = `smem_${randomBytes(32).toString('base64url')}`;
      const [row] = await c.insert(s.memoryConnections).values({ id: randomUUID(), workspace_id: channel.workspace_id, channel_id: channelId,
        created_by: actor, thread_id: threadId ?? null, token_hash: tokenHash(token), ...data }).returning({ id: s.memoryConnections.id, name: s.memoryConnections.name, access: s.memoryConnections.access, thread_id: s.memoryConnections.thread_id, installation_id: s.memoryConnections.installation_id, created_at: s.memoryConnections.created_at });
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
  async connected<T>(token: unknown, write: boolean, work: (channel: MemoryChannel, c: DbSession, connection: { id: string; name: string; access: MemoryConnection['access']; thread_id: string | null; installation_id: string | null }) => Promise<T>): Promise<T> {
    if (typeof token !== 'string' || !/^smem_[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError(401, 'unauthorized');
    const hash = tokenHash(token);
    const [ref] = await this.db.select({ channel_id: s.memoryConnections.channel_id, created_by: s.memoryConnections.created_by, thread_id: s.memoryConnections.thread_id, installation_id: s.memoryConnections.installation_id }).from(s.memoryConnections).where(eq(s.memoryConnections.token_hash, hash));
    if (!ref) throw new AppError(401, 'unauthorized');
    try {
      const scope = ref.thread_id ? this.manage.bind(this) : this.channel.bind(this);
      return await scope(ref.created_by, ref.channel_id, async (channel, c) => {
        const [connection] = await c.select({ id: s.memoryConnections.id, name: s.memoryConnections.name, access: s.memoryConnections.access, thread_id: s.memoryConnections.thread_id, installation_id: s.memoryConnections.installation_id }).from(s.memoryConnections)
          .where(and(eq(s.memoryConnections.token_hash, hash), eq(s.memoryConnections.channel_id, ref.channel_id)));
        if (!connection) throw new AppError(401, 'unauthorized');
        if (!connection.thread_id && !channel.enabled && !channel.knowledge_enabled) throw new AppError(409, 'memory_disabled');
        if (write && connection.access === 'read') throw new AppError(403, 'memory_write_forbidden');
        const checkAgent = async () => {
          if (!connection.installation_id) return;
          const permission = await this.agentAccess(c, channel, connection.installation_id);
          if (!permission || (write && permission.access !== 'contribute')) throw new AppError(403, 'memory_agent_forbidden');
        };
        await checkAgent();
        const result = await work(channel, c, connection);
        await checkAgent();
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
    const rows = await c.select({ sequence: s.messages.sequence, id: s.messages.id, thread_id: s.messages.thread_id, text: s.messages.text,
      attachments: s.messages.attachments, author: sql<ChatMessage['author']>`${s.channelEvents.payload}->'author'`,
      created_at: sql<string>`${s.channelEvents.payload}->>'created_at'` }).from(s.messages)
      .innerJoin(s.channelEvents, and(eq(s.channelEvents.channel_id, s.messages.channel_id), eq(s.channelEvents.sequence, s.messages.sequence)))
      .where(and(eq(s.messages.workspace_id, channel.workspace_id), eq(s.messages.channel_id, channel.channel_id), isNull(s.messages.agent_session_id), isNull(s.messages.deleted_at),
        sql`messages.retained_at IS NULL`, gt(s.messages.sequence, BigInt(cursor)), eq(s.channelEvents.type, 'message.created')))
      .orderBy(s.messages.sequence).limit(limit + 1);
    const items = rows.slice(0, limit);
    return { messages: items.map(({ sequence: _cursor, ...message }) => message), cursor: items.at(-1)?.sequence.toString() ?? cursor, has_more: rows.length > limit };
  }
  async message(c: DbSession, channel: MemoryScope, messageId: string): Promise<ChatMessage> {
    const [row] = await c.select().from(s.messages).where(and(eq(s.messages.id, uuid(messageId)), eq(s.messages.channel_id, channel.channel_id),
      isNull(s.messages.agent_session_id), isNull(s.messages.deleted_at), sql`messages.retained_at IS NULL`));
    if (!row) throw new AppError(404, 'not_found');
    let name: string;
    if (row.workflow_name) name = row.workflow_name;
    else if (row.webhook_name) name = row.webhook_name;
    else if (row.user_id) {
      const [author] = await c.select({ name: s.users.display_name }).from(s.users).where(eq(s.users.id, row.user_id));
      name = author!.name;
    } else {
      const [author] = await c.select({ name: s.agentDefinitions.name }).from(s.agentInstallations)
        .innerJoin(s.agentDefinitions, eq(s.agentDefinitions.id, s.agentInstallations.definition_id)).where(eq(s.agentInstallations.id, row.installation_id!));
      name = author!.name;
    }
    return { id: row.id, channel_id: row.channel_id, thread_id: row.thread_id, task_id: row.task_id, client_message_id: row.client_message_id,
      text: row.text, document: row.document, created_at: row.created_at.toISOString(),
      author: { kind: row.author_type, id: row.user_id ?? row.installation_id ?? row.webhook_id!, name }, attachments: row.attachments };
  }
}
