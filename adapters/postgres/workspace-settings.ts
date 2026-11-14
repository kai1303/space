import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { sql, type SQL } from 'drizzle-orm';
import { AppError, parseWorkspaceSettingsUpdate, parseWorkspaceSlug, workspacePreferenceDefaults, uuid, type MemberRole, type WorkspacePreferences, type WorkspaceSettings } from '@space/contracts';
import { database, type DbSession } from './database.js';
import { sessionTransaction } from './session-concurrency.js';

async function rows<T>(c: DbSession, query: SQL): Promise<T[]> { return (await c.execute(query)).rows as T[]; }
export async function readWorkspacePreferences(c: DbSession, workspace: string): Promise<WorkspacePreferences> {
  const [value] = await rows<WorkspacePreferences>(c, sql`SELECT p.*,p.revision::text AS revision FROM workspace_preferences p WHERE workspace_id=${uuid(workspace)}`);
  return value ?? { ...workspacePreferenceDefaults, workspace_id: workspace, default_channel_ids: [], approved_email_domains: [] };
}
async function membership(c: DbSession, actor: string, workspace: string) {
  const [member] = await rows<{ role: MemberRole; guest_type: string }>(c, sql`SELECT role,guest_type FROM workspace_members WHERE workspace_id=${uuid(workspace)} AND user_id=${uuid(actor)} AND active`);
  if (!member) throw new AppError(404, 'not_found');
  return member;
}
export async function requireWorkspacePolicy(c: DbSession, actor: string, workspace: string, action: 'invite' | 'create_channel', guestError = `${action}_forbidden`) {
  const member = await membership(c, actor, workspace);
  if (member.guest_type !== 'none') throw new AppError(403, guestError);
  if (member.role !== 'member') return member;
  const settings = await readWorkspacePreferences(c, workspace);
  if (settings[action === 'invite' ? 'invite_permission' : 'create_channel_permission'] !== 'members') throw new AppError(403, `${action}_forbidden`);
  return member;
}
export async function joinDefaultChannels(c: DbSession, actor: string, workspace: string) {
  const settings = await readWorkspacePreferences(c, workspace);
  if (!settings.default_channel_ids.length) return;
  await c.execute(sql`INSERT INTO channel_members(workspace_id,channel_id,user_id)
    SELECT ch.workspace_id,ch.id,${uuid(actor)}::uuid FROM channels ch
    WHERE ch.workspace_id=${uuid(workspace)} AND ch.id=ANY(${sql.param(settings.default_channel_ids)}::uuid[])
      AND ch.kind='channel' AND NOT ch.private AND ch.archived_at IS NULL
      AND EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=ch.workspace_id AND wm.user_id=${actor} AND wm.active AND wm.guest_type='none')
    ON CONFLICT DO NOTHING`);
}
export class WorkspaceSettingsStore {
  readonly db;
  constructor(readonly pool: Pool) { this.db = database(pool); }
  private async readIn(c: DbSession, actor: string, workspace: string): Promise<WorkspaceSettings> {
    const member = await membership(c, actor, workspace);
    const [record] = await rows<{name:string;created_at:string}>(c, sql`SELECT name,created_at FROM workspaces WHERE id=${workspace}`);
    if (!record) throw new AppError(404, 'not_found');
    return { ...await readWorkspacePreferences(c, workspace), ...member, name: record.name, created_at: new Date(record.created_at).toISOString() };
  }
  async read(actor: string, workspace: string) { return sessionTransaction(this.db, c => this.readIn(c, actor, uuid(workspace))); }
  async update(actor: string, workspace: string, input: unknown) {
    workspace = uuid(workspace);
    const update = parseWorkspaceSettingsUpdate(input);
    try {
      return await sessionTransaction(this.db, async c => {
        const member = await membership(c, actor, workspace);
        if (member.role === 'member') throw new AppError(403, 'workspace_management_forbidden');
        if (update.default_channel_ids?.length) {
          const found = await rows<{id:string}>(c, sql`SELECT id FROM channels WHERE workspace_id=${workspace}
            AND id=ANY(${sql.param(update.default_channel_ids)}::uuid[]) AND kind='channel' AND NOT private AND archived_at IS NULL`);
          if (found.length !== update.default_channel_ids.length) throw new AppError(400, 'invalid_default_channels');
        }
        if (update.slug) {
          const duplicate = await rows(c, sql`SELECT 1 FROM workspace_preferences WHERE slug=${update.slug} AND workspace_id<>${workspace}`);
          if (duplicate.length) throw new AppError(409, 'workspace_slug_taken');
        }
        await c.execute(sql`INSERT INTO workspace_preferences(workspace_id) VALUES(${workspace}) ON CONFLICT DO NOTHING`);
        const entries = Object.entries(update).filter(([key]) => key !== 'name' && key !== 'revision');
        const assignments = entries.map(([key, value]) => sql`${sql.identifier(key)}=${sql.param(value)}${key.endsWith('_ids') ? sql`::uuid[]` : key === 'approved_email_domains' ? sql`::text[]` : sql``}`);
        assignments.push(sql`revision=revision+1`);
        const changed = await rows(c, sql`UPDATE workspace_preferences SET ${sql.join(assignments, sql`, `)} WHERE workspace_id=${workspace} AND revision=${update.revision}::bigint RETURNING workspace_id`);
        if (!changed.length) throw new AppError(409, 'settings_changed_reload');
        if (update.name !== undefined) await c.execute(sql`UPDATE workspaces SET name=${update.name} WHERE id=${workspace}`);
        await c.execute(sql`INSERT INTO workspace_events(id,workspace_id,actor_id,type,payload) VALUES(${randomUUID()},${workspace},${actor},'workspace.settings_updated',${JSON.stringify({fields:Object.keys(update).filter(key=>key!=='revision')})}::jsonb)`);
        return this.readIn(c, actor, workspace);
      });
    } catch (error) {
      const failure = error as {code?:string;cause?:{code?:string;constraint?:string};constraint?:string};
      if ((failure.cause?.code ?? failure.code) === '23505' && (failure.cause?.constraint ?? failure.constraint) === 'workspace_preferences_slug_key') throw new AppError(409, 'workspace_slug_taken');
      throw error;
    }
  }
  async resolveSlug(actor: string, value: unknown) {
    const slug = parseWorkspaceSlug(value);
    return sessionTransaction(this.db, async c => {
      const [record] = await rows<{workspace_id:string}>(c, sql`SELECT workspace_id FROM workspace_preferences WHERE slug=${slug}`);
      if (!record) throw new AppError(404, 'not_found');
      return this.readIn(c, actor, record.workspace_id);
    });
  }
  async joinByDomain(actor: string, value: unknown) {
    actor = uuid(actor);
    const slug = parseWorkspaceSlug(value);
    return sessionTransaction(this.db, async c => {
      const [record] = await rows<{workspace_id:string}>(c, sql`SELECT workspace_id FROM workspace_preferences WHERE slug=${slug}`);
      if (!record) throw new AppError(404, 'not_found');
      const workspace = record.workspace_id;
      const [existing] = await rows<{active:boolean}>(c, sql`SELECT active FROM workspace_members WHERE workspace_id=${workspace} AND user_id=${actor}`);
      if (existing?.active) return this.readIn(c, actor, workspace);
      if (existing) throw new AppError(403, 'workspace_reactivation_required');
      const [user] = await rows<{email:string|null;email_verified:boolean}>(c, sql`SELECT email,email_verified FROM users WHERE id=${actor}`);
      const settings = await readWorkspacePreferences(c, workspace);
      const domain = user?.email?.split('@').at(-1)?.toLowerCase();
      if (!user?.email_verified || !domain || !settings.approved_email_domains.includes(domain)) throw new AppError(403, 'verified_workspace_email_required');
      const inserted = await rows(c, sql`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspace},${actor},'member') ON CONFLICT DO NOTHING RETURNING user_id`);
      if (inserted.length) {
        await joinDefaultChannels(c, actor, workspace);
        await c.execute(sql`INSERT INTO workspace_events(id,workspace_id,actor_id,type,payload) VALUES(${randomUUID()},${workspace},${actor},'member.joined_by_domain',${JSON.stringify({user_id:actor})}::jsonb)`);
      }
      return this.readIn(c, actor, workspace);
    });
  }
}
