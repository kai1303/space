import { sessionTransaction } from './session-concurrency.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { AppError, parseAssetName, parseAssetInput, parseAssetDescriptions, record, type AssetDetails, parseAssetListQuery, uuid, type AssetAttachment, type AssetPreview, type ChannelFile, type Page } from '@space/contracts';
import { database, type DbSession } from './database.js';
import { readChannelPermissions } from './channel-permissions.js';
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
          query.kind === 'all' ? undefined : query.kind === 'other' ? sql`${previewKind} in ('unsupported', 'file', 'office')` : eq(previewKind, query.kind)))
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
        .where(and(eq(assets.workspace_id, channel.workspace_id), eq(assets.uploader_id, actor), isNull(assets.message_id), isNull(assets.task_id), sql`${assets.expires_at} > now()`)).limit(20);
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
      if (!row.message_id && !row.task_id && !row.queue_input_id && row.expires_at <= new Date()) throw new AppError(410, 'upload_expired');
      if (row.status === 'pending') {
        const preview = await finalize(row.staging_key, row.object_key, row.size, row.name);
        const current = await this.owned(this.db, actor, id);
        if (!current.message_id && !current.task_id && !current.queue_input_id && current.expires_at <= new Date()) throw new AppError(410, 'upload_expired');
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
    if (!row.message_id && !row.task_id && (row.uploader_id !== actor || (!row.queue_input_id && row.expires_at <= new Date()))) throw notFound();
  }
  private async readDetails(c: DbSession, actor: string, id: string): Promise<AssetDetails> {
    const [row] = await c.select().from(assets).where(eq(assets.id, id));
    await this.assertAccess(c, actor, row);
    const detail = await c.execute<AssetDetails>(sql`
      SELECT a.id, a.name, a.size, a.type, a.channel_id, m.thread_id, u.display_name AS uploader,
        to_json(coalesce(m.created_at,a.created_at)) #>> '{}' AS shared_at,
        a.uploader_id=${actor} AND m.id IS NOT NULL AND ch.archived_at IS NULL AS can_edit,
        coalesce((SELECT item->>'description' FROM jsonb_array_elements(m.attachments) item
          WHERE item->>'id'=a.id::text),'') AS description
      FROM assets a JOIN users u ON u.id=a.uploader_id JOIN channels ch ON ch.id=a.channel_id
      LEFT JOIN messages m ON m.channel_id=a.channel_id AND m.id=a.message_id
      WHERE a.id=${id}`);
    if (!detail.rows.length) throw notFound();
    return detail.rows[0]!;
  }
  details(actor: string, id: string) {
    return this.db.transaction(c => this.readDetails(c, actor, id));
  }
  editDetails(actor: string, id: string, input: unknown) {
    const body = record(input, ['name','description','previous_name','previous_description']);
    const name = parseAssetName(body.name);
    const description = parseAssetDescriptions({ [id]: body.description }, [id])?.[id] ?? '';
    return sessionTransaction(this.db, async c => {
      const current = await this.readDetails(c, actor, id);
      if (!current.can_edit) throw new AppError(403, 'file_edit_forbidden');
      if (name === current.name && description === current.description) return current;
      if (current.name !== body.previous_name || current.description !== body.previous_description)
        throw new AppError(409, 'file_details_changed');
      const [asset] = await c.update(assets).set({ name }).where(eq(assets.id, id)).returning();
      const { channel_id: channel, workspace_id: workspace, message_id: message } = asset!;
      const revision = await c.execute<{ seq: string }>(sql`UPDATE channels SET event_sequence=event_sequence+1
        WHERE id=${channel} RETURNING event_sequence::text AS seq`);
      const seq = revision.rows[0]!.seq;
      const updated = await c.execute(sql`UPDATE messages SET reaction_sequence=${seq}::bigint,
        attachments=(SELECT jsonb_agg(CASE WHEN item->>'id'=${id} THEN
          (item-'description') || jsonb_strip_nulls(jsonb_build_object('name',${name}::text,'description',nullif(${description}::text,'')))
          ELSE item END ORDER BY pos) FROM jsonb_array_elements(attachments) WITH ORDINALITY entry(item,pos))
        WHERE channel_id=${channel} AND id=${message} AND deleted_at IS NULL AND retained_at IS NULL RETURNING id`);
      if (!updated.rows.length) throw notFound();
      await c.execute(sql`INSERT INTO channel_events(workspace_id,channel_id,thread_id,sequence,type,payload)
        SELECT workspace_id,channel_id,thread_id,${seq}::bigint,'message.updated',chat_message_payload(m)
        FROM messages m WHERE channel_id=${channel} AND id=${message}`);
      await c.execute(sql`INSERT INTO chat_delivery_outbox(workspace_id,channel_id,resource_scope) VALUES(${workspace},${channel},'metadata')`);
      return { ...current, name, description };
    });
  }
  private async officeAccess(c: DbSession, actor: string, id: string) {
    const [row] = await c.select().from(assets).where(eq(assets.id, uuid(id)));
    await this.assertAccess(c, actor, row);
    const state = (await c.execute<{ revision: number; edit_epoch: number; channel_editing: boolean }>(sql`
      SELECT revision, edit_epoch, channel_editing FROM office_edits WHERE asset_id=${id}`)).rows[0];
    const owner = row!.uploader_id === actor;
    const channelEditing = state?.channel_editing ?? false;
    let canWrite = false;
    if (row!.message_id && row!.preview?.kind === 'office') {
      const [channel] = await c.select({ kind: channels.kind }).from(channels).where(eq(channels.id, row!.channel_id));
      if (channel?.kind === 'channel') {
        canWrite = (await readChannelPermissions(c, actor, row!.channel_id)).capabilities.post;
      }
    }
    return { row: row!, revision: state?.revision ?? 0, epoch: state?.edit_epoch ?? 0, channelEditing,
      canShare: owner && canWrite, canEdit: canWrite && (owner || channelEditing) };
  }
  officeAccessFor(actor: string, id: string) {
    return this.officeAccess(this.db, actor, id);
  }
  async shareOffice(actor: string, id: string, share: boolean) {
    return sessionTransaction(this.db, async c => {
      if (!(await this.officeAccess(c, actor, id)).canShare) throw new AppError(403, 'office_edit_forbidden');
      await c.execute(sql`INSERT INTO office_edits(asset_id,channel_editing) VALUES(${id},${share})
        ON CONFLICT(asset_id) DO UPDATE SET channel_editing=excluded.channel_editing,
          edit_epoch=office_edits.edit_epoch + (office_edits.channel_editing AND NOT excluded.channel_editing)::integer`);
    });
  }
  async saveOffice(actor: string, id: string, revision: number, epoch: number, content: Buffer) {
    return sessionTransaction(this.db, async c => {
      const access = await this.officeAccess(c, actor, id);
      if (!access.canEdit || access.epoch !== epoch) throw new AppError(403, 'office_edit_forbidden');
      // A finalized session has exactly one result. Replayed callbacks cannot move the head.
      if (access.revision > revision) return;
      if (access.revision !== revision) throw new AppError(409, 'office_revision_conflict');
      await c.execute(sql`INSERT INTO office_edits(asset_id,revision,content)
        VALUES(${id},${revision + 1},${content})
        ON CONFLICT(asset_id) DO UPDATE SET revision=excluded.revision, content=excluded.content
        WHERE office_edits.revision=${revision}`);
    });
  }
  async officeContent(id: string, revision?: number): Promise<Buffer | undefined> {
    const result = await this.pool.query<{ content: Buffer }>(
      'SELECT content FROM office_edits WHERE asset_id=$1 AND revision>0 AND ($2::integer IS NULL OR revision=$2)',
      [uuid(id), revision ?? null]);
    return result.rows[0]?.content;
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
          and(isNull(assets.message_id), isNull(assets.task_id), isNull(assets.queue_input_id), lt(assets.expires_at, sql`now()`)),
          and(eq(assets.status, 'ready'), isNull(assets.staging_deleted_at), lt(assets.upload_expires_at, sql`now()`)),
        ))).orderBy(assets.expires_at).limit(1);
      if (!candidate) break;
      const found = await this.processing(candidate.id, async (row, token) => {
        const expired = !row.message_id && !row.task_id && !row.queue_input_id && row.expires_at <= new Date();
        if (!expired && (row.status !== 'ready' || row.staging_deleted_at || row.upload_expires_at > new Date())) return false;
        await remove(row.staging_key);
        if (expired) {
          await remove(row.object_key);
          await remove(`previews/${row.id}/display.webp`);
          await remove(`previews/${row.id}/thumbnail.webp`);
          const deleted = await this.db.delete(assets).where(and(this.claim(row.id, token), isNull(assets.message_id), isNull(assets.task_id), isNull(assets.queue_input_id), lt(assets.expires_at, sql`now()`))).returning({ id: assets.id });
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
