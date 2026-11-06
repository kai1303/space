import { page } from './membership.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { AppError, localProviders, defaultPairedConnectors, parseCapabilities, text, type PairedConnector, type ChannelAgent, connectionSecret, parsePairing, parsePairingClaim, parseAgentHeartbeat, parsePage, uuid, type WorkspaceParticipant, type AgentPairingStatus } from '@space/contracts';
import { database } from './database.js';
import { hasChannelAccess, hasWorkspaceAccess, requireWorkspaceAccess } from './access.js';
import { visibleWorkspacePeer } from './workspace-access.js';
import * as s from './schema.js';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const unauthorized = () => new AppError(401, 'unauthorized');
import { sessionTransaction } from './session-concurrency.js';
export class AgentConnectionStore {
  readonly db;
  readonly connectors: PairedConnector[];
  constructor(readonly pool: Pool, options: { connectors?: PairedConnector[] } = {}) {
    this.db = database(pool);
    this.connectors = (options.connectors ?? defaultPairedConnectors).map(entry => {
      const id = text(entry.id, 80);
      if (!/^[a-z][a-z0-9._-]*$/.test(id)) throw new AppError(400, 'invalid_connector_id');
      return { id, definition_id: uuid(entry.definition_id), name: text(entry.name, 100), capabilities: parseCapabilities(entry.capabilities), ...(entry.provider ? { provider: entry.provider } : {}) };
    });
    if (new Set(this.connectors.map(entry => entry.id)).size !== this.connectors.length || new Set(this.connectors.map(entry => entry.definition_id)).size !== this.connectors.length || this.connectors.length > 100) throw new AppError(400, 'duplicate_connector');
  }
  async createPairing(actor: string, workspace: string, raw: unknown) {
    const input = parsePairing(raw), code = randomBytes(24).toString('base64url');
    const descriptor = this.connectors.find(entry => entry.id === (input.connector_id ?? localProviders[input.provider].connector));
    if (!descriptor) throw new AppError(400, 'unknown_connector');
    return sessionTransaction(this.db, async c => {
      await requireWorkspaceAccess(c, actor, workspace);
      const [owner] = await c.select({ name: s.users.display_name }).from(s.users).where(eq(s.users.id, actor));
      await c.update(s.agentPairings).set({ cancelled_at: new Date() }).where(and(eq(s.agentPairings.workspace_id, workspace), eq(s.agentPairings.owner_id, actor), eq(s.agentPairings.connector_id, descriptor.id), isNull(s.agentPairings.installation_id), isNull(s.agentPairings.cancelled_at)));
      const [row] = await c.insert(s.agentPairings).values({ id: randomUUID(), workspace_id: workspace, owner_id: actor,
        provider: descriptor.provider ?? null, connector_id: descriptor.id, descriptor, name: input.name ?? `${owner!.name.slice(0, 80)}’s ${descriptor.name}`, code_hash: hash(code), expires_at: new Date(Date.now() + 600_000) }).returning();
      return { id: row!.id, code, connector_id: descriptor.id, ...(descriptor.provider ? { provider: descriptor.provider } : {}), expires_at: row!.expires_at.toISOString() };
    });
  }
  async pairingStatus(actor: string, id: string): Promise<AgentPairingStatus> {
    const [row] = await this.db.select().from(s.agentPairings).where(eq(s.agentPairings.id, uuid(id)));
    if (!row) throw new AppError(404, 'not_found');
    await requireWorkspaceAccess(this.db, actor, row.workspace_id);
    if (row.owner_id !== actor) throw new AppError(403, 'pairing_not_owned');
    return { id: row.id, status: row.installation_id ? 'claimed' : row.cancelled_at ? 'cancelled' : row.expires_at.getTime() <= Date.now() ? 'expired' : 'pending', installation_id: row.installation_id, expires_at: row.expires_at.toISOString() };
  }
  async cancelPairing(actor: string, id: string) {
    await this.pairingStatus(actor, id);
    await this.db.update(s.agentPairings).set({ cancelled_at: new Date() }).where(and(eq(s.agentPairings.id, id), isNull(s.agentPairings.installation_id)));
    return this.pairingStatus(actor, id);
  }
  async claim(raw: unknown) {
    const { code, credential, provider } = parsePairingClaim(raw);
    return sessionTransaction(this.db, async c => {
      const [ref] = await c.select().from(s.agentPairings).where(eq(s.agentPairings.code_hash, hash(code)));
      if (!ref) throw unauthorized();
      const [pairing] = await c.select().from(s.agentPairings).where(eq(s.agentPairings.id, ref.id));
      if (!pairing || pairing.cancelled_at || !await hasWorkspaceAccess(c, pairing.owner_id, pairing.workspace_id)) throw unauthorized();
      // Legacy Codex clients omit provider; other local providers must identify themselves.
      if ((provider !== undefined && pairing.provider !== provider) || (provider === undefined && pairing.provider != null && pairing.provider !== 'codex')) throw new AppError(409, 'provider_mismatch');
      const definition = pairing.descriptor ?? this.connectors.find(entry => entry.id === pairing.connector_id);
      if (!definition || !this.connectors.some(entry => entry.id === definition.id)) throw new AppError(409, 'unknown_connector');
      if (pairing.installation_id) {
        const [existing] = await c.select().from(s.agentConnections).innerJoin(s.agentInstallations, eq(s.agentInstallations.id, s.agentConnections.installation_id))
          .where(and(eq(s.agentConnections.installation_id, pairing.installation_id), eq(s.agentConnections.token_hash, hash(credential)), isNull(s.agentConnections.revoked_at), eq(s.agentInstallations.enabled, true)));
        if (!existing) throw unauthorized();
        return { installation_id: pairing.installation_id, workspace_id: pairing.workspace_id, connector_id: definition.id, ...(definition.provider ? { provider: definition.provider } : {}) };
      }
      if (pairing.expires_at.getTime() <= Date.now()) throw unauthorized();
      const definitionName = definition.provider ? `Local ${definition.name}` : definition.name;
      await c.insert(s.agentDefinitions).values({ id: definition.definition_id, name: definitionName, capabilities: definition.capabilities }).onConflictDoNothing({ target: s.agentDefinitions.id });
      const matching = await c.select({ id: s.agentDefinitions.id }).from(s.agentDefinitions).where(and(eq(s.agentDefinitions.id, definition.definition_id), eq(s.agentDefinitions.name, definitionName), sql`${s.agentDefinitions.capabilities}=${JSON.stringify(definition.capabilities)}::jsonb`));
      if (!matching.length) throw new AppError(409, 'connector_definition_conflict');
      const installation_id = randomUUID();
      await c.insert(s.agentInstallations).values({ id: installation_id, workspace_id: pairing.workspace_id, owner_id: pairing.owner_id, definition_id: definition.definition_id, connector_id: definition.id });
      await c.insert(s.agentConnections).values({ installation_id, name: pairing.name, token_hash: hash(credential) });
      await c.update(s.agentPairings).set({ installation_id }).where(eq(s.agentPairings.id, pairing.id));
      await c.insert(s.foundationEvents).values({ id: randomUUID(), workspace_id: pairing.workspace_id, installation_id, actor_id: pairing.owner_id, type: 'connection.paired', payload: {} });
      return { installation_id, workspace_id: pairing.workspace_id, connector_id: definition.id, ...(definition.provider ? { provider: definition.provider } : {}) };
    });
  }
  async participants(actor: string, workspace: string, raw: unknown = {}) {
    const { limit, after } = parsePage(raw);
    return sessionTransaction(this.db, async c => {
      await requireWorkspaceAccess(c, actor, workspace);
      const humans = await c.select({ id: s.users.id, name: s.users.display_name }).from(s.workspaceMembers)
        .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.user_id))
        .where(and(eq(s.workspaceMembers.workspace_id, workspace), eq(s.workspaceMembers.active, true), visibleWorkspacePeer(workspace, actor, sql`${s.users.id}`), after ? gt(s.users.id, after) : undefined)).orderBy(s.users.id).limit(limit + 1);
      const agents = await c.select({ id: s.agentInstallations.id, name: s.agentConnections.name, owner_id: s.agentInstallations.owner_id,
        connector_id: s.agentInstallations.connector_id, auth_status: s.agentConnections.auth_status, connection_id: s.agentConnections.connection_id, last_seen_at: s.agentConnections.last_seen_at }).from(s.agentConnections)
        .innerJoin(s.agentInstallations, eq(s.agentInstallations.id, s.agentConnections.installation_id))
        .innerJoin(s.workspaceMembers, and(eq(s.workspaceMembers.workspace_id, s.agentInstallations.workspace_id), eq(s.workspaceMembers.user_id, s.agentInstallations.owner_id)))
        .where(and(eq(s.agentInstallations.workspace_id, workspace), eq(s.agentInstallations.enabled, true), isNull(s.agentConnections.revoked_at), eq(s.workspaceMembers.active, true), visibleWorkspacePeer(workspace, actor, sql`${s.agentInstallations.owner_id}`), after ? gt(s.agentInstallations.id, after) : undefined)).orderBy(s.agentInstallations.id).limit(limit + 1);
      const items: WorkspaceParticipant[] = [...humans.map(h => ({ ...h, kind: 'human' as const })), ...agents.map(a => ({ id: a.id, name: a.name, owner_id: a.owner_id, kind: 'agent' as const, ...(this.connectors.find(entry => entry.id === a.connector_id)?.provider ? { provider: this.connectors.find(entry => entry.id === a.connector_id)!.provider } : {}), auth_status: a.auth_status,
        status: (!a.connection_id || !a.last_seen_at || Date.now() - a.last_seen_at.getTime() > 45_000 ? 'offline' : a.auth_status === 'ready' ? 'online' : a.auth_status === 'required' ? 'auth_required' : 'error') as WorkspaceParticipant['status'],
      }))].sort((a, b) => a.id.localeCompare(b.id));
      return page(items, limit, item => item.id);
    });
  }
  async authenticate(token: unknown) {
    try { connectionSecret(token, 43); } catch { throw unauthorized(); }
    const [row] = await this.db.select({ id: s.agentConnections.installation_id, owner_id: s.agentInstallations.owner_id, workspace_id: s.agentInstallations.workspace_id })
      .from(s.agentConnections).innerJoin(s.agentInstallations, eq(s.agentInstallations.id, s.agentConnections.installation_id))
      .where(and(eq(s.agentConnections.token_hash, hash(token as string)), isNull(s.agentConnections.revoked_at), eq(s.agentInstallations.enabled, true)));
    if (!row || !await hasWorkspaceAccess(this.db, row.owner_id, row.workspace_id)) throw unauthorized();
    return row;
  }
  async connect(token: unknown) {
    const identity = await this.authenticate(token), connection_id = randomUUID();
    const rows = await this.db.update(s.agentConnections).set({ connection_id, last_seen_at: new Date(), auth_status: 'required' })
      .where(and(eq(s.agentConnections.installation_id, identity.id), eq(s.agentConnections.token_hash, hash(token as string)), isNull(s.agentConnections.revoked_at))).returning();
    if (!rows.length) throw unauthorized();
    return { ...identity, connection_id };
  }
  async authenticateConnection(token: unknown, connection: string) {
    const identity = await this.authenticate(token);
    const [row] = await this.db.select().from(s.agentConnections).where(and(eq(s.agentConnections.installation_id, identity.id), eq(s.agentConnections.connection_id, connection)));
    if (!row) throw unauthorized();
    if (row.auth_status !== 'ready' || !row.last_seen_at || row.last_seen_at.getTime() <= Date.now() - 45_000) throw new AppError(409, 'agent_not_ready');
    return identity;
  }
  async channelAgents(actor: string, channelId: string) {
    const [channel] = await this.db.select().from(s.channels).where(eq(s.channels.id, uuid(channelId)));
    if (!channel || !await hasChannelAccess(this.db, actor, channel.workspace_id, channel.id)) throw new AppError(404, 'not_found');
    if (channel.archived_at) return [];
    const rows = (await this.db.execute<ChannelAgent & Record<string, unknown>>(sql`
      SELECT i.id,coalesce(ac.name,d.name) AS name,i.connector_id,d.capabilities->'skills' AS skills,
        ac.installation_id IS NOT NULL AS inherits_owner_access,
        CASE WHEN ac.installation_id IS NOT NULL THEN d.capabilities->'skills' ELSE coalesce((SELECT jsonb_agg(g.skill ORDER BY g.skill) FROM agent_grants g WHERE g.installation_id=i.id AND g.channel_id=${channel.id} AND d.capabilities->'skills' ? g.skill),'[]'::jsonb) END AS granted_skills,
        coalesce((d.capabilities->>'persistent_sessions')::boolean,false) AS persistent_sessions
      FROM agent_installations i JOIN agent_definitions d ON d.id=i.definition_id LEFT JOIN agent_connections ac ON ac.installation_id=i.id
      WHERE i.workspace_id=${channel.workspace_id} AND i.owner_id=${actor} AND i.enabled AND ac.revoked_at IS NULL AND (${channel.kind !== 'direct'} OR ac.installation_id IS NOT NULL) ORDER BY i.id LIMIT 100`)).rows;
    return rows.map(row => ({ ...row, enabled_in_channel: row.granted_skills.length > 0, ...(this.connectors.find(entry => entry.id === row.connector_id)?.provider ? { provider: this.connectors.find(entry => entry.id === row.connector_id)!.provider } : {}) }));
  }
  async setChannelEnabled(actor: string, id: string, channelId: string, enabled: boolean, selectedSkill?: string) {
    if (typeof enabled !== 'boolean') throw new AppError(400, 'invalid_enabled');
    if (selectedSkill !== undefined) text(selectedSkill, 80);
    return sessionTransaction(this.db, async c => {
      const [ref] = await c.select().from(s.agentInstallations).where(eq(s.agentInstallations.id, uuid(id)));
      if (!ref) throw new AppError(404, 'not_found');
      await requireWorkspaceAccess(c, actor, ref.workspace_id);
      if (ref.owner_id !== actor) throw new AppError(403, 'installation_not_owned');
      const [channel] = await c.select().from(s.channels).where(and(eq(s.channels.id, uuid(channelId)), eq(s.channels.workspace_id, ref.workspace_id)));
      if (!channel || !await hasChannelAccess(c, actor, ref.workspace_id, channel.id)) throw new AppError(404, 'not_found');
      if (enabled && channel.archived_at) throw new AppError(409, 'channel_archived');
      const [connection] = await c.select().from(s.agentConnections).where(eq(s.agentConnections.installation_id, id));
      if (!ref.enabled || connection?.revoked_at) throw new AppError(409, 'agent_unavailable');
      const [definition] = await c.select().from(s.agentDefinitions).where(eq(s.agentDefinitions.id, ref.definition_id));
      const supported = definition!.capabilities.skills;
      if (connection) {
        if (selectedSkill !== undefined && !supported.includes(selectedSkill)) throw new AppError(400, 'skill_not_supported');
        if (!enabled) throw new AppError(409, 'agent_inherits_owner_access');
        return { enabled_in_channel: supported.length > 0, granted_skills: [...supported].sort(), inherits_owner_access: true };
      }
      if (channel.kind === 'direct') throw new AppError(403, 'direct_message_agents_forbidden');
      if (selectedSkill === undefined && supported.length !== 1) throw new AppError(400, 'skill_required');
      if (selectedSkill !== undefined && !supported.includes(selectedSkill)) throw new AppError(400, 'skill_not_supported');
      for (const skill of selectedSkill === undefined ? supported : [selectedSkill]) {
        const grant = { installation_id: id, workspace_id: ref.workspace_id, channel_id: channel.id, skill };
        const changed = enabled
          ? await c.insert(s.agentGrants).values(grant).onConflictDoNothing().returning()
          : await c.delete(s.agentGrants).where(and(eq(s.agentGrants.installation_id, id), eq(s.agentGrants.channel_id, channel.id), eq(s.agentGrants.skill, skill))).returning();
        if (changed.length) await c.insert(s.foundationEvents).values({ id: randomUUID(), workspace_id: ref.workspace_id, installation_id: id, actor_id: actor, type: enabled ? 'grant.created' : 'grant.revoked', payload: { channel_id: channel.id, skill } });
      }
      const grants = await c.select({ skill: s.agentGrants.skill }).from(s.agentGrants).where(and(eq(s.agentGrants.installation_id, id), eq(s.agentGrants.channel_id, channel.id)));
      return { enabled_in_channel: grants.some(grant => supported.includes(grant.skill)), granted_skills: grants.map(grant => grant.skill).filter(skill => supported.includes(skill)).sort() };
    });
  }
  async heartbeat(token: unknown, connection: string, raw: unknown) {
    const auth_status = parseAgentHeartbeat(raw), identity = await this.authenticate(token);
    const rows = await this.db.update(s.agentConnections).set({ auth_status, last_seen_at: new Date() }).where(and(eq(s.agentConnections.installation_id, identity.id), eq(s.agentConnections.connection_id, connection), eq(s.agentConnections.token_hash, hash(token as string)), isNull(s.agentConnections.revoked_at))).returning({ id: s.agentConnections.installation_id });
    if (!rows.length) throw unauthorized();
    return { installation_id: identity.id };
  }
  async disconnect(id: string, connection: string) {
    await this.db.update(s.agentConnections).set({ connection_id: null }).where(and(eq(s.agentConnections.installation_id, id), eq(s.agentConnections.connection_id, connection)));
  }
  async revoke(actor: string, id: string) {
    return sessionTransaction(this.db, async c => {
      const [ref] = await c.select().from(s.agentInstallations).where(eq(s.agentInstallations.id, uuid(id)));
      if (!ref) throw new AppError(404, 'not_found');
      await requireWorkspaceAccess(c, actor, ref.workspace_id);
      const [installation] = await c.select().from(s.agentInstallations).where(eq(s.agentInstallations.id, id));
      if (installation!.owner_id !== actor) throw new AppError(403, 'installation_not_owned');
      const rows = await c.update(s.agentConnections).set({ revoked_at: new Date(), token_hash: null, connection_id: null }).where(and(eq(s.agentConnections.installation_id, id), isNull(s.agentConnections.revoked_at))).returning();
      if (rows.length) {
        await c.update(s.agentInstallations).set({ enabled: false }).where(eq(s.agentInstallations.id, id));
        await c.insert(s.foundationEvents).values({ id: randomUUID(), workspace_id: ref.workspace_id, installation_id: id, actor_id: actor, type: 'connection.revoked', payload: {} });
      }
      return { revoked: true };
    });
  }
}
