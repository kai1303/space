import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { and, eq, exists, getTableColumns, or } from 'drizzle-orm';
import { AppError, parseDefinitionInput, parseInstallationInput, parseGrantInput, uuid, type AgentDefinition, type AgentInstallation, type AgentGrant } from '@space/contracts';
import { database, type DbSession } from './database.js';
import { agentDefinitions as d, agentInstallations as i, agentGrants as g, channelMembers as m, channels, foundationEvents } from './schema.js';
import { requireWorkspaceAccess, hasChannelAccess, lockWorkspace } from './access.js';
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
    return this.db.transaction(async c => {
      // Serialize creation with offboarding so removal cannot miss a new agent.
      await lockWorkspace(c, request.workspace_id);
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
        .where(and(eq(i.workspace_id, workspace), or(eq(i.owner_id, actor), exists(shared)))).orderBy(i.id).limit(200);
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
      // Removing authority remains possible after the owner leaves a channel.
      const result = await c.delete(g).where(and(eq(g.workspace_id, installation.workspace_id), eq(g.installation_id, id), eq(g.channel_id, request.channel_id), eq(g.skill, request.skill))).returning();
      if (result.length) await this.audit(c, actor, installation, 'grant.revoked', request);
    });
  }
  private async audit(c: DbSession, actor: string, installation: AgentInstallation, type: string, payload: object): Promise<void> {
    await c.insert(foundationEvents).values({ id: randomUUID(), workspace_id: installation.workspace_id, installation_id: installation.id, actor_id: actor, type, payload });
  }
}
