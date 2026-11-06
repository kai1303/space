import type { Pool } from 'pg';
import { eq, sql } from 'drizzle-orm';
import { AppError, parseProfileUpdate, uuid, visibleStatus, type WorkspaceProfile } from '@space/contracts';
import { database } from './database.js';
import { users } from './schema.js';
import { visibleWorkspacePeer } from './workspace-access.js';

export class UserStore {
  readonly db;
  constructor(pool: Pool) { this.db = database(pool); }
  async workspaceProfile(actor: string, workspace: string, kind: string, id: string): Promise<WorkspaceProfile> {
    uuid(actor); uuid(workspace); uuid(id);
    if (kind === 'user') {
      const { rows } = await this.db.execute(sql`SELECT 'user' AS kind,u.id,u.display_name,u.full_name,u.title,u.name_pronunciation,
        u.phone,u.time_zone,u.image,u.email,u.presence,u.status
        FROM users u JOIN workspace_members target ON target.user_id=u.id AND target.workspace_id=${workspace} AND target.active
        JOIN workspace_members viewer ON viewer.workspace_id=target.workspace_id AND viewer.user_id=${actor} AND viewer.active
        WHERE u.id=${id} AND ${visibleWorkspacePeer(workspace,actor,sql`u.id`)}`);
      const profile = rows[0] as Extract<WorkspaceProfile, { kind: 'user' }> | undefined;
      if (!profile) throw new AppError(404, 'not_found');
      return { ...profile, status: visibleStatus(profile.status) };
    }
    if (kind === 'agent') {
      const { rows } = await this.db.execute(sql`SELECT 'agent' AS kind,i.id,coalesce(ac.name,d.name) AS display_name,NULL::text AS image,
        i.owner_id,u.display_name AS owner_name,i.enabled,
        CASE WHEN ac.installation_id IS NULL THEN 'unknown'
          WHEN NOT i.enabled OR ac.connection_id IS NULL OR ac.last_seen_at IS NULL OR ac.last_seen_at < now()-interval '45 seconds' THEN 'offline'
          WHEN ac.auth_status='ready' THEN 'online' WHEN ac.auth_status='required' THEN 'auth_required' ELSE 'error' END AS availability,
        (i.enabled AND i.owner_id=${actor} AND ac.installation_id IS NOT NULL) AS can_message
        FROM agent_installations i JOIN agent_definitions d ON d.id=i.definition_id
        JOIN users u ON u.id=i.owner_id
        JOIN workspace_members owner ON owner.workspace_id=i.workspace_id AND owner.user_id=i.owner_id AND owner.active
        JOIN workspace_members viewer ON viewer.workspace_id=i.workspace_id AND viewer.user_id=${actor} AND viewer.active
        LEFT JOIN agent_connections ac ON ac.installation_id=i.id
        WHERE i.workspace_id=${workspace} AND i.id=${id} AND ac.revoked_at IS NULL
        AND ${visibleWorkspacePeer(workspace,actor,sql`i.owner_id`)}`);
      const profile = rows[0] as Extract<WorkspaceProfile, { kind: 'agent' }> | undefined;
      if (profile) return profile;
    }
    throw new AppError(404, 'not_found');
  }
  async profile(actor: string) {
    const [user] = await this.db.select().from(users).where(eq(users.id, uuid(actor)));
    if (!user) throw new AppError(404, 'not_found');
    return { ...user, status: visibleStatus(user.status) };
  }
  async updateProfile(actor: string, input: unknown) {
    const [user] = await this.db.update(users).set({ ...parseProfileUpdate(input), updated_at: new Date() }).where(eq(users.id, uuid(actor))).returning();
    if (!user) throw new AppError(404, 'not_found');
    return { ...user, status: visibleStatus(user.status) };
  }
}
