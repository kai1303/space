import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { conversationPath, uuid, type KnowledgeContext, type KnowledgeManifest, type KnowledgePluginV1, type KnowledgeRef, type KnowledgeSearch } from '@space/contracts';
import { database } from './database.js';

export const channelManifest: KnowledgeManifest = {
  apiVersion: 1,
  name: 'Space channel directory',
  description: 'List visible workspace channels with an empty query, or search by channel name. Follow nextCursor for more results. Cite each channel as a Markdown link using its exact #name citation label and URL.',
};

export class ChannelDirectory implements KnowledgePluginV1 {
  readonly manifest = channelManifest;
  constructor(private readonly pool: Pool) {}

  private async lookup(ctx: KnowledgeContext, request: KnowledgeSearch, id?: string) {
    const name = request.query.trim().replace(/^#/, '');
    const pattern = '%' + name.replace(/[\\%_]/g, '\\$&') + '%';
    const { rows } = await database(this.pool).execute<{id: string; name: string}>(sql`
      SELECT c.id,c.name FROM channels c
      JOIN channels audience ON audience.id=${ctx.audience.channelId} AND audience.workspace_id=c.workspace_id
      JOIN workspace_members requester ON requester.workspace_id=c.workspace_id AND requester.user_id=${ctx.requesterId} AND requester.active
      JOIN channel_members participant ON participant.channel_id=audience.id AND participant.user_id=requester.user_id
      WHERE c.workspace_id=${ctx.workspaceId} AND c.kind='channel' AND c.archived_at IS NULL
        AND (NOT c.private OR audience.private)
        AND ((NOT c.private AND requester.guest_type='none') OR EXISTS (
          SELECT 1 FROM channel_members mine WHERE mine.channel_id=c.id AND mine.user_id=requester.user_id))
        AND NOT EXISTS (
          SELECT 1 FROM channel_members cm JOIN workspace_members viewer ON viewer.workspace_id=cm.workspace_id AND viewer.user_id=cm.user_id AND viewer.active
          WHERE cm.channel_id=audience.id AND (c.private OR viewer.guest_type<>'none')
            AND NOT EXISTS (SELECT 1 FROM channel_members allowed WHERE allowed.channel_id=c.id AND allowed.user_id=cm.user_id))
        ${id ? sql`AND c.id=${uuid(id)}` : sql``}
        ${name ? sql`AND c.name ILIKE ${pattern}` : sql``}
        ${request.cursor ? sql`AND c.id>${uuid(request.cursor)}::uuid` : sql``}
      ORDER BY c.id LIMIT ${request.limit + 1}`);
    const hits = rows.slice(0, request.limit).map(row => {
      const label = '#' + row.name;
      return { ref: { connectionId: ctx.connectionId, recordId: row.id }, title: label,
        evidence: label, citation: { label, url: conversationPath(row.id)! } };
    });
    return { hits, ...(rows.length > request.limit ? { nextCursor: hits.at(-1)!.ref.recordId } : {}) };
  }
  search(ctx: KnowledgeContext, request: KnowledgeSearch) { return this.lookup(ctx, request); }
  async resolve(ctx: KnowledgeContext, ref: KnowledgeRef) {
    if (ref.connectionId !== ctx.connectionId) return null;
    return (await this.lookup(ctx, { query: '', limit: 1 }, ref.recordId)).hits[0] ?? null;
  }
}
