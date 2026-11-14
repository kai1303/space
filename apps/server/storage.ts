import { AppError } from '@space/contracts';
import {
  CreateBucketCommand, DeleteObjectCommand, GetObjectCommand,
  HeadBucketCommand, HeadObjectCommand, PutBucketCorsCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface AssetStorage {
  createUpload(key: string, size: number, expiresAt?: Date): Promise<{ url: string; fields: Record<string, string> }>;
  // Retries and concurrent processors must reuse sealed originals, never overwrite them.
  finalize(stagingKey: string, finalKey: string, size: number): Promise<void>;
  download(key: string, name: string, audience?: 'onlyoffice'): Promise<string>;
  read(key: string, maxBytes: number, range?: { start: number; end: number }, expectedEtag?: string, signal?: AbortSignal): Promise<Uint8Array>;
  write(key: string, data: Uint8Array, type: string): Promise<void>;
  inline(key: string, type: string): Promise<string>;
  remove(key: string): Promise<void>;
}

type StorageConfig = {
  endpoint: string; publicEndpoint: string; officeEndpoint?: string; bucket: string;
  accessKey: string; secretKey: string; origins: string[];
};
const maxSize = 25 * 1024 * 1024;
const previewTypes = new Set([
  'image/webp', 'image/gif', 'application/pdf',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4', 'audio/webm',
  'video/mp4', 'video/webm', 'video/ogg',
]);
const validatePreviewType = (type: string) => {
  if (!previewTypes.has(type)) throw new AppError(400, 'invalid_preview_type');
};
const statusOf = (error: unknown) => (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
const validateSize = (size: number) => {
  if (!Number.isSafeInteger(size) || size < 1 || size > maxSize) throw new AppError(409, 'invalid_upload');
};

export class SeaweedStorage implements AssetStorage {
  private readonly client: S3Client;
  private readonly publicClient: S3Client;
  private readonly officeClient: S3Client;
  constructor(private readonly config: StorageConfig) {
    const options = {
      region: 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
      requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 },
    };
    this.client = new S3Client({ ...options, endpoint: config.endpoint });
    this.officeClient = config.officeEndpoint ? new S3Client({ ...options, endpoint: config.officeEndpoint }) : this.client;
    this.publicClient = new S3Client({ ...options, endpoint: config.publicEndpoint });
  }
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'storage_unavailable');
    }
  }
  async initialize(): Promise<void> {
    await this.run(async () => {
      try { await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket })); }
      catch (error) {
        if (statusOf(error) !== 404) throw error;
        try { await this.client.send(new CreateBucketCommand({ Bucket: this.config.bucket })); }
        catch (createError) {
          if ((createError as Error).name !== 'BucketAlreadyOwnedByYou') throw createError;
        }
      }
      await this.client.send(new PutBucketCorsCommand({
        Bucket: this.config.bucket,
        CORSConfiguration: { CORSRules: [{
          AllowedOrigins: this.config.origins, AllowedMethods: ['POST', 'GET', 'HEAD'],
          AllowedHeaders: ['Content-Type'], ExposeHeaders: ['ETag', 'Content-Disposition'], MaxAgeSeconds: 300,
        }] },
      }));
    });
  }
  async createUpload(key: string, size: number, expiresAt = new Date(Date.now() + 300_000)): Promise<{ url: string; fields: Record<string, string> }> {
    validateSize(size);
    // Keep signing inside the database deadline used to retire staging objects.
    const seconds = Math.min(300, Math.floor((expiresAt.getTime() - Date.now()) / 1000) - 1);
    if (!Number.isFinite(seconds) || seconds < 1) throw new AppError(410, 'upload_expired');
    return this.run(async () => {
      const upload = await createPresignedPost(this.publicClient, {
        Bucket: this.config.bucket, Key: key, Expires: seconds,
        Fields: { 'Content-Type': 'application/octet-stream' },
        Conditions: [['content-length-range', size, size], { 'Content-Type': 'application/octet-stream' }],
      });
      const expiration = Date.parse(JSON.parse(Buffer.from(upload.fields.Policy!, 'base64').toString()).expiration);
      if (expiration > expiresAt.getTime() || expiration <= Date.now()) throw new AppError(410, 'upload_expired');
      return upload;
    });
  }
  async finalize(stagingKey: string, finalKey: string, size: number): Promise<void> {
    validateSize(size);
    await this.run(async () => {
      // A retried or expired processor must never overwrite already sealed bytes.
      try {
        const existing = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: finalKey }));
        if (existing.ContentLength !== size) throw new AppError(409, 'invalid_upload');
        return;
      } catch (error) { if (statusOf(error) !== 404) throw error; }
      let source;
      try { source = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: stagingKey })); }
      catch (error) {
        if (statusOf(error) === 404) throw new AppError(409, 'upload_not_ready');
        throw error;
      }
      if (source.ContentLength !== size || !source.ETag) throw new AppError(409, 'invalid_upload');
      const bytes = await this.read(stagingKey, size, undefined, source.ETag);
      if (bytes.length !== size) throw new AppError(409, 'invalid_upload');
      try {
        await this.client.send(new PutObjectCommand({
          Bucket: this.config.bucket, Key: finalKey, Body: bytes, IfNoneMatch: '*',
          ContentType: 'application/octet-stream', ContentDisposition: 'attachment',
        }));
      } catch (error) {
        // Another claimant may have sealed this object first.
        if (![409, 412].includes(statusOf(error) ?? 0)) throw error;
      }
      const final = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: finalKey }));
      if (final.ContentLength !== size) throw new AppError(409, 'invalid_upload');
    });
  }
  async download(key: string, name: string, audience?: 'onlyoffice'): Promise<string> {
    const encodedName = encodeURIComponent(Buffer.from(name).toString('utf8')).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return this.run(() => getSignedUrl(audience === 'onlyoffice' ? this.officeClient : this.publicClient, new GetObjectCommand({
      Bucket: this.config.bucket, Key: key, ResponseContentType: 'application/octet-stream',
      ResponseContentDisposition: `attachment; filename="download"; filename*=UTF-8''${encodedName}`,
    }), { expiresIn: 60 }));
  }
  async inline(key: string, type: string): Promise<string> {
    validatePreviewType(type);
    return this.run(() => getSignedUrl(this.publicClient, new GetObjectCommand({
      Bucket: this.config.bucket, Key: key, ResponseContentType: type, ResponseContentDisposition: 'inline',
    }), { expiresIn: 60 }));
  }
  async read(key: string, maxBytes: number, range?: { start: number; end: number }, expectedEtag?: string, signal?: AbortSignal): Promise<Uint8Array> {
    validateSize(maxBytes);
    if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end - range.start + 1 > maxBytes)) throw new AppError(409, 'invalid_upload');
    const expected = range ? range.end - range.start + 1 : maxBytes;
    return this.run(async () => {
      const controller = new AbortController();
      const object = await this.client.send(new GetObjectCommand({
        Bucket: this.config.bucket, Key: key, ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        ...(expectedEtag ? { IfMatch: expectedEtag } : {}),
      }), { abortSignal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal });
      const body = object.Body;
      try {
        if (range) {
          const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(object.ContentRange ?? '');
          const [start, end, total] = contentRange?.slice(1).map(Number) ?? [];
          if (object.$metadata.httpStatusCode !== 206 || !contentRange || start !== range.start || end !== range.end || !Number.isSafeInteger(total) || total === undefined || total <= range.end || object.ContentLength !== expected) throw new Error('invalid_storage_range');
        }
        if (object.ContentLength !== undefined && object.ContentLength > maxBytes) throw new AppError(409, 'invalid_upload');
        if (!body || !(Symbol.asyncIterator in body)) throw new Error('missing_storage_body');
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of body as AsyncIterable<Uint8Array>) {
          size += chunk.byteLength;
          if (range && size > expected) throw new Error('invalid_storage_range');
          if (size > maxBytes) throw new AppError(409, 'invalid_upload');
          chunks.push(chunk);
        }
        if (range && size !== expected) throw new Error('invalid_storage_range');
        return Buffer.concat(chunks, size);
      } finally {
        controller.abort();
        if (body && 'destroy' in body && typeof body.destroy === 'function') body.destroy();
      }
    });
  }
  async write(key: string, data: Uint8Array, type: string): Promise<void> {
    validatePreviewType(type);
    validateSize(data.byteLength);
    await this.run(async () => {
      await this.client.send(new PutObjectCommand({
        Bucket: this.config.bucket, Key: key, Body: data,
        ContentType: type, ContentLength: data.byteLength, ContentDisposition: 'attachment',
      }));
    });
  }
  async remove(key: string): Promise<void> {
    await this.run(async () => {
      try { await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key })); }
      catch (error) { if (statusOf(error) !== 404) throw error; }
    });
  }
}

export function createAssetStorageFromEnv(env: NodeJS.ProcessEnv = process.env): SeaweedStorage | undefined {
  const keys = ['ENDPOINT', 'PUBLIC_ENDPOINT', 'BUCKET', 'ACCESS_KEY', 'SECRET_KEY', 'ORIGINS'];
  const values = keys.map(key => env[`ASSET_STORAGE_${key}`]?.trim());
  if (values.every(value => !value)) return undefined;
  if (values.some(value => !value)) throw new Error('asset_storage_configuration');
  const [endpoint, publicEndpoint, bucket, accessKey, secretKey, originList] = values as [string, string, string, string, string, string];
  const officeEndpoint = env.ONLYOFFICE_STORAGE_ENDPOINT?.trim();
  const origins = originList.split(',').map(origin => origin.trim()).filter(Boolean);
  try {
    for (const value of [endpoint, publicEndpoint, ...(officeEndpoint ? [officeEndpoint] : []), ...origins]) {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    }
    if (!origins.length || origins.some(origin => new URL(origin).origin !== origin)) throw new Error();
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error();
  } catch { throw new Error('asset_storage_configuration'); }
  return new SeaweedStorage({ endpoint, publicEndpoint, officeEndpoint, bucket, accessKey, secretKey, origins });
}


// Keep model images readable while bounding each delivery to 150 KB per image.
export function agentImageReader(storage: AssetStorage) {
  return async (id: string, animated: boolean) => {
    const bytes = await storage.read(`previews/${id}/${animated ? 'thumbnail' : 'display'}.webp`, maxSize);
    if (bytes.length <= 150000) return Buffer.from(bytes).toString('base64');
    const {default: sharp} = await import('sharp');
    const image = await sharp(bytes).resize({width:800,height:800,fit:'inside',withoutEnlargement:true}).webp({quality:65}).toBuffer();
    if (image.length <= 150000) return image.toString('base64');
    return (await sharp(bytes).resize({width:360,height:360,fit:'inside',withoutEnlargement:true}).webp({quality:50}).toBuffer()).toString('base64');
  };
}
