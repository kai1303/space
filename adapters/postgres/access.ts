import { and, eq } from 'drizzle-orm';
import { AppError, uuid } from '@space/contracts';
import type { DbSession } from './database.js';
import { workspaceMembers as w, workspaces, channelMembers as m, threads as t } from './schema.js';

// Shared locks serialize child mutations against workspace membership changes.
export async function lockWorkspace(c: DbSession, workspace: string) {
  const [row] = await c.select({ id: workspaces.id }).from(workspaces)
    .where(eq(workspaces.id, uuid(workspace))).for('share');
  if (!row) throw new AppError(404, 'not_found');
}
export async function hasWorkspaceAccess(c: DbSession, actor: string, workspace: string): Promise<boolean> {
  return (await c.select({ user_id: w.user_id }).from(w)
    .where(and(eq(w.workspace_id, uuid(workspace)), eq(w.user_id, uuid(actor)), eq(w.active, true))).limit(1)).length > 0;
}
export async function requireWorkspaceAccess(c: DbSession, actor: string, workspace: string): Promise<void> {
  if (!await hasWorkspaceAccess(c, actor, workspace)) throw new AppError(404, 'not_found');
}
export async function hasChannelAccess(c: DbSession, actor: string, workspace: string, channel: string): Promise<boolean> {
  return (await c.select({ user_id: m.user_id }).from(m).innerJoin(w, and(eq(w.workspace_id, m.workspace_id), eq(w.user_id, m.user_id)))
    .where(and(eq(m.workspace_id, uuid(workspace)), eq(m.channel_id, uuid(channel)), eq(m.user_id, uuid(actor)), eq(w.active, true))).limit(1)).length > 0;
}
export async function hasThreadAccess(c: DbSession, actor: string, thread: string): Promise<boolean> {
  return (await c.select({ id: t.id }).from(t).innerJoin(m, and(eq(m.channel_id, t.channel_id), eq(m.workspace_id, t.workspace_id)))
    .innerJoin(w, and(eq(w.workspace_id, m.workspace_id), eq(w.user_id, m.user_id)))
    .where(and(eq(t.id, uuid(thread)), eq(m.user_id, uuid(actor)), eq(w.active, true))).limit(1)).length > 0;
}
