import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { and, asc, desc, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { AppError, parseAssetInput, parseAssetListQuery, uuid, type AssetAttachment, type AssetPreview, type ChannelFile, type Page } from '@space/contracts';
import { database, type DbSession } from './database.js';
import { hasChannelAccess, lockWorkspace } from './access.js';
import { assets, channels, messages, users } from './schema.js';

type Asset = typeof assets.$inferSelect;
const notFound = () => new AppError(404, 'not_found');
export const assetAttachment = (row: Asset): AssetAttachment => ({ id: row.id, name: row.name, size: row.size, type: row.type });

export class AssetStore {
  readonly db;
  constructor(readonly pool: Pool) { this.db = database(pool); }
  private async channel(c: DbSession, actor: string, id: string) {
    const [channel] = await c.select().from(channels).where(eq(channels.id, uuid(id)));
    if (!channel) throw notFound();
    await lockWorkspace(c, channel.workspace_id);
    await c.select({ id: channels.id }).from(channels).where(eq(channels.id, id)).for('update');
    if (!await hasChannelAccess(c, actor, channel.workspace_id, id)) throw notFound();
    return channel;
  }
  async list(actor: string, channelId: string, input: unknown = {}): Promise<Page<ChannelFile>> {
    const query = parseAssetListQuery(input);
    return this.db.transaction(async c => {
      const [channel] = await c.select().from(channels).where(eq(channels.id, uuid(channelId)));
      if (!channel || !await hasChannelAccess(c, actor, channel.workspace_id, channel.id)) throw notFound();
      const scope = and(eq(assets.channel_id, channel.id), eq(assets.workspace_id, channel.workspace_id), eq(assets.status, 'ready'), isNotNull(assets.message_id));
      const source = and(eq(messages.id, assets.message_id), eq(messages.channel_id, assets.channel_id), eq(messages.workspace_id, assets.workspace_id));
      const previewKind = sql<ChannelFile['preview_kind']>`coalesce(${assets.preview}->>'kind', 'file')`;
      let cursor;
      if (query.after) {
        // Keep the database's microseconds; JavaScript Date truncates cursor timestamps.
        const [anchor] = await c.select({ shared_at: sql<string>`${messages.created_at}::text` }).from(assets)
          .innerJoin(messages, source).where(and(scope, eq(assets.id, query.after))).limit(1);
        if (!anchor) throw new AppError(400, 'invalid_cursor');
        cursor = query.sort === 'newest'
          ? sql`(${messages.created_at}, ${assets.id}) < (${anchor.shared_at}::timestamptz, ${query.after}::uuid)`
          : sql`(${messages.created_at}, ${assets.id}) > (${anchor.shared_at}::timestamptz, ${query.after}::uuid)`;
      }
      const pattern = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
      const order = query.sort === 'newest' ? desc : asc;
      const rows = await c.select({ id: assets.id, name: assets.name, size: assets.size, type: assets.type,
        preview_kind: previewKind, message_id: messages.id, thread_id: messages.thread_id, shared_at: sql<string>`to_json(${messages.created_at}) #>> '{}'`,
        uploader: { id: users.id, name: users.display_name },
      }).from(assets).innerJoin(messages, source).innerJoin(users, eq(users.id, assets.uploader_id))
        .where(and(scope, cursor, query.q ? sql`${assets.name} ilike ${pattern}` : undefined,
          query.kind === 'all' ? undefined : query.kind === 'other' ? sql`${previewKind} in ('unsupported', 'file')` : eq(previewKind, query.kind)))
        .orderBy(order(messages.created_at), order(assets.id)).limit(query.limit + 1);
      const items = rows.slice(0, query.limit);
      return { items, next_cursor: rows.length > query.limit ? items.at(-1)!.id : null };
    });
  }
  async create(actor: string, channelId: string, input: unknown): Promise<Asset> {
    const data = parseAssetInput(input);
    return this.db.transaction(async c => {
      const channel = await this.channel(c, actor, channelId);
      await c.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${channel.workspace_id}:${actor}:assets`}))`);
      const pending = await c.select({ id: assets.id }).from(assets)
        .where(and(eq(assets.workspace_id, channel.workspace_id), eq(assets.uploader_id, actor), isNull(assets.message_id), sql`${assets.expires_at} > now()`)).limit(20);
      if (pending.length >= 20) throw new AppError(429, 'too_many_uploads');
      const id = randomUUID();
      const [row] = await c.insert(assets).values({ id, workspace_id: channel.workspace_id, channel_id: channelId, uploader_id: actor,
        ...data, staging_key: `staging/${id}`, object_key: `files/${id}`,
        upload_expires_at: new Date(Date.now() + 300_000), expires_at: new Date(Date.now() + 86_400_000) }).returning();
      return row!;
    });
  }
  private async owned(c: DbSession, actor: string, id: string): Promise<Asset> {
    const [ref] = await c.select({ channel_id: assets.channel_id, uploader_id: assets.uploader_id }).from(assets).where(eq(assets.id, uuid(id)));
    if (!ref || ref.uploader_id !== actor) throw notFound();
    await this.channel(c, actor, ref.channel_id);
    const [row] = await c.select().from(assets).where(eq(assets.id, id)).for('update');
    if (!row) throw notFound();
    return row;
  }
  async complete(actor: string, id: string, finalize: (stagingKey: string, finalKey: string, size: number, name: string) => Promise<AssetPreview>): Promise<AssetAttachment> {
    return this.db.transaction(async c => {
      const row = await this.owned(c, actor, id);
      if (!row.message_id && row.expires_at <= new Date()) throw new AppError(410, 'upload_expired');
      if (row.status === 'pending') {
        const preview = await finalize(row.staging_key, row.object_key, row.size, row.name);
        await c.update(assets).set({ status: 'ready', preview }).where(eq(assets.id, id));
      }
      return assetAttachment(row);
    });
  }
  async download(actor: string, id: string): Promise<Asset> {
    return this.db.transaction(async c => {
      const [row] = await c.select().from(assets).where(eq(assets.id, uuid(id)));
      await this.assertAccess(c, actor, row);
      return row!;
    });
  }
  private async assertAccess(c: DbSession, actor: string, row: Asset | undefined) {
    if (!row || row.status !== 'ready' || !await hasChannelAccess(c, actor, row.workspace_id, row.channel_id)) throw notFound();
    if (!row.message_id && (row.uploader_id !== actor || row.expires_at <= new Date())) throw notFound();
  }
  async preview(actor: string, id: string, generate: (asset: Asset) => Promise<AssetPreview>): Promise<AssetPreview> {
    return this.db.transaction(async c => {
      const [row] = await c.select().from(assets).where(eq(assets.id, uuid(id))).for('update');
      await this.assertAccess(c, actor, row);
      if (row!.preview) return row!.preview;
      const preview = await generate(row!);
      await c.update(assets).set({ preview }).where(eq(assets.id, id));
      return preview;
    });
  }
  async pdfThumbnail(actor: string, id: string, generate: (asset: Asset) => Promise<boolean>): Promise<boolean> {
    return this.db.transaction(async c => {
      const [row] = await c.select().from(assets).where(eq(assets.id, uuid(id))).for('update');
      await this.assertAccess(c, actor, row);
      if (row!.preview?.kind !== 'pdf') throw new AppError(415, 'preview_unavailable');
      if (row!.preview.thumbnail !== undefined) return row!.preview.thumbnail;
      const thumbnail = await generate(row!);
      await c.update(assets).set({ preview: { ...row!.preview, thumbnail } }).where(eq(assets.id, id));
      return thumbnail;
    });
  }
  async cleanup(remove: (key: string) => Promise<void>, limit = 20): Promise<number> {
    let cleaned = 0;
    for (let i = 0; i < limit; i++) {
      const found = await this.db.transaction(async c => {
        const [row] = await c.select().from(assets).where(or(
          and(isNull(assets.message_id), lt(assets.expires_at, sql`now()`)),
          and(eq(assets.status, 'ready'), isNull(assets.staging_deleted_at), lt(assets.upload_expires_at, sql`now()`)),
        )).orderBy(assets.expires_at).limit(1).for('update', { skipLocked: true });
        if (!row) return false;
        await remove(row.staging_key);
        if (!row.message_id && row.expires_at <= new Date()) {
          await remove(row.object_key);
          await remove(`previews/${row.id}/display.webp`);
          await remove(`previews/${row.id}/thumbnail.webp`);
          await c.delete(assets).where(eq(assets.id, row.id));
        } else await c.update(assets).set({ staging_deleted_at: new Date() }).where(eq(assets.id, row.id));
        return true;
      });
      if (!found) break;
      cleaned++;
    }
    return cleaned;
  }
}
