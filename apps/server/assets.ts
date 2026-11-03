import type { FastifyInstance } from 'fastify';
import { AppError, MAX_ASSET_BYTES, MAX_MESSAGE_ASSETS, record, uuid } from '@space/contracts';
import { AssetStore, assetAttachment } from '@space/postgres/assets';
import type { AssetStorage } from './storage.js';
import { generateAssetPreview } from './previews.js';
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

export function registerAssetRoutes(app: FastifyInstance, assets: AssetStore, storage?: AssetStorage) {
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
    return reply.redirect(await backend.download(row.object_key, row.name));
  });
  const previewFor = (actor: string, id: string) => {
    const backend = enabled();
    return assets.preview(actor, id, row => generateAssetPreview(backend, row.id, row.name, row.object_key, row.size));
  };
  app.get<{ Params: { assetId: string } }>('/v1/assets/:assetId/preview', r => {
    record(r.query, []);
    return previewFor(r.actorId, uuid(r.params.assetId));
  });
  app.route<{ Params: { assetId: string } }>({ method: ['GET', 'HEAD'], url: '/v1/assets/:assetId/content', handler: async (r, reply) => {
    record(r.query, []);
    const backend = enabled(), id = uuid(r.params.assetId);
    const row = await assets.download(r.actorId, id);
    // HEAD never backfills legacy metadata by downloading private object bytes.
    const preview = row.preview ?? (r.method === 'HEAD' ? undefined : await previewFor(r.actorId, id));
    if (!preview || preview.kind === 'text' || preview.kind === 'unsupported') throw new AppError(415, 'preview_unavailable');
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

  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  const cleanup = () => {
    if (running || !storage) return;
    running = assets.cleanup(key => storage.remove(key)).then(() => {}, () => { app.log.error('asset_cleanup_failed'); }).finally(() => { running = undefined; });
  };
  app.addHook('onReady', async () => {
    if (!storage) return;
    cleanup();
    timer = setInterval(cleanup, 60_000);
    timer.unref();
  });
  app.addHook('preClose', async () => { clearInterval(timer); await running; });
}
