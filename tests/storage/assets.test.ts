import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';
import { createAssetStorageFromEnv } from '@space/server/storage';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
const storage = createAssetStorageFromEnv();
if (!storage) throw new Error('ASSET_STORAGE_* configuration is required');

test('real API and SeaweedFS persist private attachments and seal bytes before messaging', async () => {
  const schema = `seaweed_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, storage });
  const keys: string[] = [];
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool);
    await storage.initialize();
    const a = await bootstrap(pool);
    const headers = { authorization: `Bearer ${a.owner_token}` };
    const reserve = await app.inject({ method: 'POST', url: `/v1/channels/${a.channel_id}/assets`, headers, payload: { name: 'actual.txt', size: 5, type: 'text/plain' } });
    assert.equal(reserve.statusCode, 201, reserve.body);
    const { asset, upload } = reserve.json();
    keys.push(upload.fields.key, `files/${asset.id}`);
    const transfer = async (value: string) => {
      const form = new FormData();
      for (const [key, value] of Object.entries(upload.fields)) form.append(key, value as string);
      form.append('file', new Blob([value], { type: 'application/octet-stream' }), 'actual.txt');
      const response = await fetch(upload.url, { method: 'POST', body: form });
      assert.ok(response.ok, await response.text());
    };
    await transfer('hello');
    const completed = await app.inject({ method: 'POST', url: `/v1/assets/${asset.id}/complete`, headers, payload: {} });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.deepEqual(completed.json(), asset);
    const input = { client_message_id: randomUUID(), text: '', asset_ids: [asset.id] };
    const sent = await app.inject({ method: 'POST', url: `/v1/channels/${a.channel_id}/messages`, headers, payload: input });
    assert.equal(sent.statusCode, 201, sent.body);
    assert.deepEqual(sent.json().attachments, [asset]);
    await transfer('other');
    const download = await app.inject({ method: 'GET', url: `/v1/assets/${asset.id}/download`, headers });
    assert.equal(download.statusCode, 302);
    const file = await fetch(download.headers.location!);
    assert.equal(file.status, 200);
    assert.equal(await file.text(), 'hello');
    assert.equal(file.headers.get('content-type'), 'application/octet-stream');
    assert.ok(file.headers.get('content-disposition')?.startsWith('attachment;'));
    const anonymous = new URL(download.headers.location!); anonymous.search = '';
    assert.equal((await fetch(anonymous)).status, 403);
    const history = await app.inject({ method: 'GET', url: `/v1/channels/${a.channel_id}/history`, headers });
    assert.deepEqual(history.json().events[0].payload.attachments, [asset]);
  } finally {
    await app.close();
    for (const key of keys) await storage.remove(key);
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

test('real API serves safe private previews for images, PDF, source and media with download fallback', async () => {
  const schema = `preview_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, storage });
  const keys: string[] = [];
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); await storage.initialize();
    const a = await bootstrap(pool), headers = { authorization: `Bearer ${a.owner_token}` };
    for (const [name, kind, mime] of [
      ['preview-image.png', 'image', 'image/webp'], ['two-pages.pdf', 'pdf', 'application/pdf'],
      ['example.ts', 'text', undefined], ['tone.wav', 'audio', 'audio/wav'],
      ['clip.mp4', 'video', 'video/mp4'], ['archive.zip', 'unsupported', undefined],
    ] as const) {
      const bytes = await readFile(new URL(`../fixtures/preview/${name}`, import.meta.url));
      const response = await app.inject({ method: 'POST', url: `/v1/channels/${a.channel_id}/assets`, headers, payload: { name, size: bytes.length, type: 'application/octet-stream' } });
      assert.equal(response.statusCode, 201, response.body);
      const { asset, upload } = response.json();
      keys.push(upload.fields.key, `files/${asset.id}`, `previews/${asset.id}/thumbnail.webp`, `previews/${asset.id}/display.webp`);
      const form = new FormData();
      for (const [key, value] of Object.entries(upload.fields)) form.append(key, value as string);
      form.append('file', new Blob([bytes]), name);
      const uploaded = await fetch(upload.url, { method: 'POST', body: form });
      assert.ok(uploaded.ok, await uploaded.text());
      const completed = await app.inject({ method: 'POST', url: `/v1/assets/${asset.id}/complete`, headers, payload: {} });
      assert.equal(completed.statusCode, 200, completed.body);
      const info = await app.inject({ method: 'GET', url: `/v1/assets/${asset.id}/preview`, headers });
      assert.equal(info.statusCode, 200, info.body);
      assert.equal(info.json().kind, kind, `${name}: ${info.body}`);
      if (mime) {
        const content = await app.inject({ method: 'GET', url: `/v1/assets/${asset.id}/content`, headers });
        if (kind === 'pdf') {
          assert.equal(content.statusCode, 200, 'PDF canvas bytes stay on the authenticated API origin');
          assert.equal(content.headers['content-type'], 'application/pdf');
          assert.equal(content.headers['content-disposition'], 'attachment');
          assert.deepEqual(content.rawPayload, bytes);
          const partial = await app.inject({ method: 'GET', url: `/v1/assets/${asset.id}/content`, headers: { ...headers, range: 'bytes=0-4' } });
          assert.equal(partial.statusCode, 206, partial.body);
          assert.equal(partial.headers['content-range'], `bytes 0-4/${bytes.length}`);
          assert.equal(partial.headers['content-length'], '5');
          assert.equal(partial.headers['accept-ranges'], 'bytes');
          assert.equal(partial.headers['cache-control'], 'no-store');
          assert.deepEqual(partial.rawPayload, bytes.subarray(0, 5));
          const head = await app.inject({ method: 'HEAD', url: `/v1/assets/${asset.id}/content`, headers });
          assert.equal(head.statusCode, 200);
          assert.equal(head.headers['content-length'], String(bytes.length));
          assert.equal(head.body, '');
          const invalid = await app.inject({ method: 'GET', url: `/v1/assets/${asset.id}/content`, headers: { ...headers, range: `bytes=${bytes.length}-` } });
          assert.equal(invalid.statusCode, 416);
          assert.equal(invalid.headers['content-range'], `bytes */${bytes.length}`);
          const thumbnail = await app.inject({ method: 'GET', url: `/v1/assets/${asset.id}/thumbnail`, headers });
          assert.equal(thumbnail.statusCode, 302, thumbnail.body);
          const rendered = await fetch(thumbnail.headers.location!);
          assert.equal(rendered.headers.get('content-type'), 'image/webp');
          assert.ok(Buffer.from(await rendered.arrayBuffer()).subarray(8, 12).equals(Buffer.from('WEBP')));
          const anonymousThumb = new URL(thumbnail.headers.location!); anonymousThumb.search = '';
          assert.equal((await fetch(anonymousThumb)).status, 403);
          const cached = await app.inject({ method: 'GET', url: `/v1/assets/${asset.id}/preview`, headers });
          assert.equal(cached.json().thumbnail, true);
          continue;
        }
        assert.equal(content.statusCode, 302);
        const inline = await fetch(content.headers.location!);
        assert.equal(inline.headers.get('content-type'), mime);
        assert.equal(inline.headers.get('content-disposition'), 'inline');
        if (kind === 'image') {
          const data = Buffer.from(await inline.arrayBuffer());
          assert.equal(data.subarray(8, 12).toString(), 'WEBP');
          const thumb = await app.inject({ method: 'GET', url: `/v1/assets/${asset.id}/thumbnail`, headers });
          assert.equal(thumb.statusCode, 302);
          assert.equal((await fetch(thumb.headers.location!)).headers.get('content-type'), 'image/webp');
        } else await inline.arrayBuffer();
      } else {
        const content = await app.inject({ method: 'GET', url: `/v1/assets/${asset.id}/content`, headers });
        assert.equal(content.statusCode, 415);
        if (kind === 'text') assert.ok(info.json().text.includes('<script>'));
      }
      const original = await app.inject({ method: 'GET', url: `/v1/assets/${asset.id}/download`, headers });
      assert.equal(original.statusCode, 302);
      const downloaded = await fetch(original.headers.location!);
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
    }
  } finally {
    await app.close(); for (const key of keys) await storage.remove(key);
    await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
  }
});
