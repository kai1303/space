import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CopyObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createAssetStorageFromEnv } from './dist/storage.js';
import { generateAssetPreview } from './dist/previews.js';
import sharp from 'sharp';

test('large direct uploads bind the reserved bytes, media type and deadline', async () => {
  const storage = createAssetStorageFromEnv();
  await storage.initialize();
  const key = 'staging/direct-' + randomUUID();
  const size = 1024 * 1024;
  const deadline = new Date(Date.now() + 240_000);
  try {
    const upload = await storage.createUpload(key, size, deadline);
    assert.ok(upload.put_url, 'large reservation includes a raw upload URL');
    const url = new URL(upload.put_url);
    const signedAt = url.searchParams.get('X-Amz-Date').replace(/^(....)(..)(..)T(..)(..)(..)Z$/, '$1-$2-$3T$4:$5:$6Z');
    assert.ok(Date.parse(signedAt) + Number(url.searchParams.get('X-Amz-Expires')) * 1000 <= deadline.getTime());
    const origin = process.env.ASSET_STORAGE_ORIGINS.split(',')[0].trim();
    const preflight = await fetch(url, {method: 'OPTIONS', headers: {origin, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type'}});
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    const put = (length, type = 'application/octet-stream') => fetch(url, {method: 'PUT', headers: {'content-type': type}, body: Buffer.alloc(length, 1)});
    assert.equal((await put(size - 1)).status, 403);
    assert.equal((await put(size + 1)).status, 403);
    assert.equal((await put(size, 'text/plain')).status, 403);
    assert.ok((await put(size)).ok);
    assert.equal((await storage.read(key, size)).length, size);
  } finally { await storage.remove(key); }
});

test('SeaweedFS enforces private signed transfers and finalized bytes survive staging overwrites', async () => {
  const storage = createAssetStorageFromEnv();
  assert.ok(storage, 'Export all six ASSET_STORAGE_* values from .env.example for a local test bucket');
  await storage.initialize();
  const bucket = process.env.ASSET_STORAGE_BUCKET;
  const endpoint = process.env.ASSET_STORAGE_PUBLIC_ENDPOINT.replace(/\/$/, '');
  const origin = process.env.ASSET_STORAGE_ORIGINS.split(',')[0].trim();
  const id = randomUUID();
  const staging = `staging/integration-${id}`, final = `final/integration-${id}`;
  const changed = `staging/changed-${id}`, anonymous = `staging/anonymous-${id}`;
  const conditional = `final/conditional-${id}`;
  const image = `final/image-${id}`;
  const thumbnail = `previews/${id}/thumbnail.webp`, display = `previews/${id}/display.webp`;
  const client = new S3Client({
    endpoint: process.env.ASSET_STORAGE_ENDPOINT, region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: process.env.ASSET_STORAGE_ACCESS_KEY, secretAccessKey: process.env.ASSET_STORAGE_SECRET_KEY },
  });
  try {
    const deadline = new Date(Date.now() + 294_000);
    const upload = await storage.createUpload(staging, 3, deadline);
    assert.ok(Date.parse(JSON.parse(Buffer.from(upload.fields.Policy, 'base64').toString()).expiration) <= deadline.getTime(), 'signed form respects the database reservation deadline');
    async function post(bytes, fields = upload.fields) {
      const form = new FormData();
      for (const [name, value] of Object.entries(fields)) form.append(name, value);
      form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), 'test.txt');
      return fetch(upload.url, { method: 'POST', body: form });
    }
    assert.ok((await post('abc')).ok, 'valid signed POST succeeds');
    await storage.finalize(staging, final, 3);
    let overwriteStatus;
    try {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: final, Body: 'xyz', IfNoneMatch: '*' }));
    } catch (error) { overwriteStatus = error.$metadata?.httpStatusCode; }
    assert.equal(overwriteStatus, 412, 'conditional sealing cannot replace an existing object');
    assert.ok((await post('xyz')).ok, 'the unexpired staging credential remains usable');
    await storage.finalize(staging, final, 3);
    const download = await fetch(await storage.download(final, 'résumé".txt'));
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'abc', 'staging overwrite cannot change finalized bytes');
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.match(download.headers.get('content-disposition'), /^attachment;/);
    assert.equal(Buffer.from(await storage.read(final, 3)).toString(), 'abc');
    assert.equal(Buffer.from(await storage.read(final, 1, { start: 1, end: 1 })).toString(), 'b');
    assert.equal(Buffer.from(await storage.read(final, 2, { start: 1, end: 2 })).toString(), 'bc');
    await assert.rejects(storage.read(final, 2), { status: 409, code: 'invalid_upload' });
    const imageBytes = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#804020' } }).webp().toBuffer();
    await storage.write(image, imageBytes, 'image/webp');
    assert.deepEqual(await generateAssetPreview(storage, id, 'misleading.html', image, imageBytes.length), { kind: 'image', mime: 'image/webp', width: 900, height: 600 });
    for (const [key, width, height] of [[thumbnail, 360, 240], [display, 900, 600]]) {
      const inlineUrl = await storage.inline(key, 'image/webp');
      const inline = await fetch(inlineUrl, { headers: { Origin: origin } });
      assert.equal(inline.status, 200);
      assert.equal(inline.headers.get('content-type'), 'image/webp');
      assert.equal(inline.headers.get('content-disposition'), 'inline');
      assert.equal(inline.headers.get('access-control-allow-origin'), origin);
      const meta = await sharp(Buffer.from(await inline.arrayBuffer())).metadata();
      assert.equal(meta.width, width); assert.equal(meta.height, height);
      assert.equal((await fetch(`${endpoint}/${bucket}/${key}`)).status, 403, 'preview derivatives require signed access');
      const tampered = new URL(inlineUrl);
      tampered.searchParams.set('response-content-type', 'text/html');
      assert.equal((await fetch(tampered)).status, 403, 'a signed preview cannot be changed into executable HTML');
    }
    assert.ok(!(await post('ab')).ok, 'undersized upload is rejected');
    assert.ok(!(await post('abcd')).ok, 'oversized upload is rejected');
    assert.ok(!(await post('abc', { ...upload.fields, key: changed })).ok, 'changed key is rejected');
    assert.equal((await fetch(`${endpoint}/${bucket}/${final}`)).status, 403, 'anonymous object read is denied');
    assert.equal((await fetch(`${endpoint}/${bucket}?list-type=2`)).status, 403, 'anonymous bucket list is denied');
    assert.equal((await fetch(`${endpoint}/${bucket}/${anonymous}`, { method: 'PUT', body: 'abc' })).status, 403, 'anonymous write is denied');
    const preflight = await fetch(upload.url, {
      method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    const denied = await fetch(upload.url, {
      method: 'OPTIONS', headers: { Origin: 'https://untrusted.invalid', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    let conditionalStatus;
    try {
      await client.send(new CopyObjectCommand({ Bucket: bucket, Key: conditional, CopySource: `${bucket}/${staging}`, CopySourceIfMatch: '"stale-etag"' }));
    } catch (error) { conditionalStatus = error.$metadata?.httpStatusCode; }
    assert.equal(conditionalStatus, 412, 'conditional copy rejects a stale staging ETag');
  } finally {
    client.destroy();
    const cleanup = await Promise.allSettled([staging, final, changed, anonymous, conditional, image, thumbnail, display].map(key => storage.remove(key)));
    assert.equal(cleanup.filter(result => result.status === 'rejected').length, 0, 'all integration objects are cleaned up');
  }
});

test('large concurrent completions preserve one sealed original', async () => {
  const storage = createAssetStorageFromEnv();
  const id = randomUUID();
  const sources = [`staging/test A-${id}`, `staging/test B-${id}`];
  const final = `final/test-${id}`;
  const size = 2 * 1024 * 1024;
  const buffers = [Buffer.alloc(size, 1), Buffer.alloc(size, 2)];
  try {
    await Promise.all(sources.map((key, i) => storage.write(key, buffers[i], 'image/webp')));
    const results = await Promise.all(sources.map(key => storage.finalize(key, final, size)));
    assert.ok(results.every(result => result === undefined), 'large files are copied inside storage');
    const original = Buffer.from(await storage.read(final, size));
    assert.ok(buffers.some(bytes => bytes.equals(original)));
    await storage.finalize(sources[original[0] === 1 ? 1 : 0], final, size);
    assert.deepEqual(await storage.read(final, size), original);
  } finally {
    await Promise.all([...sources, final].map(key => storage.remove(key)));
  }
});
