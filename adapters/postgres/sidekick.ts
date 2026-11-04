import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { AppError, parseSidekickContext, parseSidekickInput, record, uuid, type SidekickContext, type SidekickSession } from '@space/contracts';
import { hasChannelAccess, requireWorkspaceAccess } from './access.js';
import type { Database, DbSession } from './database.js';
import { sessionTransaction } from './session-concurrency.js';
import * as s from './schema.js';

const notFound = () => new AppError(404, 'not_found');
const columns = sql`a.id,a.workspace_id,a.installation_id,a.origin_thread_id,a.title,a.state,a.managed,a.created_by,a.created_at::text,a.skill,
  d.name AS agent_name,i.owner_id,t.channel_id,(SELECT count(*)::int FROM tasks WHERE session_id=a.id) AS turn_count`;
async function summary(c: DbSession, id: string): Promise<SidekickSession> {
  const result = await c.execute<SidekickSession & Record<string, unknown>>(sql`SELECT ${columns} FROM agent_sessions a JOIN threads t ON t.id=a.origin_thread_id
    JOIN agent_installations i ON i.id=a.installation_id JOIN agent_definitions d ON d.id=i.definition_id WHERE a.id=${id}`);
  return result.rows[0]!;
}
export class SidekickStore {
  constructor(readonly db: Database) {}
  async agents(actor: string, workspace: string) {
    return this.db.transaction(async c => {
      await requireWorkspaceAccess(c,actor,workspace);
      return (await c.execute(sql`SELECT i.id,coalesce(ac.name,d.name) AS name,i.owner_id,i.enabled,d.capabilities
        FROM agent_installations i JOIN agent_definitions d ON d.id=i.definition_id LEFT JOIN agent_connections ac ON ac.installation_id=i.id
        WHERE i.workspace_id=${workspace} AND i.owner_id=${actor} AND i.enabled AND ac.revoked_at IS NULL
          AND d.capabilities->>'persistent_sessions'='true' ORDER BY i.id LIMIT 200`)).rows;
    });
  }
  async list(actor: string, workspace: string, raw: unknown = {}) {
    const input = record(raw, ['before']), before = input.before === undefined ? undefined : uuid(input.before);
    return this.db.transaction(async c => {
      await requireWorkspaceAccess(c, actor, workspace);
      if (before && !(await c.execute(sql`SELECT 1 FROM agent_sessions WHERE id=${before} AND workspace_id=${workspace} AND created_by=${actor} AND handoff_context IS NOT NULL`)).rows.length) throw notFound();
      const result = await c.execute<SidekickSession & Record<string, unknown>>(sql`SELECT ${columns} FROM agent_sessions a JOIN threads t ON t.id=a.origin_thread_id
        JOIN agent_installations i ON i.id=a.installation_id JOIN agent_definitions d ON d.id=i.definition_id
        WHERE a.workspace_id=${workspace} AND a.created_by=${actor} AND a.handoff_context IS NOT NULL
        ${before ? sql`AND (a.created_at,a.id)<(SELECT created_at,id FROM agent_sessions WHERE id=${before})` : sql``}
        ORDER BY a.created_at DESC,a.id DESC LIMIT 21`);
      return { items: result.rows.slice(0,20), next_cursor: result.rows.length > 20 ? result.rows[19]!.id : null };
    });
  }
  async create(actor: string, workspace: string, raw: unknown): Promise<SidekickSession> {
    const input = parseSidekickInput(raw);
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return sessionTransaction(this.db, async c => {
      await requireWorkspaceAccess(c, actor, workspace);
      const [installation] = await c.select({ installation: s.agentInstallations, definition: s.agentDefinitions }).from(s.agentInstallations)
        .innerJoin(s.agentDefinitions,eq(s.agentDefinitions.id,s.agentInstallations.definition_id))
        .where(and(eq(s.agentInstallations.id,input.installation_id),eq(s.agentInstallations.workspace_id,workspace),eq(s.agentInstallations.owner_id,actor)));
      if (!installation) throw notFound();
      if (!installation.installation.enabled || !installation.definition.capabilities.persistent_sessions || !installation.definition.capabilities.skills.includes(input.skill)) throw new AppError(409,'sidekick_agent_unavailable');
      const [existing] = await c.select().from(s.agentSessions).where(eq(s.agentSessions.id,input.client_session_id));
      if (existing) {
        if (existing.created_by !== actor || existing.workspace_id !== workspace || existing.handoff_hash !== hash) throw new AppError(409,'idempotency_conflict');
        return summary(c,existing.id);
      }
      if (!await hasChannelAccess(c,actor,workspace,input.source.channel_id)) throw notFound();
      const [channel] = await c.select().from(s.channels).where(eq(s.channels.id,input.source.channel_id));
      const rows = await c.execute<SidekickContext['messages'][number] & Record<string, unknown>>(sql`SELECT m.id,m.thread_id,m.text,m.created_at::text,
        coalesce(u.display_name,d.name,'Agent') AS author,
        coalesce((SELECT jsonb_agg(file->>'name') FROM jsonb_array_elements(m.attachments) file),'[]'::jsonb) AS files
        FROM messages m LEFT JOIN users u ON u.id=m.user_id LEFT JOIN agent_installations i ON i.id=m.installation_id LEFT JOIN agent_definitions d ON d.id=i.definition_id
        WHERE m.workspace_id=${workspace} AND m.channel_id=${input.source.channel_id} AND m.agent_session_id IS NULL
          ${input.source.thread_id ? sql`AND m.thread_id=${input.source.thread_id}` : sql`AND m.id=ANY(${sql.param(input.source.message_ids)}::uuid[])`}
        ORDER BY m.sequence LIMIT 51`);
      if (!rows.rows.length || (input.source.message_ids && rows.rows.length !== input.source.message_ids.length)) throw notFound();
      const context = parseSidekickContext({ channel_id: channel!.id, channel_name: channel!.kind === 'direct' ? 'Direct conversation' : channel!.name,
        ...(input.source.thread_id ? {thread_id:input.source.thread_id} : {}), captured_at:new Date().toISOString(), messages:rows.rows });
      // A self-DM provides immutable participant membership; no agent channel grant is created.
      const [home] = await c.select().from(s.channels).where(and(eq(s.channels.workspace_id,workspace),eq(s.channels.kind,'direct'),eq(s.channels.direct_user_low,actor),eq(s.channels.direct_user_high,actor)));
      const channelId = home?.id ?? randomUUID();
      if (!home) {
        await c.insert(s.channels).values({id:channelId,workspace_id:workspace,name:'Direct message',private:true,kind:'direct',direct_user_low:actor,direct_user_high:actor,created_by:actor});
        await c.insert(s.channelMembers).values({workspace_id:workspace,channel_id:channelId,user_id:actor});
        await c.execute(sql`INSERT INTO direct_message_views(workspace_id,channel_id,user_id,hidden) VALUES(${workspace},${channelId},${actor},true)`);
      }
      const thread = randomUUID();
      await c.insert(s.threads).values({id:thread,workspace_id:workspace,channel_id:channelId});
      await c.insert(s.agentSessions).values({id:input.client_session_id,workspace_id:workspace,installation_id:input.installation_id,origin_thread_id:thread,
        title:context.messages[0]!.text.trim().slice(0,120) || `Discussion from ${context.channel_name}`,managed:true,created_by:actor,skill:input.skill,handoff_context:context,handoff_hash:hash});
      return summary(c,input.client_session_id);
    });
  }
}
