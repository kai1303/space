import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { io } from 'socket.io-client';
import { AppError } from '@space/contracts';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { AssetStore } from '@space/postgres/assets';
import { PostgresStore } from '@space/postgres/store';
import { WorkspaceStore } from '@space/postgres/workspace';
import { createApi } from '@space/server/api';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
const schema = `assets_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const objects = new Map<string, number>();
const removed: string[] = [];
const contents = new Map<string, Uint8Array>();
let reads = 0;
const readRanges: ({ start: number; end: number } | undefined)[] = [];
const storage = {
  async createUpload(key: string, size: number) { return { url: 'http://storage.test/assets', fields: { key, size: String(size) } }; },
  async finalize(from: string, to: string, size: number) {
    if (!objects.has(from)) throw new AppError(409, 'upload_not_ready');
    if (objects.get(from) !== size) throw new AppError(409, 'invalid_upload');
    objects.set(to, size);
    contents.set(to, contents.get(from) ?? Buffer.alloc(size));
  },
  async read(key: string, maxBytes: number, range?: { start: number; end: number }) { reads++; readRanges.push(range); const full = contents.get(key) ?? Buffer.alloc(objects.get(key) ?? 0); const data = range ? full.subarray(range.start, range.end + 1) : full; if (data.length > maxBytes) throw new AppError(409, 'invalid_upload'); return data; },
  async write(key: string, data: Uint8Array) { objects.set(key, data.length); contents.set(key, data); },
  async inline(key: string) { return `http://storage.test/inline/${key}`; },
  async download(key: string) { return `http://storage.test/download/${key}`; },
  async remove(key: string) { removed.push(key); objects.delete(key); contents.delete(key); },
};
const office = { url: 'https://docs.example.test', callbackBase: 'http://space.test', secret: randomBytes(32).toString('hex') };
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, storage, office });
let address: string;
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); address = await app.listen({ host: '127.0.0.1', port: 0 }); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
async function api(token: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: object, status = 200) {
  const response = await app.inject({ method, url: `/v1${path}`, headers: { authorization: `Bearer ${token}` }, ...(body ? { payload: body } : {}) });
  assert.equal(response.statusCode, status, `${path}: ${response.body}`);
  return response;
}
async function upload(seed: Awaited<ReturnType<typeof bootstrap>>, token = seed.owner_token) {
  const created = (await api(token, 'POST', `/channels/${seed.channel_id}/assets`, { name: 'hello.txt', size: 12, type: 'text/plain' }, 201)).json();
  objects.set(created.upload.fields.key, 12);
  const asset = (await api(token, 'POST', `/assets/${created.asset.id}/complete`, {})).json();
  return { created, asset };
}

test('descriptions and file order persist in messages, replay and the file library with idempotent retries', async () => {
  const a = await bootstrap(pool);
  const first = (await upload(a)).asset, second = (await upload(a)).asset;
  const input = { client_message_id: randomUUID(), text: '', asset_ids: [second.id, first.id], asset_descriptions: { [second.id]: 'A blue square' } };
  const sent = (await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, input, 201)).json();
  assert.deepEqual(sent.attachments, [{ ...second, description: 'A blue square' }, first]);
  assert.deepEqual((await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, input, 201)).json(), sent);
  await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { ...input, asset_descriptions: { [second.id]: 'Changed' } }, 409);
  const history = (await api(a.collaborator_token, 'GET', `/channels/${a.channel_id}/history`)).json();
  assert.deepEqual(history.events[0].payload.attachments, sent.attachments);
  const listing = (await api(a.owner_token, 'GET', `/channels/${a.channel_id}/assets`)).json();
  assert.equal(listing.items.find((file: { id: string }) => file.id === second.id).description, 'A blue square');
  const workspaceFiles = (await api(a.owner_token, 'GET', `/workspaces/${a.workspace_id}/hub/files`)).json();
  assert.equal(workspaceFiles.items.find((file: { id: string }) => file.id === second.id).description, 'A blue square');
});

test('PDF thumbnails are private, generated once on demand, and cache conversion failures', async () => {
  const outsider = await bootstrap(pool);
  for (const valid of [true, false]) {
    const a = await bootstrap(pool);
    const bytes = valid ? await readFile(new URL('../fixtures/preview/two-pages.pdf', import.meta.url)) : Buffer.from('%PDF-1.7\ninvalid');
    const created = (await api(a.owner_token, 'POST', `/channels/${a.channel_id}/assets`, { name: 'report.pdf', size: bytes.length }, 201)).json();
    objects.set(created.upload.fields.key, bytes.length); contents.set(created.upload.fields.key, bytes);
    await api(a.owner_token, 'POST', `/assets/${created.asset.id}/complete`, {});
    const url = `/assets/${created.asset.id}/thumbnail`;
    const before = reads;
    await api(outsider.owner_token, 'GET', url, undefined, 404);
    assert.equal(reads, before, 'unauthorized requests do not read storage');
    assert.equal(contents.has(`previews/${created.asset.id}/thumbnail.webp`), false, 'upload and metadata do not convert PDFs');
    const statuses = await Promise.all([api(a.owner_token, 'GET', url, undefined, valid ? 302 : 415), api(a.owner_token, 'GET', url, undefined, valid ? 302 : 415)]);
    assert.equal(reads, before + 1, 'concurrent requests share one conversion');
    if (valid) assert.match(statuses[0].headers.location!, /thumbnail\.webp$/);
    assert.equal((await api(a.owner_token, 'GET', `/assets/${created.asset.id}/preview`)).json().thumbnail, valid);
    await api(a.owner_token, 'GET', url, undefined, valid ? 302 : 415);
    assert.equal(reads, before + 1, 'persisted result avoids repeated conversion');
    await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), text: '', asset_ids: [created.asset.id] }, 201);
    await api(a.collaborator_token, 'GET', url, undefined, valid ? 302 : 415);
    await new WorkspaceStore(pool).removeMember(a.owner_id, a.workspace_id, a.collaborator_id);
    await api(a.collaborator_token, 'GET', url, undefined, 404);
  }
});

test('PDF thumbnail access is rechecked after conversion if membership is revoked during storage read', async () => {
  const a = await bootstrap(pool), bytes = await readFile(new URL('../fixtures/preview/two-pages.pdf', import.meta.url));
  const created = (await api(a.owner_token, 'POST', `/channels/${a.channel_id}/assets`, { name: 'report.pdf', size: bytes.length }, 201)).json();
  objects.set(created.upload.fields.key, bytes.length); contents.set(created.upload.fields.key, bytes);
  await api(a.owner_token, 'POST', `/assets/${created.asset.id}/complete`, {});
  await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), text: '', asset_ids: [created.asset.id] }, 201);
  const read = storage.read;
  storage.read = async (...args) => {
    const data = await read(...args);
    await new WorkspaceStore(pool).removeMember(a.owner_id, a.workspace_id, a.collaborator_id);
    return data;
  };
  try { await api(a.collaborator_token, 'GET', `/assets/${created.asset.id}/thumbnail`, undefined, 404); }
  finally { storage.read = read; }
});

test('uploads are channel scoped, completed before send, persisted in replay and downloadable by members', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  assert.equal((await api(a.owner_token, 'GET', '/assets/config')).json().enabled, true);
  await api(b.owner_token, 'POST', `/channels/${a.channel_id}/assets`, { name: 'x', size: 1 }, 404);
  const { created, asset } = await upload(a);
  await api(b.owner_token, 'POST', `/assets/${asset.id}/complete`, {}, 404);
  await api(a.collaborator_token, 'POST', `/assets/${asset.id}/complete`, {}, 404);
  await api(a.collaborator_token, 'GET', `/assets/${asset.id}/download`, undefined, 404);
  const input = { client_message_id: randomUUID(), text: '', asset_ids: [asset.id] };
  const message = (await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, input, 201)).json();
  assert.deepEqual(message.attachments, [asset]);
  assert.deepEqual((await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, input, 201)).json(), message);
  await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { ...input, asset_ids: [] }, 400);
  await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { ...input, text: 'changed' }, 409);
  await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { ...input, client_message_id: randomUUID() }, 409);
  const history = (await api(a.collaborator_token, 'GET', `/channels/${a.channel_id}/history`)).json();
  assert.deepEqual(history.events[0].payload.attachments, [asset]);
  assert.deepEqual((await api(a.owner_token, 'GET', `/threads/${message.thread_id}/messages`)).json()[0].attachments, [asset]);
  const download = await api(a.collaborator_token, 'GET', `/assets/${asset.id}/download`, undefined, 302);
  assert.ok(download.headers.location?.includes(`/files/${asset.id}`));
  assert.ok(!download.headers.location?.includes(created.upload.fields.key));
  await api(b.owner_token, 'GET', `/assets/${asset.id}/download`, undefined, 404);
  await new WorkspaceStore(pool).removeMember(a.owner_id, a.workspace_id, a.collaborator_id);
  await api(a.collaborator_token, 'GET', `/assets/${asset.id}/download`, undefined, 404);
  await migrate(pool);
  assert.deepEqual((await api(a.owner_token, 'GET', `/channels/${a.channel_id}/history`)).json().events[0].payload.attachments, [asset]);
});

test('unfinished, invalid, expired, foreign and cross-channel uploads cannot be attached', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const created = (await api(a.owner_token, 'POST', `/channels/${a.channel_id}/assets`, { name: 'pending.bin', size: 5 }, 201)).json();
  await api(a.owner_token, 'POST', `/assets/${created.asset.id}/complete`, {}, 409);
  objects.set(created.upload.fields.key, 6);
  await api(a.owner_token, 'POST', `/assets/${created.asset.id}/complete`, {}, 409);
  await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), text: 'Pending', asset_ids: [created.asset.id] }, 409);
  const { asset } = await upload(a);
  await api(a.collaborator_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), text: 'Other owner', asset_ids: [asset.id] }, 409);
  await api(b.owner_token, 'POST', `/channels/${b.channel_id}/messages`, { client_message_id: randomUUID(), text: 'Other channel', asset_ids: [asset.id] }, 409);
  await pool.query('UPDATE assets SET expires_at=now()-interval \'1 second\' WHERE id=$1', [asset.id]);
  await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), text: 'Expired', asset_ids: [asset.id] }, 409);
  // The durable expiry event may already have removed this unattached asset.
  const expired = await app.inject({ method: 'POST', url: `/v1/assets/${asset.id}/complete`, headers: { authorization: `Bearer ${a.owner_token}` }, payload: {} });
  assert.ok(expired.statusCode === 410 || expired.statusCode === 404, expired.body);
  assert.equal(expired.json().error, expired.statusCode === 410 ? 'upload_expired' : 'not_found');
  if (expired.statusCode === 404) assert.equal((await pool.query('SELECT id FROM assets WHERE id=$1', [asset.id])).rowCount, 0);
});

test('attachments flow through socket acknowledgments and reconnect events', async () => {
  const a = await bootstrap(pool), { asset } = await upload(a);
  const socket = io(address, { transports: ['websocket'], auth: { token: a.owner_token }, reconnection: false });
  try {
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    const reply = await socket.timeout(2000).emitWithAck('message.send', { channel_id: a.channel_id, client_message_id: randomUUID(), text: 'File', asset_ids: [asset.id] });
    assert.equal(reply.error, undefined);
    assert.deepEqual(reply.data.attachments, [asset]);
    const event = new Promise<any>(resolve => socket.once('chat.events', (frame, ack) => { ack(); resolve(frame); }));
    await socket.timeout(2000).emitWithAck('channel.subscribe', { channel_id: a.channel_id, after: '0' });
    assert.deepEqual((await event).events[0].payload.attachments, [asset]);
  } finally { socket.disconnect(); }
});

test('cleanup removes abandoned objects and staging data while preserving attached final files', async () => {
  const { AssetStore } = await import('@space/postgres/assets');
  const a = await bootstrap(pool), one = await upload(a), two = await upload(a);
  await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), text: 'Keep', asset_ids: [one.asset.id] }, 201);
  await pool.query('UPDATE assets SET upload_expires_at=now()-interval \'10 minutes\' WHERE id=$1', [one.asset.id]);
  await pool.query('UPDATE assets SET expires_at=now()-interval \'1 second\' WHERE id=$1', [two.asset.id]);
  const assets = new AssetStore(pool);
  await Promise.all([assets.cleanup(key => storage.remove(key)), assets.cleanup(key => storage.remove(key))]);
  assert.ok(removed.includes(one.created.upload.fields.key));
  assert.ok(!removed.includes(`files/${one.asset.id}`));
  assert.ok(removed.includes(two.created.upload.fields.key));
  assert.ok(removed.includes(`files/${two.asset.id}`));
  assert.equal((await pool.query('SELECT id FROM assets WHERE id=$1', [two.asset.id])).rowCount, 0);
  await api(a.owner_token, 'GET', `/assets/${one.asset.id}/download`, undefined, 302);
  await api(a.owner_token, 'GET', `/assets/${two.asset.id}/download`, undefined, 404);
});

test('cleanup retries provider failures without losing database records', async () => {
  const { AssetStore } = await import('@space/postgres/assets');
  const a = await bootstrap(pool), { asset } = await upload(a);
  await pool.query('UPDATE assets SET expires_at=now()-interval \'1 second\' WHERE id=$1', [asset.id]);
  const assets = new AssetStore(pool);
  await assert.rejects(assets.cleanup(async () => { throw new Error('offline'); }), /offline/);
  assert.equal((await pool.query('SELECT id FROM assets WHERE id=$1', [asset.id])).rowCount, 1);
  await assets.cleanup(key => storage.remove(key));
  assert.equal((await pool.query('SELECT id FROM assets WHERE id=$1', [asset.id])).rowCount, 0);
});

test('configuration disables uploads when storage is absent and upload creation is bounded', async () => {
  const a = await bootstrap(pool);
  const disabled = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true });
  try {
    const headers = { authorization: `Bearer ${a.owner_token}` };
    assert.equal((await disabled.inject({ method: 'GET', url: '/v1/assets/config', headers })).json().enabled, false);
    assert.equal((await disabled.inject({ method: 'POST', url: `/v1/channels/${a.channel_id}/assets`, headers, payload: { name: 'x', size: 1 } })).statusCode, 503);
  } finally { await disabled.close(); }
  for (let i = 0; i < 20; i++) await api(a.owner_token, 'POST', `/channels/${a.channel_id}/assets`, { name: `pending-${i}`, size: 1 }, 201);
  await api(a.owner_token, 'POST', `/channels/${a.channel_id}/assets`, { name: 'overflow', size: 1 }, 429);
});

test('validated image previews render through authorized content and thumbnail routes', async () => {
  const a = await bootstrap(pool), outsider = await bootstrap(pool);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWOQnX0RjhiQOQCaIgxJaTtmNQAAAABJRU5ErkJggg==', 'base64');
  const created = (await api(a.owner_token, 'POST', `/channels/${a.channel_id}/assets`, { name: 'photo.png', size: png.length, type: 'text/html' }, 201)).json();
  objects.set(created.upload.fields.key, png.length);
  contents.set(created.upload.fields.key, png);
  await api(a.owner_token, 'POST', `/assets/${created.asset.id}/complete`, {});
  const preview = (await api(a.owner_token, 'GET', `/assets/${created.asset.id}/preview`)).json();
  assert.deepEqual(preview, { kind: 'image', mime: 'image/webp', width: 4, height: 2 });
  const thumb = await api(a.owner_token, 'GET', `/assets/${created.asset.id}/thumbnail`, undefined, 302);
  assert.ok(thumb.headers.location?.includes(`previews/${created.asset.id}/display.webp`));
  const display = await api(a.owner_token, 'GET', `/assets/${created.asset.id}/content`, undefined, 302);
  assert.ok(display.headers.location?.includes(`previews/${created.asset.id}/display.webp`));
  await api(a.collaborator_token, 'GET', `/assets/${created.asset.id}/preview`, undefined, 404);
  await api(outsider.owner_token, 'GET', `/assets/${created.asset.id}/content`, undefined, 404);
  await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), text: 'Image', asset_ids: [created.asset.id] }, 201);
  await api(a.collaborator_token, 'GET', `/assets/${created.asset.id}/preview`);
  const original = await api(a.collaborator_token, 'GET', `/assets/${created.asset.id}/original-image`, undefined, 302);
  assert.match(original.headers.location!, /^http:\/\/storage.test\/download\//);
  await new WorkspaceStore(pool).removeMember(a.owner_id, a.workspace_id, a.collaborator_id);
  for (const path of ['preview', 'thumbnail', 'content', 'original-image', 'details']) await api(a.collaborator_token, 'GET', `/assets/${created.asset.id}/${path}`, undefined, 404);
});

test('file detail edits authorize the uploader and replay one consistent message after racing renames', async () => {
  const a = await bootstrap(pool);
  const { asset } = await upload(a);
  const path = '/assets/' + asset.id;
  const sent = (await api(a.owner_token, 'POST', '/channels/' + a.channel_id + '/messages', {
    client_message_id: randomUUID(), text: '', asset_ids: [asset.id], asset_descriptions: { [asset.id]: 'draft description' },
  }, 201)).json();
  const edit = { name: 'renamed.txt', description: 'updated description', previous_name: asset.name, previous_description: 'draft description' };
  await api(a.collaborator_token, 'PUT', path + '/details', edit, 403);
  await api(a.owner_token, 'GET', path + '/original-image', undefined, 415);
  const attempt = (name: string) => app.inject({ method:'PUT', url:'/v1'+path+'/details',
    headers: { authorization: 'Bearer '+a.owner_token }, payload: { ...edit, name } });
  const results = await Promise.all([attempt('first.txt'), attempt('second.txt')]);
  assert.deepEqual(results.map(result=>result.statusCode).sort(), [200,409]);
  const winner = results.find(result=>result.statusCode === 200)!.json().name;
  await api(a.owner_token, 'PUT', path + '/details', { ...edit, name: winner });
  assert.equal((await api(a.collaborator_token, 'GET', path+'/details')).json().name, winner);
  const events = await pool.query("SELECT payload FROM channel_events WHERE channel_id=$1 AND type='message.updated' AND payload->>'id'=$2", [a.channel_id,sent.id]);
  assert.equal(events.rows.length,1);
  assert.deepEqual(events.rows[0].payload.attachments, [{ ...asset, name:winner, description:edit.description }]);
});

test('legacy text previews backfill once, remain escaped data, and refuse raw inline execution', async () => {
  const a = await bootstrap(pool);
  const data = Buffer.from('<script>alert("not executable")</script>');
  const created = (await api(a.owner_token, 'POST', `/channels/${a.channel_id}/assets`, { name: 'source.html', size: data.length, type: 'image/png' }, 201)).json();
  objects.set(created.upload.fields.key, data.length); contents.set(created.upload.fields.key, data);
  await api(a.owner_token, 'POST', `/assets/${created.asset.id}/complete`, {});
  await pool.query('UPDATE assets SET preview=NULL WHERE id=$1', [created.asset.id]);
  const readsBefore = reads;
  const previews = await Promise.all([api(a.owner_token, 'GET', `/assets/${created.asset.id}/preview`), api(a.owner_token, 'GET', `/assets/${created.asset.id}/preview`)]);
  assert.equal(reads, readsBefore + 1);
  assert.equal(previews[0]!.json().kind, 'text');
  assert.equal(previews[0]!.json().text, data.toString());
  await api(a.owner_token, 'GET', `/assets/${created.asset.id}/content`, undefined, 415);
  await api(a.owner_token, 'GET', `/assets/${created.asset.id}/thumbnail`, undefined, 415);
  await api(a.owner_token, 'GET', `/assets/${created.asset.id}/download`, undefined, 302);
});

test('unattached asset cleanup also deletes generated preview derivatives', async () => {
  const { AssetStore } = await import('@space/postgres/assets');
  const a = await bootstrap(pool), { asset } = await upload(a);
  await pool.query('UPDATE assets SET expires_at=now()-interval \'1 second\' WHERE id=$1', [asset.id]);
  await new AssetStore(pool).cleanup(key => storage.remove(key));
  assert.ok(removed.includes(`previews/${asset.id}/thumbnail.webp`));
  assert.ok(removed.includes(`previews/${asset.id}/display.webp`));
});


test('PDF ranges are authenticated, bounded and private, and HEAD never reads storage', async () => {
  const a = await bootstrap(pool), outsider = await bootstrap(pool);
  const bytes = await readFile(new URL('../fixtures/preview/two-pages.pdf', import.meta.url));
  const created = (await api(a.owner_token, 'POST', `/channels/${a.channel_id}/assets`, { name: 'two-pages.pdf', size: bytes.length }, 201)).json();
  objects.set(created.upload.fields.key, bytes.length); contents.set(created.upload.fields.key, bytes);
  await api(a.owner_token, 'POST', `/assets/${created.asset.id}/complete`, {});
  const url = `/v1/assets/${created.asset.id}/content`;
  const request = (method: 'GET' | 'HEAD', token?: string, range?: string) => app.inject({ method, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(range !== undefined ? { range } : {}) } });
  const beforeHead = reads;
  const head = await request('HEAD', a.owner_token);
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], String(bytes.length));
  assert.equal(head.headers['accept-ranges'], 'bytes');
  assert.equal(head.headers['content-type'], 'application/pdf');
  assert.equal(head.headers['cache-control'], 'no-store');
  assert.equal(reads, beforeHead, 'HEAD must not read the object');
  for (const [range, start, end] of [['bytes=0-4', 0, 4], ['bytes=5-', 5, bytes.length - 1], ['bytes=-5', bytes.length - 5, bytes.length - 1], [`bytes=3-${bytes.length + 99}`, 3, bytes.length - 1], [`bytes=-${bytes.length + 99}`, 0, bytes.length - 1]] as const) {
    const response = await request('GET', a.owner_token, range);
    assert.equal(response.statusCode, 206, response.body);
    assert.equal(response.headers['content-range'], `bytes ${start}-${end}/${bytes.length}`);
    assert.equal(response.headers['content-length'], String(end - start + 1));
    assert.equal(response.headers['accept-ranges'], 'bytes');
    assert.equal(response.headers['content-type'], 'application/pdf');
    assert.equal(response.headers['content-disposition'], 'attachment');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.rawPayload, bytes.subarray(start, end + 1));
    assert.deepEqual(readRanges.at(-1), { start, end });
  }
  const full = await request('GET', a.owner_token);
  assert.equal(full.statusCode, 200); assert.deepEqual(full.rawPayload, bytes); assert.equal(readRanges.at(-1), undefined);
  const beforeInvalid = reads;
  for (const range of ['', 'items=0-1', 'bytes=1-0', 'bytes=-0', 'bytes=-', 'bytes=1-2,4-5', 'bytes=0-1,', 'bytes= 0-1', 'bytes=1.5-2', `bytes=${bytes.length}-`, 'bytes=9007199254740992-', 'bytes=-9007199254740992']) {
    const response = await request('GET', a.owner_token, range);
    assert.equal(response.statusCode, 416, range);
    assert.equal(response.headers['content-range'], `bytes */${bytes.length}`);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal(reads, beforeInvalid, 'invalid ranges never read storage');
  for (const range of ['bytes=0-4', 'bytes=bad']) {
    assert.equal((await request('GET', undefined, range)).statusCode, 401);
    assert.equal((await request('GET', outsider.owner_token, range)).statusCode, 404);
    assert.equal((await request('GET', a.collaborator_token, range)).statusCode, 404);
  }
  await api(a.owner_token, 'POST', `/channels/${a.channel_id}/messages`, { client_message_id: randomUUID(), text: 'PDF', asset_ids: [created.asset.id] }, 201);
  assert.equal((await request('GET', a.collaborator_token, 'bytes=0-4')).statusCode, 206);
  await new WorkspaceStore(pool).removeMember(a.owner_id, a.workspace_id, a.collaborator_id);
  assert.equal((await request('GET', a.collaborator_token, 'bytes=0-4')).statusCode, 404);
  assert.equal((await request('GET', a.collaborator_token, 'bytes=bad')).statusCode, 404);
  assert.equal((await request('HEAD', a.collaborator_token)).statusCode, 404);
  await pool.query('UPDATE assets SET preview=NULL WHERE id=$1', [created.asset.id]);
  const legacyReads = reads;
  assert.equal((await request('HEAD', a.owner_token)).statusCode, 415);
  assert.equal(reads, legacyReads, 'legacy HEAD must not backfill from object bytes');
  assert.equal((await request('GET', a.owner_token, 'bytes=0-4')).statusCode, 206);
});

async function shareFile(seed: Awaited<ReturnType<typeof bootstrap>>, name: string, preview: object | null, thread_id?: string) {
  const { asset } = await upload(seed);
  const message = (await api(seed.owner_token, 'POST', `/channels/${seed.channel_id}/messages`, { client_message_id: randomUUID(), text: 'Shared file', asset_ids: [asset.id], ...(thread_id ? { thread_id } : {}) }, 201)).json();
  await pool.query('UPDATE assets SET name=$2,preview=$3 WHERE id=$1', [asset.id, name, preview]);
  return { asset, message };
}

test('channel files list safe metadata including old thread replies without reading or backfilling storage', async () => {
  const a = await bootstrap(pool);
  const tabs = async () => (await api(a.collaborator_token,'GET',`/channels/${a.channel_id}/tabs`)).json();
  await upload(a);
  assert.equal((await tabs()).has_files,false,'an unshared upload cannot create a channel tab');
  const root = await shareFile(a, 'Readme.TXT', { kind: 'text', text: 'PRIVATE CONTENT', language: 'text', truncated: false });
  assert.equal((await tabs()).has_files,true);
  const reply = await shareFile(a, 'Legacy.bin', null, root.message.thread_id);
  await pool.query("UPDATE messages SET created_at='2001-01-01T00:00:00.123456Z' WHERE id=$1", [reply.message.id]);
  await upload(a); // Ready, but never shared.
  await api(a.owner_token, 'POST', `/channels/${a.channel_id}/assets`, { name: 'Pending.bin', size: 1 }, 201);
  const beforeReads = reads;
  const listed = (await api(a.collaborator_token, 'GET', `/channels/${a.channel_id}/assets`)).json();
  assert.deepEqual(listed.items.map((f: any) => f.id), [root.asset.id, reply.asset.id]);
  assert.deepEqual(listed.items[0], { ...root.asset, name: 'Readme.TXT', preview_kind: 'text', message_id: root.message.id, thread_id: root.message.thread_id, shared_at: root.message.created_at, uploader: { id: a.owner_id, name: 'Demo owner' } });
  assert.equal(listed.items[1].preview_kind, 'file');
  assert.equal(listed.items[1].thread_id, root.message.thread_id);
  assert.equal(listed.next_cursor, null);
  assert.equal(JSON.stringify(listed).includes('PRIVATE CONTENT'), false);
  assert.equal(JSON.stringify(listed).includes('object_key'), false);
  assert.equal(JSON.stringify(listed).includes('staging'), false);
  assert.equal(reads, beforeReads);
  assert.equal((await pool.query('SELECT preview FROM assets WHERE id=$1', [reply.asset.id])).rows[0].preview, null);
  const disabled = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true });
  try {
    const response = await disabled.inject({ method: 'GET', url: `/v1/channels/${a.channel_id}/assets`, headers: { authorization: `Bearer ${a.owner_token}` } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().items.length, 2);
  } finally { await disabled.close(); }
});

test('channel files filter verified kinds and case-insensitive literal filename characters', async () => {
  const a = await bootstrap(pool);
  const previews = [
    { kind: 'image', mime: 'image/webp', width: 1, height: 1 }, { kind: 'pdf', mime: 'application/pdf' },
    { kind: 'text', text: 'hidden', language: 'text', truncated: false }, { kind: 'audio', mime: 'audio/mpeg' },
    { kind: 'video', mime: 'video/mp4' }, { kind: 'unsupported', reason: 'unknown' }, null,
  ];
  const files: Awaited<ReturnType<typeof shareFile>>[] = [];
  for (const [i, preview] of previews.entries()) files.push(await shareFile(a, i === 0 ? 'Literal%_\\.PNG' : `ordinary-${i}.png`, preview));
  for (const [i, kind] of ['image', 'pdf', 'text', 'audio', 'video'].entries()) {
    const page = (await api(a.owner_token, 'GET', `/channels/${a.channel_id}/assets?kind=${kind}`)).json();
    assert.deepEqual(page.items.map((f: any) => f.id), [files[i]!.asset.id]);
  }
  const other = (await api(a.owner_token, 'GET', `/channels/${a.channel_id}/assets?kind=other`)).json();
  assert.deepEqual(new Set(other.items.map((f: any) => f.id)), new Set([files[5]!.asset.id, files[6]!.asset.id]));
  for (const q of ['literal%_\\', '%', '_', '\\', 'LITERAL']) {
    const page = (await api(a.owner_token, 'GET', `/channels/${a.channel_id}/assets?q=${encodeURIComponent(q)}`)).json();
    assert.deepEqual(page.items.map((f: any) => f.id), [files[0]!.asset.id], q);
  }
  assert.equal((await api(a.owner_token, 'GET', `/channels/${a.channel_id}/assets?q=missing`)).json().items.length, 0);
});

test('channel file pages preserve microseconds, UUID ties and insertion stability in both directions', async () => {
  for (const sort of ['newest', 'oldest']) {
    const a = await bootstrap(pool);
    const files: Awaited<ReturnType<typeof shareFile>>[] = [];
    for (let i = 0; i < 5; i++) files.push(await shareFile(a, `file-${i}`, null));
    for (const [i, f] of files.entries()) await pool.query('UPDATE messages SET created_at=$2 WHERE id=$1', [f.message.id, i < 3 ? '2020-01-01T00:00:00.123456Z' : '2020-01-01T00:00:00.123789Z']);
    const expected = [...files].sort((a, b) => {
      const stamp = (files.indexOf(a) < 3 ? 0 : 1) - (files.indexOf(b) < 3 ? 0 : 1);
      return (stamp || a.asset.id.localeCompare(b.asset.id)) * (sort === 'oldest' ? 1 : -1);
    }).map(f => f.asset.id);
    const path = `/channels/${a.channel_id}/assets?sort=${sort}&limit=2`;
    let page = (await api(a.owner_token, 'GET', path)).json();
    assert.deepEqual(page.items.map((f: any) => f.id), expected.slice(0, 2));
    const inserted = await shareFile(a, 'new-file', null);
    await pool.query('UPDATE messages SET created_at=$2 WHERE id=$1', [inserted.message.id, sort === 'newest' ? '2030-01-01T00:00:00Z' : '2010-01-01T00:00:00Z']);
    const found = page.items.map((f: any) => f.id);
    while (page.next_cursor) {
      page = (await api(a.owner_token, 'GET', `${path}&after=${page.next_cursor}`)).json();
      found.push(...page.items.map((f: any) => f.id));
    }
    assert.deepEqual(found, expected);
  }
});

test('channel files authorize current private membership and reject foreign, pending or missing cursors', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const f = await shareFile(a, 'a', null), foreign = await shareFile(b, 'foreign', null), unattached = await upload(a);
  const pending = (await api(a.owner_token, 'POST', `/channels/${a.channel_id}/assets`, { name: 'pending', size: 1 }, 201)).json();
  for (const cursor of [foreign.asset.id, unattached.asset.id, pending.asset.id, randomUUID()]) await api(a.owner_token, 'GET', `/channels/${a.channel_id}/assets?after=${cursor}`, undefined, 400);
  await api(b.owner_token, 'GET', `/channels/${a.channel_id}/assets`, undefined, 404);
  const privateChannel = (await api(a.owner_token, 'POST', `/workspaces/${a.workspace_id}/channels`, { name: 'Private files', private: true }, 201)).json();
  await api(a.collaborator_token, 'GET', `/channels/${privateChannel.id}/assets`, undefined, 404);
  await api(a.owner_token, 'POST', `/channels/${privateChannel.id}/members`, { user_id: a.collaborator_id }, 201);
  await api(a.collaborator_token, 'GET', `/channels/${privateChannel.id}/assets`);
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2', [privateChannel.id, a.collaborator_id]);
  await api(a.collaborator_token, 'GET', `/channels/${privateChannel.id}/assets`, undefined, 404);
  await new WorkspaceStore(pool).removeMember(a.owner_id, a.workspace_id, a.collaborator_id);
  await api(a.collaborator_token, 'GET', `/channels/${a.channel_id}/assets?after=${f.asset.id}`, undefined, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/v1/channels/${a.channel_id}/assets` })).statusCode, 401);
  for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=01', 'limit=1&limit=2', 'after=bad', 'kind=unsupported', 'sort=random', 'q=' + 'x'.repeat(256), 'object_key=secret']) await api(a.owner_token, 'GET', `/channels/${a.channel_id}/assets?${query}`, undefined, 400);
});

test('channel file listing has a partial ready attached lookup index', async () => {
  const index = (await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='assets_channel_message_ready'")).rows[0]?.indexdef;
  assert.ok(index, 'channel file lookup index must be migrated');
  assert.match(index, /\(channel_id, message_id, id\)/);
  assert.match(index, /status = 'ready'/);
  assert.match(index, /message_id IS NOT NULL/);
});


test('channel files honor the default page size and maximum one hundred rows', async () => {
  const a = await bootstrap(pool);
  for (let i = 0; i < 101; i++) await shareFile(a, `bounded-${i}`, null);
  const path = `/channels/${a.channel_id}/assets`;
  const defaults = (await api(a.owner_token, 'GET', path)).json();
  assert.equal(defaults.items.length, 30);
  assert.equal(defaults.next_cursor, defaults.items.at(-1).id);
  const maximum = (await api(a.owner_token, 'GET', `${path}?limit=100`)).json();
  assert.equal(maximum.items.length, 100);
  const last = (await api(a.owner_token, 'GET', `${path}?limit=100&after=${maximum.next_cursor}`)).json();
  assert.equal(last.items.length, 1);
  assert.equal(last.next_cursor, null);
  assert.equal(new Set([...maximum.items, ...last.items].map((f: any) => f.id)).size, 101);
});

test('channel file listing is read-only and proceeds while channel and workspace writers hold row locks', async () => {
  const { AssetStore } = await import('@space/postgres/assets');
  const a = await bootstrap(pool), { asset } = await shareFile(a, 'read-only.txt', null);
  const reader = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema} -c default_transaction_read_only=on -c statement_timeout=1000` });
  const writer = await pool.connect();
  try {
    await writer.query('BEGIN');
    await writer.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [a.workspace_id]);
    await writer.query('SELECT id FROM channels WHERE id=$1 FOR UPDATE', [a.channel_id]);
    const page = await new AssetStore(reader).list(a.owner_id, a.channel_id);
    assert.deepEqual(page.items.map(f => f.id), [asset.id]);
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
    await reader.end();
  }
});

test('issues signed view-only sessions for verified Office files visible to the caller', async () => {
  const a = await bootstrap(pool);
  // The ODF mimetype entry is enough for file-type to identify the sealed ZIP.
  const data = Buffer.from('UEsDBBQAAAAAAFlra11exjIMJwAAACcAAAAIAAAAbWltZXR5cGVhcHBsaWNhdGlvbi92bmQub2FzaXMub3BlbmRvY3VtZW50LnRleHRQSwECFAMUAAAAAABZa2tdXsYyDCcAAAAnAAAACAAAAAAAAAAAAAAAgAEAAAAAbWltZXR5cGVQSwUGAAAAAAEAAQA2AAAATQAAAAAA', 'base64');
  const created = (await api(a.owner_token, 'POST', `/channels/${a.channel_id}/assets`, { name: 'runbook.odt', size: data.length }, 201)).json();
  objects.set(created.upload.fields.key, data.length);
  contents.set(created.upload.fields.key, data);
  const path = `/assets/${created.asset.id}`;
  await api(a.owner_token, 'POST', path + '/complete', {});
  assert.deepEqual((await api(a.owner_token, 'GET', path + '/preview')).json(), { kind: 'office', fileType: 'odt' });
  const response = await api(a.owner_token, 'GET', path + '/office-session');
  assert.equal(response.headers['cache-control'], 'private, no-store');
  const { config, documentServerUrl } = response.json();
  assert.equal(documentServerUrl, office.url);
  const [header, body, signature] = config.token.split('.');
  assert.equal(signature, createHmac('sha256', office.secret).update(header + '.' + body).digest('base64url'));
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  assert.deepEqual(claims.document, config.document);
  assert.equal(claims.document.key, created.asset.id);
  assert.equal(claims.document.permissions.edit, false);
  // Viewer chat and plugins run outside Space access checks, so both stay off.
  assert.equal(claims.document.permissions.chat, false);
  assert.equal(claims.editorConfig.customization.plugins, false);
  assert.equal(claims.editorConfig.mode, 'view');
  assert.equal(claims.exp - claims.iat, 300);
  await api(a.collaborator_token, 'GET', path + '/office-session', undefined, 404);
  await api(a.owner_token, 'GET', path + '/content', undefined, 415);
  const { asset } = await upload(a);
  await api(a.owner_token, 'GET', `/assets/${asset.id}/office-session`, undefined, 415);
});

test('concurrent Office card reads share a conversion and can retry after a converter failure', async t => {
  const a = await bootstrap(pool);
  const doc = await readFile(new URL('../fixtures/office/Runbook.docx', import.meta.url));
  const created = (await api(a.owner_token, 'POST', `/channels/${a.channel_id}/assets`, { name: 'runbook.docx', size: doc.length }, 201)).json();
  objects.set(created.upload.fields.key, doc.length);
  contents.set(created.upload.fields.key, doc);
  const path = '/assets/' + created.asset.id;
  await api(a.owner_token, 'POST', path + '/complete', {});
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ5sAAAAASUVORK5CYII=', 'base64');
  let calls = 0, reads = 0;
  let allowConversion!: () => void;
  const bothAllowed = new Promise<void>(resolve => { allowConversion = resolve; });
  const access = AssetStore.prototype.officeAccessFor;
  t.mock.method(AssetStore.prototype, 'officeAccessFor', async function(this: AssetStore, ...args: Parameters<typeof access>) {
    const row = await access.apply(this, args);
    if (++reads === 2) allowConversion();
    return row;
  });
  const converter = createServer(async (request, reply) => {
    if (request.url !== '/converter') return reply.end(png);
    calls++;
    await bothAllowed;
    if (calls === 1) return reply.writeHead(503).end();
    reply.end(JSON.stringify({ endConvert: true, fileUrl: office.url + '/cache/files/page.png' }));
  });
  await new Promise<void>(resolve => converter.listen(0, '127.0.0.1', resolve));
  const previous = office.url;
  office.url = 'http://127.0.0.1:' + (converter.address() as AddressInfo).port;
  t.after(() => { office.url = previous; converter.close(); });
  await Promise.all([1, 2].map(() => api(a.owner_token, 'GET', path + '/thumbnail', undefined, 503)));
  assert.equal(calls, 1);
  const thumbnail = await api(a.owner_token, 'GET', path + '/thumbnail');
  assert.deepEqual(thumbnail.rawPayload, png);
  assert.equal(thumbnail.headers['cache-control'], 'private, no-store');
  assert.equal(calls, 2);
});

test('shared editing checks permissions and finalizes concurrent or repeated callbacks once', async t => {
  const a = await bootstrap(pool);
  const doc = await readFile(new URL('../fixtures/office/Runbook.docx', import.meta.url));
  const documentServer = createServer((_request, reply) => reply.end(doc));
  await new Promise<void>(resolve => documentServer.listen(0, '127.0.0.1', resolve));
  const previous = office.url;
  office.url = `http://127.0.0.1:${(documentServer.address() as AddressInfo).port}`;
  t.after(() => { office.url = previous; documentServer.close(); });
  const created = (await api(a.owner_token, 'POST', `/channels/${a.channel_id}/assets`, { name: 'sample.docx', size: doc.length }, 201)).json();
  objects.set(created.upload.fields.key, doc.length);
  contents.set(created.upload.fields.key, doc);
  const id = created.asset.id, file = '/assets/' + id;
  await api(a.owner_token, 'POST', file + '/complete', {});
  await api(a.owner_token, 'POST', '/channels/' + a.channel_id + '/messages', { client_message_id: randomUUID(), text: '', asset_ids: [id] }, 201);
  const open = file + '/office-session?mode=edit';
  await api(a.collaborator_token, 'GET', open, undefined, 403);
  await api(a.collaborator_token, 'PUT', file + '/office-sharing', { enabled: true }, 403);
  await api(a.owner_token, 'PUT', file + '/office-sharing', { enabled: true }, 204);
  const first = (await api(a.owner_token, 'GET', open)).json().config;
  const peer = (await api(a.collaborator_token, 'GET', open)).json().config;
  assert.equal(first.document.key, peer.document.key);
  assert.notEqual(first.editorConfig.user.id, peer.editorConfig.user.id);
  assert.equal(peer.editorConfig.coEditing.mode, 'fast');
  const result = { status: 2, key: peer.document.key, users: [a.collaborator_id], url: office.url + '/cache/files/result.docx' };
  function token(payload: object, operation = 'callback') {
    const encode = (x: object) => Buffer.from(JSON.stringify(x)).toString('base64url');
    const data = encode({alg:'HS256'}) + '.' + encode({operation, payload, exp: Math.floor(Date.now()/1000)+60});
    return data + '.' + createHmac('sha256', office.secret).update(data).digest('base64url');
  }
  const callback = (jwt: string) => app.inject({method:'POST',url:'/v1/office/callback',headers:{authorization:'Bearer '+jwt},payload:result});
  assert.equal((await callback(first.token)).statusCode,401);
  assert.equal((await callback(token(result,'download'))).statusCode,401);
  assert.equal((await callback(token({...result,url:'http://untrusted.invalid/file'}))).statusCode,400);
  await api(a.owner_token, 'PUT', file + '/office-sharing', { enabled: false }, 204);
  assert.equal((await callback(token(result))).statusCode,403);
  await api(a.owner_token, 'PUT', file + '/office-sharing', { enabled: true }, 204);
  assert.equal((await callback(token(result))).statusCode,403);
  result.key = (await api(a.collaborator_token,'GET',open)).json().config.document.key;
  for (const r of await Promise.all([callback(token(result)),callback(token(result))])) assert.deepEqual(r.json(),{error:0});
  assert.equal((await api(a.owner_token,'GET',file+'/office-session')).json().revision,1);
  const next = (await api(a.owner_token,'GET',open)).json().config;
  assert.notEqual(next.document.key,first.document.key);
  assert.deepEqual((await callback(token(result))).json(),{error:0});
  assert.equal((await api(a.owner_token,'GET',file+'/office-session')).json().revision,1);
  assert.deepEqual((await api(a.owner_token,'GET',file+'/download')).rawPayload,doc);
});
