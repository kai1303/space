import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { and, eq, gt, getTableColumns, sql } from 'drizzle-orm';
import {
  AppError, parseWorkspaceInput, parseWorkspaceMemberInput, parseRoleInput, parsePage, parseDirectoryQuery, uuid, record,
} from '@space/contracts';
import { sessionTransaction } from './session-concurrency.js';
import { visibleWorkspacePeer } from './workspace-access.js';
import { readWorkspacePreferences, joinDefaultChannels } from './workspace-settings.js';
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
      return { ...workspace!, primary_owner_id: actor, role: 'owner' as const };
    });
  }
  async list(actor: string, query: unknown = {}) {
    const { after, limit } = parsePage(query);
    const rows = await this.db.select({ ...getTableColumns(w), role: m.role, guest_type:m.guest_type, icon_url:sql<string|null>`(SELECT icon_url FROM workspace_preferences WHERE workspace_id=${w.id})` }).from(w)
      .innerJoin(m, eq(m.workspace_id, w.id))
      .where(and(eq(m.user_id, uuid(actor)), eq(m.active, true), after ? gt(w.id, after) : undefined))
      .orderBy(w.id).limit(limit + 1);
    return page(rows, limit, row => row.id);
  }
  async read(actor: string, workspace: string) {
    const [row] = await this.db.select({ ...getTableColumns(w), role: m.role, guest_type:m.guest_type, icon_url:sql<string|null>`(SELECT icon_url FROM workspace_preferences WHERE workspace_id=${w.id})` }).from(w)
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
        await c.execute(sql`INSERT INTO workspace_preferences(workspace_id,revision) VALUES(${workspace},1) ON CONFLICT(workspace_id) DO UPDATE SET revision=workspace_preferences.revision+1`);
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
        .where(and(eq(m.workspace_id, workspace), eq(m.active, true), visibleWorkspacePeer(workspace,actor,sql`${m.user_id}`), after ? gt(m.user_id, after) : undefined))
        .orderBy(m.user_id).limit(limit + 1);
      return page(rows, limit, row => row.user_id);
    });
  }
  async addMember(actor: string, workspace: string, input: unknown) {
    const parsed = parseWorkspaceMemberInput(input);
    return this.db.transaction(async c => {
      const { membership } = await this.lock(c, actor, workspace);
      // Check authority before resolving an email, to avoid exposing registered accounts.
      canManage(membership.role, 'member', parsed.role);
      const user_id = 'user_id' in parsed ? parsed.user_id : (await c.select({id:u.id}).from(u).where(sql`lower(${u.email})=${parsed.email}`).limit(1))[0]?.id;
      if (!user_id) throw new AppError(404, 'account_not_found');
      const request = { user_id, role: parsed.role };
      const [existing] = await c.select().from(m).where(memberKey(workspace, request.user_id));
      canManage(membership.role, existing?.active ? existing.role : 'member', request.role);
      if (existing?.guest_type && existing.guest_type !== 'none' && request.role !== 'member') throw new AppError(409,'guest_role_conflict');
      if (existing?.active) {
        if (existing.role !== request.role) throw new AppError(409, 'member_already_exists');
        return existing;
      }
      if (!(await c.select({ id: u.id }).from(u).where(eq(u.id, request.user_id))).length) throw notFound();
      const [member] = await c.insert(m).values({ workspace_id: workspace, ...request })
        .onConflictDoUpdate({ target: [m.workspace_id, m.user_id], set: { role: request.role, active: true, joined_at: new Date() } }).returning();
      if (member!.guest_type === 'none') await joinDefaultChannels(c, request.user_id, workspace);
      await this.audit(c, actor, workspace, 'member.added', request);
      return member!;
    });
  }
  async directory(actor: string, workspace: string, input: unknown = {}) {
    const query = parseDirectoryQuery(input);
    return this.db.transaction(async c => {
      const membership = await this.member(c, uuid(workspace), uuid(actor));
      const manager = membership.role !== 'member';
      if (!manager && query.status !== 'active') throw new AppError(403, 'member_management_forbidden');
      const preferences = await readWorkspacePreferences(c, workspace);
      const emailVisible = manager || preferences.email_visibility === 'members';
      const [workspaceRow] = await c.select({primary_owner_id:w.primary_owner_id}).from(w).where(eq(w.id,workspace));
      const sortValue = query.sort === 'name' ? sql`lower(${u.display_name})` : query.sort === 'joined' ? sql`${m.joined_at}` : sql`${m.user_id}`;
      let cursorValue: unknown;
      if (query.after && query.sort !== 'id') {
        const [cursor] = await c.select({value:query.sort==='joined'?sql`${m.joined_at}::text`:sortValue}).from(m).innerJoin(u,eq(u.id,m.user_id)).where(and(eq(m.workspace_id,workspace),eq(m.user_id,query.after),visibleWorkspacePeer(workspace,actor,sql`${m.user_id}`)));
        if(!cursor) throw new AppError(400,'invalid_cursor');
        cursorValue = cursor.value;
      }
      const pattern = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
      const rows = await c.select({user_id:m.user_id,display_name:u.display_name,role:m.role,guest_type:m.guest_type,active:m.active,joined_at:m.joined_at,...(emailVisible ? {email:u.email} : {})})
        .from(m).innerJoin(u,eq(u.id,m.user_id)).where(and(eq(m.workspace_id,workspace),
          query.status === 'all' ? undefined : eq(m.active,query.status === 'active'),
          query.role ? eq(m.role,query.role) : undefined,
          query.guest === 'all' ? undefined : eq(m.guest_type,query.guest as 'none'|'single'|'multi'),
          visibleWorkspacePeer(workspace,actor,sql`${m.user_id}`),
          query.after ? query.sort === 'id' ? gt(m.user_id,query.after) : sql`(${sortValue},${m.user_id})>(${query.sort==='joined'?sql`${cursorValue}::timestamptz`:sql`${cursorValue}`},${query.after}::uuid)` : undefined,
          query.q ? sql`(${u.display_name} ILIKE ${pattern} OR ${m.user_id}::text ILIKE ${pattern} ${emailVisible ? sql`OR ${u.email} ILIKE ${pattern}` : sql``})` : undefined,
        )).orderBy(sortValue,m.user_id).limit(query.limit+1);
      return {...page(rows,query.limit,row=>row.user_id),role:membership.role,primary_owner_id:workspaceRow!.primary_owner_id,email_visible:emailVisible};
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
      if (target.guest_type !== 'none' && role !== 'member') throw new AppError(409,'guest_role_conflict');
      if (target.role === 'owner') { await this.requireAnotherOwner(c, workspace, user); await this.requireNotPrimaryOwner(c,workspace,user); }
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
      if (target.role === 'owner') { await this.requireAnotherOwner(c, workspace, user); await this.requireNotPrimaryOwner(c,workspace,user); }
      await c.update(agentInstallations).set({ enabled: false })
        .where(and(eq(agentInstallations.workspace_id, workspace), eq(agentInstallations.owner_id, user)));
      await c.delete(channelMembers).where(and(eq(channelMembers.workspace_id, workspace), eq(channelMembers.user_id, user), sql`NOT EXISTS (SELECT 1 FROM channels ch WHERE ch.id=${channelMembers.channel_id} AND ch.kind='direct')`));
      await c.update(m).set({ active: false }).where(memberKey(workspace, user));
      await this.audit(c, actor, workspace, 'member.removed', { user_id: user, previous_role: target.role });
    });
  }
  async transferOwnership(actor: string, workspace: string, input: unknown) {
    const user = uuid(record(input, ['user_id']).user_id);
    return sessionTransaction(this.db, async c => {
      await this.member(c, uuid(workspace), uuid(actor));
      const [row] = await c.select().from(w).where(eq(w.id,workspace));
      if (row?.primary_owner_id !== actor) throw new AppError(403,'primary_owner_required');
      const target = await this.member(c,workspace,user);
      if (target.guest_type !== 'none') throw new AppError(409,'guest_role_conflict');
      if (user === actor) return row;
      await c.update(m).set({role:'owner'}).where(memberKey(workspace,user));
      const [updated] = await c.update(w).set({primary_owner_id:user}).where(and(eq(w.id,workspace),eq(w.primary_owner_id,actor))).returning();
      if (!updated) throw new AppError(409,'ownership_changed');
      await this.audit(c,actor,workspace,'workspace.ownership_transferred',{previous_owner_id:actor,user_id:user});
      return updated;
    });
  }
  async exportMembers(actor: string, workspace: string) {
    return this.db.transaction(async c => {
      const membership = await this.member(c,uuid(workspace),uuid(actor));
      if (membership.role === 'member') throw new AppError(403,'member_management_forbidden');
      const rows = await c.select({id:m.user_id,name:u.display_name,email:u.email,role:m.role,guest:m.guest_type,active:m.active,joined:m.joined_at}).from(m).innerJoin(u,eq(u.id,m.user_id)).where(eq(m.workspace_id,workspace)).orderBy(m.user_id).limit(10001);
      if(rows.length>10000) throw new AppError(413,'export_too_large');
      const cell=(value:unknown)=>'"'+String(value??'').replace(/^(?:\s*[=+@-]|[\t\r\n])/,"'$&").replaceAll('"','""')+'"';
      return ['Member ID,Name,Email,Account type,Guest type,Active,Date joined',...rows.map(row=>[row.id,row.name,row.email,row.role,row.guest,row.active,row.joined.toISOString()].map(cell).join(','))].join('\r\n');
    });
  }
  private async requireNotPrimaryOwner(c: DbSession, workspace: string, user: string) {
    const [row]=await c.select({primary_owner_id:w.primary_owner_id}).from(w).where(eq(w.id,workspace));
    if(row?.primary_owner_id===user) throw new AppError(409,'transfer_ownership_first');
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
