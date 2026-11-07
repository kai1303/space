import { sessionTransaction } from './session-concurrency.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { AppError, parseAssetInput, parseAssetListQuery, uuid, type AssetAttachment, type AssetPreview, type ChannelFile, type Page } from '@space/contracts';
import { database, type DbSession } from './database.js';
import { hasChannelAccess, lockWorkspace } from './access.js';
import { assets, channels, messages, users } from './schema.js';

type Asset = typeof assets.$inferSelect;
const notFound = () => new AppError(404, 'not_found');
// Bound buffered copies/decodes without borrowing PostgreSQL connections as a queue.
const processingCounts = new WeakMap<Pool, number>();
export const assetAttachment = (row: Asset): AssetAttachment => ({ id: row.id, name: row.name, size: row.size, type: row.type });

export class AssetStore {
  readonly db;
  constructor(readonly pool: Pool) { this.db = database(pool); }
  private async channel(c: DbSession, actor: string, id: string) {
    const [channel] = await c.select().from(channels).where(eq(channels.id, uuid(id)));
    if (!channel) throw notFound();
    if (channel.kind !== 'direct') {
      await lockWorkspace(c, channel.workspace_id);
      await c.select({ id: channels.id }).from(channels).where(eq(channels.id, id)).for('update');
    }
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
        description: sql<string | null>`(SELECT entry->>'description' FROM jsonb_array_elements(${messages.attachments}) entry WHERE entry->>'id' = ${assets.id}::text LIMIT 1)`,
      }).from(assets).innerJoin(messages, source).innerJoin(users, eq(users.id, assets.uploader_id))
        .where(and(scope, cursor, query.q ? sql`${assets.name} ilike ${pattern}` : undefined,
          query.kind === 'all' ? undefined : query.kind === 'other' ? sql`${previewKind} in ('unsupported', 'file')` : eq(previewKind, query.kind)))
        .orderBy(order(messages.created_at), order(assets.id)).limit(query.limit + 1);
      const items = rows.slice(0, query.limit).map(({ description, ...file }) => ({ ...file, ...(description ? { description } : {}) }));
      return { items, next_cursor: rows.length > query.limit ? items.at(-1)!.id : null };
    });
  }
  async create(actor: string, channelId: string, input: unknown): Promise<Asset> {
    const data = parseAssetInput(input);
    // All allocations share serializable quota checks, including mixed channel/DM races.
    return sessionTransaction(this.db, async c => {
      const channel = await this.channel(c, actor, channelId);
      if (channel.kind !== 'direct') await c.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${channel.workspace_id}:${actor}:assets`}))`);
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
    const [row] = await c.select().from(assets).where(eq(assets.id, uuid(id)));
    if (!row || row.uploader_id !== actor || !await hasChannelAccess(c, actor, row.workspace_id, row.channel_id)) throw notFound();
    return row;
  }
  private available() { return or(isNull(assets.processing_token), sql`${assets.processing_until} <= now()`); }
  private claim(id: string, token: string) {
    return and(eq(assets.id, id), eq(assets.processing_token, token), gt(assets.processing_until, sql`now()`));
  }
  private async processing<T>(id: string, work: (row: Asset, token: string) => Promise<T>, skipBusy = false): Promise<T | undefined> {
    const token = randomUUID(), deadline = Date.now() + 15_000;
    let row: Asset | undefined;
    do {
      [row] = await this.db.update(assets).set({ processing_token: token, processing_until: sql`now()+interval '30 seconds'` })
        .where(and(eq(assets.id, id), this.available())).returning();
      if (row) break;
      if (skipBusy) return undefined;
      if (!(await this.db.select({ id: assets.id }).from(assets).where(eq(assets.id, id))).length) throw notFound();
      if (Date.now() >= deadline) throw new AppError(503, 'asset_processing_busy');
      await delay(25);
    } while (!row);
    if ((processingCounts.get(this.pool) ?? 0) >= 4) {
      await this.db.update(assets).set({ processing_token: null, processing_until: null }).where(eq(assets.processing_token, token));
      throw new AppError(503, 'asset_processing_busy');
    }
    processingCounts.set(this.pool, (processingCounts.get(this.pool) ?? 0) + 1);
    let lost = false, renewing: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (renewing || lost) return;
      renewing = this.db.update(assets).set({ processing_until: sql`now()+interval '30 seconds'` })
        .where(this.claim(id, token)).returning({ id: assets.id })
        .then(rows => { if (!rows.length) lost = true; }, () => { lost = true; }).finally(() => { renewing = undefined; });
    }, 5000);
    timer.unref();
    try {
      const result = await work(row, token);
      if (lost) throw new AppError(409, 'asset_processing_expired');
      return result;
    } finally {
      clearInterval(timer);
      processingCounts.set(this.pool, (processingCounts.get(this.pool) ?? 1) - 1);
      await renewing;
      await this.db.update(assets).set({ processing_token: null, processing_until: null })
        .where(and(eq(assets.id, id), eq(assets.processing_token, token)));
    }
  }
  async complete(actor: string, id: string, finalize: (stagingKey: string, finalKey: string, size: number, name: string) => Promise<AssetPreview>): Promise<AssetAttachment> {
    await this.owned(this.db, actor, id);
    const result = await this.processing(id, async (_claimed, token) => {
      const row = await this.owned(this.db, actor, id);
      if (!row.message_id && row.expires_at <= new Date()) throw new AppError(410, 'upload_expired');
      if (row.status === 'pending') {
        const preview = await finalize(row.staging_key, row.object_key, row.size, row.name);
        const current = await this.owned(this.db, actor, id);
        if (!current.message_id && current.expires_at <= new Date()) throw new AppError(410, 'upload_expired');
        const saved = await this.db.update(assets).set({ status: 'ready', preview })
          .where(and(this.claim(id, token), eq(assets.status, 'pending'))).returning({ id: assets.id });
        if (!saved.length) throw new AppError(409, 'asset_processing_expired');
      }
      return assetAttachment(row);
    });
    return result!;
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
    const current = await this.download(actor, id);
    if (current.preview) return current.preview;
    const result = await this.processing(id, async (row, token) => {
      await this.assertAccess(this.db, actor, row);
      if (row.preview) return row.preview;
      const preview = await generate(row);
      await this.download(actor, id);
      const saved = await this.db.update(assets).set({ preview }).where(this.claim(id, token)).returning({ id: assets.id });
      if (!saved.length) throw new AppError(409, 'asset_processing_expired');
      return preview;
    });
    return result!;
  }
  async pdfThumbnail(actor: string, id: string, generate: (asset: Asset) => Promise<boolean>): Promise<boolean> {
    const current = await this.download(actor, id);
    if (current.preview?.kind !== 'pdf') throw new AppError(415, 'preview_unavailable');
    if (current.preview.thumbnail !== undefined) return current.preview.thumbnail;
    const result = await this.processing(id, async (row, token) => {
      await this.assertAccess(this.db, actor, row);
      if (row.preview?.kind !== 'pdf') throw new AppError(415, 'preview_unavailable');
      if (row.preview.thumbnail !== undefined) return row.preview.thumbnail;
      const thumbnail = await generate(row);
      await this.download(actor, id);
      const saved = await this.db.update(assets).set({ preview: { ...row.preview, thumbnail } })
        .where(this.claim(id, token)).returning({ id: assets.id });
      if (!saved.length) throw new AppError(409, 'asset_processing_expired');
      return thumbnail;
    });
    return result!;
  }
  async cleanup(remove: (key: string) => Promise<void>, limit = 20, assetId?: string): Promise<number> {
    let cleaned = 0;
    for (let i = 0; i < (assetId ? 1 : limit); i++) {
      const [candidate] = await this.db.select({ id: assets.id }).from(assets).where(and(assetId ? eq(assets.id, uuid(assetId)) : undefined, this.available(), or(
          and(isNull(assets.message_id), lt(assets.expires_at, sql`now()`)),
          and(eq(assets.status, 'ready'), isNull(assets.staging_deleted_at), lt(assets.upload_expires_at, sql`now()`)),
        ))).orderBy(assets.expires_at).limit(1);
      if (!candidate) break;
      const found = await this.processing(candidate.id, async (row, token) => {
        const expired = !row.message_id && row.expires_at <= new Date();
        if (!expired && (row.status !== 'ready' || row.staging_deleted_at || row.upload_expires_at > new Date())) return false;
        await remove(row.staging_key);
        if (expired) {
          await remove(row.object_key);
          await remove(`previews/${row.id}/display.webp`);
          await remove(`previews/${row.id}/thumbnail.webp`);
          const deleted = await this.db.delete(assets).where(and(this.claim(row.id, token), isNull(assets.message_id), lt(assets.expires_at, sql`now()`))).returning({ id: assets.id });
          if (!deleted.length) throw new AppError(409, 'asset_processing_expired');
        } else {
          const saved = await this.db.update(assets).set({ staging_deleted_at: new Date() }).where(this.claim(row.id, token)).returning({ id: assets.id });
          if (!saved.length) throw new AppError(409, 'asset_processing_expired');
        }
        return true;
      }, true);
      if (found) cleaned++;
    }
    return cleaned;
  }
}
