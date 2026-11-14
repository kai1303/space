import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { AppError, parseCreateSidebarSection, parseUpdateSidebarSection, uuid,
  type SidebarSection, type SidebarSectionAssignment, type SidebarSectionsSnapshot } from '@space/contracts';
import { database, type DbSession } from './database.js';
import { hasChannelAccess, requireWorkspaceAccess } from './access.js';
import { sessionTransaction } from './session-concurrency.js';

const notFound = () => new AppError(404, 'not_found');
const maxSections = 100;
const maxAssignments = 1000;

async function readSnapshot(c: DbSession, actor: string, workspace: string): Promise<SidebarSectionsSnapshot> {
  const sections = await c.execute<Omit<SidebarSection, 'emoji'> & { emoji: string | null }>(sql`
    SELECT id,name,collapsed,emoji FROM sidebar_sections
    WHERE workspace_id=${workspace} AND user_id=${actor} ORDER BY created_at,id`);
  const assignments = await c.execute<SidebarSectionAssignment & Record<string, unknown>>(sql`
    SELECT a.channel_id,a.section_id,ch.kind,ch.private,
      CASE WHEN ch.kind='channel' THEN ch.name WHEN ch.direct_user_low=ch.direct_user_high THEN peer.display_name||' (you)'
        ELSE peer.display_name END AS name
    FROM sidebar_section_assignments a JOIN channels ch ON ch.id=a.channel_id
    LEFT JOIN users peer ON peer.id=CASE WHEN ch.direct_user_low=a.user_id THEN ch.direct_user_high ELSE ch.direct_user_low END
    LEFT JOIN direct_message_views dm ON dm.channel_id=a.channel_id AND dm.user_id=a.user_id
    WHERE a.workspace_id=${workspace} AND a.user_id=${actor} AND (ch.kind='channel' OR NOT dm.hidden)
    ORDER BY name,a.channel_id`);
  return { sections: sections.rows.map(({ emoji, ...section }) => emoji ? { ...section, emoji } : section), assignments: assignments.rows };
}

async function assign(c: DbSession, actor: string, workspace: string, channel: string, section: string | null) {
  if (!await hasChannelAccess(c, actor, workspace, channel)) throw notFound();
  const owner = sql`workspace_id=${workspace} AND user_id=${actor}`;
  if (section === null) {
    await c.execute(sql`DELETE FROM sidebar_section_assignments WHERE ${owner} AND channel_id=${channel}`);
    return;
  }
  if (!(await c.execute(sql`SELECT 1 FROM sidebar_sections WHERE ${owner} AND id=${section}`)).rowCount) throw notFound();
  const capacity = await c.execute(sql`SELECT 1 FROM sidebar_section_assignments WHERE ${owner}
    HAVING count(*) >= ${maxAssignments} AND NOT bool_or(channel_id=${channel})`);
  if (capacity.rowCount) throw new AppError(409, 'sidebar_assignment_limit');
  await c.execute(sql`INSERT INTO sidebar_section_assignments(workspace_id,user_id,channel_id,section_id)
    VALUES(${workspace},${actor},${channel},${section}) ON CONFLICT(workspace_id,user_id,channel_id)
    DO UPDATE SET section_id=excluded.section_id WHERE sidebar_section_assignments.section_id<>excluded.section_id`);
}

export class SidebarSectionStore {
  readonly db;
  constructor(pool: Pool) { this.db = database(pool); }

  snapshot(actor: string, workspace: string) {
    return this.db.transaction(async c => {
      await requireWorkspaceAccess(c, actor, workspace);
      return readSnapshot(c, actor, workspace);
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  private mutate(actor: string, workspace: string, change: (c: DbSession) => Promise<void>) {
    return sessionTransaction(this.db, async c => {
      await requireWorkspaceAccess(c, actor, workspace);
      await change(c);
      return readSnapshot(c, actor, workspace);
    });
  }

  create(actor: string, workspace: string, input: unknown) {
    const { id, name, channel_id, emoji } = parseCreateSidebarSection(input);
    return this.mutate(actor, workspace, async c => {
      const owner = sql`workspace_id=${workspace} AND user_id=${actor}`;
      const existing = (await c.execute<{ creation_name: string; creation_emoji: string | null; creation_channel_id: string | null }>(sql`
        SELECT creation_name,creation_channel_id,creation_emoji FROM sidebar_sections WHERE ${owner} AND id=${id}`)).rows[0];
      // A delayed create retry must preserve subsequent renames and moves.
      if (existing) {
        if (existing.creation_name !== name || existing.creation_emoji !== (emoji ?? null) || existing.creation_channel_id !== (channel_id ?? null)) {
          throw new AppError(409, 'idempotency_conflict');
        }
        return;
      }
      if ((await c.execute(sql`SELECT 1 FROM sidebar_sections WHERE ${owner} HAVING count(*) >= ${maxSections}`)).rowCount) {
        throw new AppError(409, 'sidebar_section_limit');
      }
      await c.execute(sql`INSERT INTO sidebar_sections(workspace_id,user_id,id,name,creation_name,creation_channel_id,emoji,creation_emoji)
        VALUES(${workspace},${actor},${id},${name},${name},${channel_id ?? null},${emoji ?? null},${emoji ?? null})`);
      if (channel_id) await assign(c, actor, workspace, channel_id, id);
    });
  }

  move(actor: string, workspace: string, channel: string, section: string | null) {
    return this.mutate(actor, workspace, c => assign(c, actor, workspace, uuid(channel), section === null ? null : uuid(section)));
  }

  update(actor: string, workspace: string, section: string, input: unknown) {
    const { name, collapsed, emoji } = parseUpdateSidebarSection(input);
    const nextEmoji = emoji === undefined ? sql`emoji` : sql`${emoji}::text`;
    const target = sql`workspace_id=${workspace} AND user_id=${actor} AND id=${uuid(section)}`;
    return this.mutate(actor, workspace, async c => {
      if (!(await c.execute(sql`SELECT 1 FROM sidebar_sections WHERE ${target}`)).rowCount) throw notFound();
      await c.execute(sql`UPDATE sidebar_sections SET name=coalesce(${name ?? null},name), emoji=${nextEmoji}, collapsed=coalesce(${collapsed ?? null},collapsed)
        WHERE ${target} AND (name,collapsed,emoji) IS DISTINCT FROM (coalesce(${name ?? null},name),coalesce(${collapsed ?? null},collapsed),${nextEmoji})`);
    });
  }

  remove(actor: string, workspace: string, section: string) {
    return this.mutate(actor, workspace, async c => {
      await c.execute(sql`DELETE FROM sidebar_sections WHERE workspace_id=${workspace} AND user_id=${actor} AND id=${uuid(section)}`);
    });
  }
}
