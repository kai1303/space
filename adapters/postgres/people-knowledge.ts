import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import {
  uuid,
  workspacePath,
  type KnowledgeContext,
  type KnowledgeHit,
  type KnowledgeManifest,
  type KnowledgePluginV1,
  type KnowledgeRef,
  type KnowledgeSearch,
} from '@space/contracts';
import { database } from './database.js';
import { visibleWorkspacePeer } from './workspace-access.js';

export const peopleManifest: KnowledgeManifest = {
  apiVersion: 1,
  name: 'Space people directory',
  description: 'Find active workspace members by display name, full name, job title or workspace role.',
  filters: [
    {
      key: 'workspace_role',
      description: 'Current workspace membership role.',
      values: ['owner', 'admin', 'member'],
    },
  ],
};

export class PeopleDirectory implements KnowledgePluginV1 {
  readonly manifest = peopleManifest;
  constructor(private readonly pool: Pool) {}

  private async lookup(ctx: KnowledgeContext, request: KnowledgeSearch, id?: string) {
    const pattern = '%' + request.query.trim().replace(/[\\%_]/g, '\\$&') + '%';
    const { rows } = await database(this.pool).execute<{
      id: string;
      display_name: string;
      full_name: string;
      title: string;
      time_zone: string;
      role: string;
    }>(sql`SELECT u.id,u.display_name,u.full_name,u.title,u.time_zone,m.role
      FROM workspace_members m JOIN users u ON u.id=m.user_id
      WHERE m.workspace_id=${ctx.workspaceId} AND m.active
      AND ${visibleWorkspacePeer(ctx.workspaceId, ctx.requesterId, sql`u.id`)}
      AND NOT EXISTS (
        SELECT 1 FROM channel_members cm JOIN workspace_members viewer
          ON viewer.workspace_id=cm.workspace_id AND viewer.user_id=cm.user_id
        WHERE cm.channel_id=${ctx.audience.channelId} AND cm.workspace_id=m.workspace_id AND viewer.active
          AND viewer.guest_type<>'none' AND NOT ${visibleWorkspacePeer(ctx.workspaceId, sql`viewer.user_id`, sql`u.id`)}
      )
      ${id ? sql`AND u.id=${uuid(id)}` : sql``}
      ${request.filters?.workspace_role ? sql`AND m.role=${request.filters.workspace_role}` : sql``}
      ${request.cursor ? sql`AND u.id>${uuid(request.cursor)}::uuid` : sql``}
      ${request.query.trim() ? sql`AND (u.display_name ILIKE ${pattern} OR u.full_name ILIKE ${pattern} OR u.title ILIKE ${pattern})` : sql``}
      ORDER BY u.id LIMIT ${request.limit + 1}`);
    const hits = rows.slice(0, request.limit).map((row): KnowledgeHit => {
      const ref = { connectionId: ctx.connectionId, recordId: row.id };
      const properties = [
        ['workspace_role', row.role],
        ['full_name', row.full_name],
        ['job_title', row.title],
        ['time_zone', row.time_zone],
      ] as const;
      return {
        ref,
        title: row.display_name,
        evidence: [row.display_name, row.full_name, row.title, 'Workspace role: ' + row.role, row.time_zone]
          .filter(Boolean)
          .join(' · '),
        citation: {
          label: '@' + row.display_name,
          url: workspacePath(ctx.workspaceId) + '?profile=user:' + row.id,
        },
        facts: properties
          .filter(([, value]) => value)
          .map(([key, value]) => ({ subject: ref, predicate: 'space:' + key, value })),
      };
    });
    return { hits, ...(rows.length > request.limit ? { nextCursor: hits.at(-1)!.ref.recordId } : {}) };
  }
  search(ctx: KnowledgeContext, request: KnowledgeSearch) {
    return this.lookup(ctx, request);
  }
  async resolve(ctx: KnowledgeContext, ref: KnowledgeRef) {
    if (ref.connectionId !== ctx.connectionId) return null;
    return (await this.lookup(ctx, { query: '', limit: 1 }, ref.recordId)).hits[0] ?? null;
  }
}
