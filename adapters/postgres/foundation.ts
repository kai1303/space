import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { and, eq, exists, getTableColumns, or, sql } from 'drizzle-orm';
import { AppError, parseDefinitionInput, parseInstallationInput, parseGrantInput, uuid, type AgentDefinition, type AgentInstallation, type AgentGrant } from '@space/contracts';
import { database, type DbSession } from './database.js';
import { agentDefinitions as d, agentInstallations as i, agentGrants as g, channelMembers as m, channels, foundationEvents, agentConnections } from './schema.js';
import { requireWorkspaceAccess, hasChannelAccess } from './access.js';
import { sessionTransaction } from './session-concurrency.js';
const installationColumns = { ...getTableColumns(i), capabilities: d.capabilities };
export class FoundationStore {
  readonly db;
  constructor(readonly pool: Pool) { this.db = database(pool); }

  // Trusted operator API. Definitions are immutable, public templates, never credentials.
  async publishDefinition(input: unknown): Promise<AgentDefinition> {
    return (await this.db.insert(d).values({ id: randomUUID(), ...parseDefinitionInput(input) }).returning())[0]!;
  }
  async install(actor: string, input: unknown): Promise<AgentInstallation> {
    const request = parseInstallationInput(input);
    return sessionTransaction(this.db, async c => {
      // Retry against current membership when installation races offboarding.
      await requireWorkspaceAccess(c, actor, request.workspace_id);
      const definition = (await c.select().from(d).where(eq(d.id, request.definition_id)))[0];
      if (!definition) throw new AppError(404, 'not_found');
      const [row] = await c.insert(i).values({ id: randomUUID(), ...request, owner_id: actor }).returning();
      const installation = { ...row!, capabilities: definition.capabilities };
      await this.audit(c, actor, installation, 'installation.created', {});
      return installation;
    });
  }
  async list(actor: string, workspace: string): Promise<AgentInstallation[]> {
    return this.db.transaction(async c => {
      await requireWorkspaceAccess(c, actor, workspace);
      const shared = c.select({ installation_id: g.installation_id }).from(g)
        .innerJoin(m, and(eq(m.workspace_id, g.workspace_id), eq(m.channel_id, g.channel_id)))
        .where(and(eq(g.installation_id, i.id), eq(m.user_id, actor)));
      return c.select(installationColumns).from(i).innerJoin(d, eq(d.id, i.definition_id))
        .where(and(eq(i.workspace_id, workspace), or(eq(i.owner_id, actor), exists(shared), sql`EXISTS(SELECT 1 FROM agent_connections ac JOIN workspace_members wm ON wm.workspace_id=${i.workspace_id} AND wm.user_id=${i.owner_id} AND wm.active WHERE ac.installation_id=${i.id} AND ac.revoked_at IS NULL AND EXISTS(SELECT 1 FROM channel_members owner_channel JOIN channel_members viewer_channel ON viewer_channel.workspace_id=owner_channel.workspace_id AND viewer_channel.channel_id=owner_channel.channel_id WHERE owner_channel.workspace_id=${i.workspace_id} AND owner_channel.user_id=${i.owner_id} AND viewer_channel.user_id=${actor}))`))).orderBy(i.id).limit(200);
    });
  }
  private async owned(c: DbSession, actor: string, id: string): Promise<AgentInstallation> {
    const installation = (await c.select(installationColumns).from(i).innerJoin(d, eq(d.id, i.definition_id))
      .where(eq(i.id, uuid(id))).for('update', { of: i }))[0];
    if (!installation) throw new AppError(404, 'not_found');
    await requireWorkspaceAccess(c, actor, installation.workspace_id);
    if (installation.owner_id !== actor) throw new AppError(403, 'installation_not_owned');
    return installation;
  }
  async setEnabled(actor: string, id: string, enabled: boolean): Promise<AgentInstallation> {
    if (typeof enabled !== 'boolean') throw new AppError(400, 'invalid_enabled');
    return this.db.transaction(async c => {
      const installation = await this.owned(c, actor, id);
      if (installation.enabled === enabled) return installation;
      await c.update(i).set({ enabled }).where(eq(i.id, id));
      await this.audit(c, actor, installation, enabled ? 'installation.enabled' : 'installation.disabled', {});
      return { ...installation, enabled };
    });
  }
  async grant(actor: string, id: string, input: unknown): Promise<AgentGrant> {
    const request = parseGrantInput(input);
    return this.db.transaction(async c => {
      const installation = await this.owned(c, actor, id);
      if ((await c.select({id:agentConnections.installation_id}).from(agentConnections).where(eq(agentConnections.installation_id,id))).length) throw new AppError(409, 'agent_inherits_owner_access');
      if (!await hasChannelAccess(c, actor, installation.workspace_id, request.channel_id)) throw new AppError(404, 'not_found');
      const [channel] = await c.select({ kind: channels.kind }).from(channels).where(eq(channels.id, request.channel_id));
      if (channel?.kind === 'direct') throw new AppError(403, 'direct_message_agents_forbidden');
      if (!installation.capabilities.skills.includes(request.skill)) throw new AppError(400, 'skill_unsupported');
      const grant = { ...request, workspace_id: installation.workspace_id, installation_id: installation.id };
      const result = await c.insert(g).values(grant).onConflictDoNothing().returning();
      if (result.length) await this.audit(c, actor, installation, 'grant.created', request);
      return grant;
    });
  }
  async revoke(actor: string, id: string, input: unknown): Promise<void> {
    const request = parseGrantInput(input);
    await this.db.transaction(async c => {
      const installation = await this.owned(c, actor, id);
      if ((await c.select({id:agentConnections.installation_id}).from(agentConnections).where(eq(agentConnections.installation_id,id))).length) throw new AppError(409, 'agent_inherits_owner_access');
      // Removing authority remains possible after the owner leaves a channel.
      const result = await c.delete(g).where(and(eq(g.workspace_id, installation.workspace_id), eq(g.installation_id, id), eq(g.channel_id, request.channel_id), eq(g.skill, request.skill))).returning();
      if (result.length) await this.audit(c, actor, installation, 'grant.revoked', request);
    });
  }
  private async audit(c: DbSession, actor: string, installation: AgentInstallation, type: string, payload: object): Promise<void> {
    await c.insert(foundationEvents).values({ id: randomUUID(), workspace_id: installation.workspace_id, installation_id: installation.id, actor_id: actor, type, payload });
  }
}
