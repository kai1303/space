import type { FastifyInstance } from 'fastify';
import { AppError, MAX_ASSET_BYTES, MAX_MESSAGE_ASSETS, record, uuid } from '@space/contracts';
import { AssetStore, assetAttachment } from '@space/postgres/assets';
import type { AssetStorage } from './storage.js';
import { generateAssetPreview } from './previews.js';
import { type OfficeSettings, officeSession, officeContentUrl, officeRequest, readOfficeResult, OFFICE_CALLBACK, OFFICE_CONTENT } from './office.js';
import { generatePdfThumbnail } from './pdf-thumbnail.js';

function pdfRange(value: string, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return;
  const first = Number(match[1]), last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return;
  if (!match[1]) return last > 0 ? { start: Math.max(0, size - last), end: size - 1 } : undefined;
  if (first >= size || (match[2] && last < first)) return;
  return { start: first, end: match[2] ? Math.min(last, size - 1) : size - 1 };
}

export function registerAssetRoutes(app: FastifyInstance, assets: AssetStore, storage?: AssetStorage, office?: OfficeSettings) {
  const enabled = () => { if (!storage) throw new AppError(503, 'uploads_unavailable'); return storage; };
  app.get('/v1/assets/config', async () => ({ enabled: !!storage, max_file_size: MAX_ASSET_BYTES, max_files: MAX_MESSAGE_ASSETS }));
  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/assets', r => assets.list(r.actorId, uuid(r.params.channelId), r.query));
  app.post<{ Params: { channelId: string } }>('/v1/channels/:channelId/assets', async (r, reply) => {
    const backend = enabled();
    const row = await assets.create(r.actorId, uuid(r.params.channelId), r.body);
    const upload = await backend.createUpload(row.staging_key, row.size, row.upload_expires_at);
    return reply.code(201).send({ asset: assetAttachment(row), upload, expires_at: row.upload_expires_at.toISOString() });
  });
  app.post<{ Params: { assetId: string } }>('/v1/assets/:assetId/complete', async r => {
    const backend = enabled();
    record(r.body, []);
    const id = uuid(r.params.assetId);
    return assets.complete(r.actorId, id, async (from, to, size, name) => {
      await backend.finalize(from, to, size);
      return generateAssetPreview(backend, id, name, to, size);
    });
  });
  app.get<{ Params: { assetId: string } }>('/v1/assets/:assetId/download', async (r, reply) => {
    const backend = enabled();
    const row = await assets.download(r.actorId, uuid(r.params.assetId));
    if (row.preview?.kind === 'office' && !(r.query as { original?: string }).original) {
      const bytes = await assets.officeContent(row.id);
      if (bytes) return reply.type('application/octet-stream')
        .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`).send(bytes);
    }
    return reply.redirect(await backend.download(row.object_key, row.name));
  });
  const previewFor = (actor: string, id: string) => {
    const backend = enabled();
    return assets.preview(actor, id, row => generateAssetPreview(backend, row.id, row.name, row.object_key, row.size));
  };
  app.get<{ Params: { assetId: string } }>('/v1/assets/:assetId/preview', async r => {
    record(r.query, []);
    const preview = await previewFor(r.actorId, uuid(r.params.assetId));
    return preview.kind === 'office' && !office ? { kind: 'unsupported', reason: 'Office viewer is unavailable.' } : preview;
  });
  app.get<{ Params: { assetId: string } }>('/v1/assets/:assetId/office-session', async (r, reply) => {
    const query = record(r.query, ['mode']);
    if (query.mode !== undefined && query.mode !== 'edit') throw new AppError(400, 'invalid_mode');
    const backend = enabled(), id = uuid(r.params.assetId);
    const preview = await previewFor(r.actorId, id);
    if (preview.kind !== 'office' || !office) throw new AppError(415, 'preview_unavailable');
    const access = await assets.officeAccessFor(r.actorId, id);
    const editing = query.mode === 'edit';
    if (editing && (!office.callbackBase || !access.canEdit)) throw new AppError(403, 'office_edit_forbidden');
    const source = access.revision ? officeContentUrl(office, id, access.revision) : await backend.download(access.row.object_key, access.row.name, 'onlyoffice');
    const name = (await assets.pool.query<{display_name:string}>('SELECT display_name FROM users WHERE id=$1', [r.actorId])).rows[0]?.display_name;
    const session = await officeSession(office, id, access.row.name, preview.fileType, source, {
      selectionAgent: r.headers['x-space-office-agent'] === 'selection',
      revision: access.revision, epoch: access.epoch, edit: editing, actor: r.actorId, name: name ?? 'Member', dark: r.headers['x-space-theme'] === 'dark',
    });
    reply.header('cache-control', 'private, no-store');
    return { ...session, revision: access.revision, canEdit: Boolean(office.callbackBase && access.canEdit),
      canShare: Boolean(office.callbackBase && access.canShare), channelEditing: access.channelEditing };
  });
  app.put<{ Params: { assetId: string } }>('/v1/assets/:assetId/office-sharing', async (r, reply) => {
    const { enabled } = record(r.body, ['enabled']);
    if (!office?.callbackBase || typeof enabled !== 'boolean') throw new AppError(400, 'invalid_office_sharing');
    await assets.shareOffice(r.actorId, uuid(r.params.assetId), enabled);
    return reply.code(204).send();
  });
  app.get<{ Params: { assetId: string; revision: string } }>(OFFICE_CONTENT, async (r, reply) => {
    if (!office?.callbackBase) throw new AppError(404, 'not_found');
    const payload = await officeRequest(office, r.headers.authorization, 'download');
    const id = uuid(r.params.assetId), revision = Number(r.params.revision);
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > 2147483647 ||
        payload.url !== officeContentUrl(office, id, revision)) throw new AppError(403, 'invalid_office_request');
    const bytes = await assets.officeContent(id, revision);
    if (!bytes) throw new AppError(404, 'not_found');
    return reply.type('application/octet-stream').send(bytes);
  });
  let activeSaves = 0;
  app.post(OFFICE_CALLBACK, async (r, reply) => {
    if (!office?.callbackBase) throw new AppError(404, 'not_found');
    const event = await officeRequest(office, r.headers.authorization, 'callback');
    const match = typeof event.key === 'string' && /^([0-9a-f-]{36})\.edit\.(\d{1,10})(?:\.(\d{1,10}))?$/.exec(event.key);
    if (!match) throw new AppError(400, 'invalid_office_key');
    if (event.status === 1 || event.status === 4) return { error: 0 };
    if (event.status !== 2) return { error: 1 };
    if (activeSaves >= 4) return reply.code(503).send({ error: 1 });
    activeSaves++;
    try {
      const id = uuid(match[1]), revision = Number(match[2]), epoch = Number(match[3] ?? 0);
      const actor = uuid(Array.isArray(event.users) && event.users[0]);
      const access = await assets.officeAccessFor(actor, id);
      if (!access.canEdit || access.epoch !== epoch || access.row.preview?.kind !== 'office') throw new AppError(403, 'office_edit_forbidden');
      if (access.revision > revision) return { error: 0 };
      if (access.revision !== revision) throw new AppError(409, 'office_revision_conflict');
      const bytes = await readOfficeResult(office, event.url, access.row.preview.fileType);
      await assets.saveOffice(actor, id, revision, epoch, bytes);
      return { error: 0 };
    } finally { activeSaves--; }
  });
  app.route<{ Params: { assetId: string } }>({ method: ['GET', 'HEAD'], url: '/v1/assets/:assetId/content', handler: async (r, reply) => {
    record(r.query, []);
    const backend = enabled(), id = uuid(r.params.assetId);
    const row = await assets.download(r.actorId, id);
    // HEAD never backfills legacy metadata by downloading private object bytes.
    const preview = row.preview ?? (r.method === 'HEAD' ? undefined : await previewFor(r.actorId, id));
    if (!preview || preview.kind === 'office' || preview.kind === 'text' || preview.kind === 'unsupported') throw new AppError(415, 'preview_unavailable');
    if (preview.kind === 'pdf') {
      reply.type('application/pdf').header('content-disposition', 'attachment').header('accept-ranges', 'bytes');
      if (r.method === 'HEAD') return reply.header('content-length', row.size).send();
      const range = r.headers.range === undefined ? undefined : pdfRange(r.headers.range, row.size);
      if (r.headers.range !== undefined && !range) {
        reply.header('content-range', `bytes */${row.size}`);
        throw new AppError(416, 'range_not_satisfiable');
      }
      // Keep canvas fetches same-origin; redirected private-object GETs can lose CORS headers.
      const bytes = await backend.read(row.object_key, range ? range.end - range.start + 1 : MAX_ASSET_BYTES, range);
      if (range) reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${row.size}`);
      return reply.header('content-length', bytes.byteLength).send(Buffer.from(bytes));
    }
    const key = preview.kind === 'image' && preview.mime === 'image/webp' ? `previews/${id}/display.webp` : row.object_key;
    return reply.redirect(await backend.inline(key, preview.mime));
  } });
  app.get<{ Params: { assetId: string } }>('/v1/assets/:assetId/thumbnail', async (r, reply) => {
    record(r.query, []);
    const backend = enabled(), id = uuid(r.params.assetId);
    const preview = await previewFor(r.actorId, id);
    if (preview.kind === 'pdf') {
      const ready = await assets.pdfThumbnail(r.actorId, id, row => generatePdfThumbnail(backend, row.id, row.object_key, row.size));
      if (!ready) throw new AppError(415, 'preview_unavailable');
      await assets.download(r.actorId, id);
      return reply.redirect(await backend.inline(`previews/${id}/thumbnail.webp`, 'image/webp'));
    }
    if (preview.kind !== 'image') throw new AppError(415, 'preview_unavailable');
    const file = preview.mime === 'image/webp' && preview.width <= 360 && preview.height <= 240 ? 'display.webp' : 'thumbnail.webp';
    return reply.redirect(await backend.inline(`previews/${id}/${file}`, 'image/webp'));
  });

}
