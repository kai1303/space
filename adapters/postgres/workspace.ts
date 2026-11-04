import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { and, eq, gt, getTableColumns, sql } from 'drizzle-orm';
import {
  AppError, parseWorkspaceInput, parseMemberInput, parseRoleInput, parsePage, uuid,
} from '@space/contracts';
import { database, type DbSession } from './database.js';
import { requireWorkspaceAccess } from './access.js';
import { page, canManage } from './membership.js';
import { users as u, workspaces as w, workspaceMembers as m, channelMembers, agentInstallations, workspaceEvents } from './schema.js';

const memberKey = (workspace: string, user: string) => and(eq(m.workspace_id, workspace), eq(m.user_id, user));
const notFound = () => new AppError(404, 'not_found');
export class WorkspaceStore {
  readonly db;
  constructor(readonly pool: Pool) { this.db = database(pool); }

  async create(actor: string, input: unknown) {
    const request = parseWorkspaceInput(input);
    return this.db.transaction(async c => {
      if (!(await c.select({ id: u.id }).from(u).where(eq(u.id, uuid(actor)))).length) throw notFound();
      const [workspace] = await c.insert(w).values({ id: randomUUID(), ...request }).returning();
      await c.insert(m).values({ workspace_id: workspace!.id, user_id: actor, role: 'owner' });
      await this.audit(c, actor, workspace!.id, 'workspace.created', request);
      return { ...workspace!, role: 'owner' as const };
    });
  }
  async list(actor: string, query: unknown = {}) {
    const { after, limit } = parsePage(query);
    const rows = await this.db.select({ ...getTableColumns(w), role: m.role }).from(w)
      .innerJoin(m, eq(m.workspace_id, w.id))
      .where(and(eq(m.user_id, uuid(actor)), eq(m.active, true), after ? gt(w.id, after) : undefined))
      .orderBy(w.id).limit(limit + 1);
    return page(rows, limit, row => row.id);
  }
  async read(actor: string, workspace: string) {
    const [row] = await this.db.select({ ...getTableColumns(w), role: m.role }).from(w)
      .innerJoin(m, eq(m.workspace_id, w.id))
      .where(and(eq(w.id, uuid(workspace)), eq(m.user_id, uuid(actor)), eq(m.active, true)));
    if (!row) throw notFound();
    return row;
  }
  async rename(actor: string, workspace: string, input: unknown) {
    const request = parseWorkspaceInput(input);
    return this.db.transaction(async c => {
      const { workspace: row, membership } = await this.lock(c, actor, workspace);
      if (membership.role === 'member') throw new AppError(403, 'workspace_management_forbidden');
      if (row.name !== request.name) {
        await c.update(w).set(request).where(eq(w.id, workspace));
        await this.audit(c, actor, workspace, 'workspace.renamed', request);
      }
      return { ...row, ...request, role: membership.role };
    });
  }
  async members(actor: string, workspace: string, query: unknown = {}) {
    const { after, limit } = parsePage(query);
    return this.db.transaction(async c => {
      await requireWorkspaceAccess(c, actor, workspace);
      const rows = await c.select({ user_id: m.user_id, display_name: u.display_name, role: m.role, joined_at: m.joined_at })
        .from(m).innerJoin(u, eq(u.id, m.user_id))
        .where(and(eq(m.workspace_id, workspace), eq(m.active, true), after ? gt(m.user_id, after) : undefined))
        .orderBy(m.user_id).limit(limit + 1);
      return page(rows, limit, row => row.user_id);
    });
  }
  async addMember(actor: string, workspace: string, input: unknown) {
    const request = parseMemberInput(input);
    return this.db.transaction(async c => {
      const { membership } = await this.lock(c, actor, workspace);
      const [existing] = await c.select().from(m).where(memberKey(workspace, request.user_id));
      canManage(membership.role, existing?.active ? existing.role : 'member', request.role);
      if (existing?.active) {
        if (existing.role !== request.role) throw new AppError(409, 'member_already_exists');
        return existing;
      }
      if (!(await c.select({ id: u.id }).from(u).where(eq(u.id, request.user_id))).length) throw notFound();
      const [member] = await c.insert(m).values({ workspace_id: workspace, ...request })
        .onConflictDoUpdate({ target: [m.workspace_id, m.user_id], set: { role: request.role, active: true, joined_at: new Date() } }).returning();
      await this.audit(c, actor, workspace, 'member.added', request);
      return member!;
    });
  }
  async changeRole(actor: string, workspace: string, user: string, input: unknown) {
    user = uuid(user);
    const { role } = parseRoleInput(input);
    return this.db.transaction(async c => {
      const { membership } = await this.lock(c, actor, workspace);
      const target = await this.member(c, workspace, user);
      canManage(membership.role, target.role, role);
      if (target.role === role) return target;
      if (target.role === 'owner') await this.requireAnotherOwner(c, workspace, user);
      const [result] = await c.update(m).set({ role }).where(memberKey(workspace, user)).returning();
      await this.audit(c, actor, workspace, 'member.role_changed', { user_id: user, previous_role: target.role, role });
      return result!;
    });
  }
  async removeMember(actor: string, workspace: string, user: string): Promise<void> {
    user = uuid(user);
    await this.db.transaction(async c => {
      const { membership } = await this.lock(c, actor, workspace);
      const [target] = await c.select().from(m).where(memberKey(workspace, user));
      if (!target) throw notFound();
      if (actor !== user) canManage(membership.role, target.active ? target.role : 'member');
      if (!target.active) return;
      if (target.role === 'owner') await this.requireAnotherOwner(c, workspace, user);
      await c.update(agentInstallations).set({ enabled: false })
        .where(and(eq(agentInstallations.workspace_id, workspace), eq(agentInstallations.owner_id, user)));
      await c.delete(channelMembers).where(and(eq(channelMembers.workspace_id, workspace), eq(channelMembers.user_id, user), sql`NOT EXISTS (SELECT 1 FROM channels ch WHERE ch.id=${channelMembers.channel_id} AND ch.kind='direct')`));
      await c.update(m).set({ active: false }).where(memberKey(workspace, user));
      await this.audit(c, actor, workspace, 'member.removed', { user_id: user, previous_role: target.role });
    });
  }
  private async member(c: DbSession, workspace: string, user: string) {
    const [row] = await c.select().from(m).where(and(memberKey(workspace, user), eq(m.active, true)));
    if (!row) throw notFound();
    return row;
  }
  private async lock(c: DbSession, actor: string, workspace: string) {
    // One exclusive workspace lock protects membership and last-owner checks.
    const [row] = await c.select().from(w).where(eq(w.id, uuid(workspace))).for('update');
    if (!row) throw notFound();
    return { workspace: row, membership: await this.member(c, workspace, uuid(actor)) };
  }

  private async requireAnotherOwner(c: DbSession, workspace: string, user: string) {
    const owners = await c.select({ user_id: m.user_id }).from(m)
      .where(and(eq(m.workspace_id, workspace), eq(m.active, true), eq(m.role, 'owner')));
    if (!owners.some(owner => owner.user_id !== user)) throw new AppError(409, 'last_owner');
  }
  private async audit(c: DbSession, actor: string, workspace: string, type: string, payload: object) {
    await c.insert(workspaceEvents).values({ id: randomUUID(), workspace_id: workspace, actor_id: actor, type, payload });
  }
}
