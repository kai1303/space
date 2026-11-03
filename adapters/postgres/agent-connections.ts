import { page } from './membership.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { AppError, connectionSecret, parsePairing, parsePairingClaim, parseAgentHeartbeat, parsePage, uuid, type WorkspaceParticipant, type AgentPairingStatus } from '@space/contracts';
import { database } from './database.js';
import { hasChannelAccess, hasWorkspaceAccess, lockWorkspace, requireWorkspaceAccess } from './access.js';
import * as s from './schema.js';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const unauthorized = () => new AppError(401, 'unauthorized');
const definitionId = '41a5de8a-63df-4c25-8666-1d0290bc921f';
export class AgentConnectionStore {
  readonly db;
  constructor(readonly pool: Pool) { this.db = database(pool); }
  async createPairing(actor: string, workspace: string, raw: unknown) {
    const input = parsePairing(raw), code = randomBytes(24).toString('base64url');
    return this.db.transaction(async c => {
      await lockWorkspace(c, uuid(workspace)); await requireWorkspaceAccess(c, actor, workspace);
      await c.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'pairing:' + workspace + ':' + actor}))`);
      const [owner] = await c.select({ name: s.users.display_name }).from(s.users).where(eq(s.users.id, actor));
      await c.update(s.agentPairings).set({ cancelled_at: new Date() }).where(and(eq(s.agentPairings.workspace_id, workspace), eq(s.agentPairings.owner_id, actor), isNull(s.agentPairings.installation_id), isNull(s.agentPairings.cancelled_at)));
      const [row] = await c.insert(s.agentPairings).values({ id: randomUUID(), workspace_id: workspace, owner_id: actor,
        name: input.name ?? `${owner!.name.slice(0, 80)}’s Codex`, code_hash: hash(code), expires_at: new Date(Date.now() + 600_000) }).returning();
      return { id: row!.id, code, expires_at: row!.expires_at.toISOString() };
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
    const { code, credential } = parsePairingClaim(raw);
    return this.db.transaction(async c => {
      const [ref] = await c.select().from(s.agentPairings).where(eq(s.agentPairings.code_hash, hash(code)));
      if (!ref) throw unauthorized();
      await lockWorkspace(c, ref.workspace_id);
      const [pairing] = await c.select().from(s.agentPairings).where(eq(s.agentPairings.id, ref.id)).for('update');
      if (!pairing || pairing.cancelled_at || !await hasWorkspaceAccess(c, pairing.owner_id, pairing.workspace_id)) throw unauthorized();
      if (pairing.installation_id) {
        const [existing] = await c.select().from(s.agentConnections).innerJoin(s.agentInstallations, eq(s.agentInstallations.id, s.agentConnections.installation_id))
          .where(and(eq(s.agentConnections.installation_id, pairing.installation_id), eq(s.agentConnections.token_hash, hash(credential)), isNull(s.agentConnections.revoked_at), eq(s.agentInstallations.enabled, true)));
        if (!existing) throw unauthorized();
        return { installation_id: pairing.installation_id, workspace_id: pairing.workspace_id };
      }
      if (pairing.expires_at.getTime() <= Date.now()) throw unauthorized();
      await c.insert(s.agentDefinitions).values({ id: definitionId, name: 'Local Codex', capabilities: { skills: ['codex.run'], controls: { progress_stream: true } } }).onConflictDoNothing();
      const installation_id = randomUUID();
      await c.insert(s.agentInstallations).values({ id: installation_id, workspace_id: pairing.workspace_id, owner_id: pairing.owner_id, definition_id: definitionId, connector_id: 'codex.local' });
      await c.insert(s.agentConnections).values({ installation_id, name: pairing.name, token_hash: hash(credential) });
      await c.update(s.agentPairings).set({ installation_id }).where(eq(s.agentPairings.id, pairing.id));
      await c.insert(s.foundationEvents).values({ id: randomUUID(), workspace_id: pairing.workspace_id, installation_id, actor_id: pairing.owner_id, type: 'connection.paired', payload: {} });
      return { installation_id, workspace_id: pairing.workspace_id };
    });
  }
  async participants(actor: string, workspace: string, raw: unknown = {}) {
    const { limit, after } = parsePage(raw);
    return this.db.transaction(async c => {
      await requireWorkspaceAccess(c, actor, workspace);
      const humans = await c.select({ id: s.users.id, name: s.users.display_name }).from(s.workspaceMembers)
        .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.user_id))
        .where(and(eq(s.workspaceMembers.workspace_id, workspace), eq(s.workspaceMembers.active, true), after ? gt(s.users.id, after) : undefined)).orderBy(s.users.id).limit(limit + 1);
      const agents = await c.select({ id: s.agentInstallations.id, name: s.agentConnections.name, owner_id: s.agentInstallations.owner_id,
        auth_status: s.agentConnections.auth_status, connection_id: s.agentConnections.connection_id, last_seen_at: s.agentConnections.last_seen_at }).from(s.agentConnections)
        .innerJoin(s.agentInstallations, eq(s.agentInstallations.id, s.agentConnections.installation_id))
        .innerJoin(s.workspaceMembers, and(eq(s.workspaceMembers.workspace_id, s.agentInstallations.workspace_id), eq(s.workspaceMembers.user_id, s.agentInstallations.owner_id)))
        .where(and(eq(s.agentInstallations.workspace_id, workspace), eq(s.agentInstallations.enabled, true), isNull(s.agentConnections.revoked_at), eq(s.workspaceMembers.active, true), after ? gt(s.agentInstallations.id, after) : undefined)).orderBy(s.agentInstallations.id).limit(limit + 1);
      const items: WorkspaceParticipant[] = [...humans.map(h => ({ ...h, kind: 'human' as const })), ...agents.map(a => ({ id: a.id, name: a.name, owner_id: a.owner_id, kind: 'agent' as const, auth_status: a.auth_status,
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
    return (await this.db.execute<{ id: string; name: string; enabled_in_channel: boolean }>(sql`
      SELECT i.id,ac.name,EXISTS(SELECT 1 FROM agent_grants g WHERE g.installation_id=i.id AND g.channel_id=${channel.id} AND g.skill='codex.run') AS enabled_in_channel
      FROM agent_installations i JOIN agent_connections ac ON ac.installation_id=i.id
      WHERE i.workspace_id=${channel.workspace_id} AND i.owner_id=${actor} AND i.connector_id='codex.local' AND i.enabled AND ac.revoked_at IS NULL ORDER BY i.id LIMIT 100`)).rows;
  }
  async setChannelEnabled(actor: string, id: string, channelId: string, enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new AppError(400, 'invalid_enabled');
    return this.db.transaction(async c => {
      const [ref] = await c.select().from(s.agentInstallations).where(eq(s.agentInstallations.id, uuid(id)));
      if (!ref || ref.connector_id !== 'codex.local') throw new AppError(404, 'not_found');
      await lockWorkspace(c, ref.workspace_id);
      await requireWorkspaceAccess(c, actor, ref.workspace_id);
      const [installation] = await c.select().from(s.agentInstallations).where(eq(s.agentInstallations.id, id)).for('update');
      if (installation!.owner_id !== actor) throw new AppError(403, 'installation_not_owned');
      const [channel] = await c.select().from(s.channels).where(and(eq(s.channels.id, uuid(channelId)), eq(s.channels.workspace_id, ref.workspace_id))).for('share');
      if (!channel || !await hasChannelAccess(c, actor, ref.workspace_id, channel.id)) throw new AppError(404, 'not_found');
      if (enabled && channel.archived_at) throw new AppError(409, 'channel_archived');
      if (!installation!.enabled || !(await c.select().from(s.agentConnections).where(and(eq(s.agentConnections.installation_id, id), isNull(s.agentConnections.revoked_at)))).length) throw new AppError(409, 'agent_unavailable');
      const grant = { installation_id: id, workspace_id: ref.workspace_id, channel_id: channel.id, skill: 'codex.run' };
      const changed = enabled
        ? await c.insert(s.agentGrants).values(grant).onConflictDoNothing().returning()
        : await c.delete(s.agentGrants).where(and(eq(s.agentGrants.installation_id, id), eq(s.agentGrants.channel_id, channel.id), eq(s.agentGrants.skill, 'codex.run'))).returning();
      if (changed.length) await c.insert(s.foundationEvents).values({ id: randomUUID(), workspace_id: ref.workspace_id, installation_id: id, actor_id: actor, type: enabled ? 'grant.created' : 'grant.revoked', payload: { channel_id: channel.id, skill: 'codex.run' } });
      return { enabled_in_channel: enabled };
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
    return this.db.transaction(async c => {
      const [ref] = await c.select().from(s.agentInstallations).where(eq(s.agentInstallations.id, uuid(id)));
      if (!ref) throw new AppError(404, 'not_found');
      await lockWorkspace(c, ref.workspace_id); await requireWorkspaceAccess(c, actor, ref.workspace_id);
      const [installation] = await c.select().from(s.agentInstallations).where(eq(s.agentInstallations.id, id)).for('update');
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
