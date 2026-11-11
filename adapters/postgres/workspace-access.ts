import { sql, type SQL } from 'drizzle-orm';
import { AppError } from '@space/contracts';
import type { DbSession } from './database.js';

// Guests can discover people with whom they share an assigned channel. Existing
// direct conversations remain available, but do not expand the guest directory.
export function visibleWorkspacePeer(workspace: string, actor: string | SQL, peer: SQL) {
  return sql`(${peer}=${actor}::uuid OR NOT EXISTS(SELECT 1 FROM workspace_members viewer WHERE viewer.workspace_id=${workspace} AND viewer.user_id=${actor} AND viewer.guest_type<>'none') OR EXISTS(SELECT 1 FROM channel_members mine JOIN channel_members theirs ON theirs.channel_id=mine.channel_id JOIN channels shared ON shared.id=mine.channel_id WHERE mine.workspace_id=${workspace} AND mine.user_id=${actor} AND theirs.user_id=${peer} AND shared.kind='channel'))`;
}
export async function requireFullWorkspaceMember(c: DbSession, actor: string, workspace: string) {
  const rows = await c.execute(sql`SELECT 1 FROM workspace_members WHERE workspace_id=${workspace} AND user_id=${actor} AND active AND guest_type='none'`);
  if (!rows.rows.length) throw new AppError(403, 'guest_action_forbidden');
}
