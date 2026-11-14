import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

const storage = await import('./dist/storage.js');
const config = { endpoint: 'http://127.0.0.1:8333', publicEndpoint: 'https://files.example.test', bucket: 'space-assets', accessKey: 'test-access', secretKey: 'test-secret', origins: ['http://127.0.0.1:5173'] };
const env = Object.fromEntries(Object.entries({ ENDPOINT: config.endpoint, PUBLIC_ENDPOINT: config.publicEndpoint, BUCKET: config.bucket, ACCESS_KEY: config.accessKey, SECRET_KEY: config.secretKey, ORIGINS: config.origins.join(',') }).map(([key, value]) => [`ASSET_STORAGE_${key}`, value]));

test('storage factory disables only when all configuration is absent and rejects incomplete configuration', () => {
  assert.equal(typeof storage.createAssetStorageFromEnv, 'function');
  assert.equal(storage.createAssetStorageFromEnv({}), undefined);
  assert.throws(() => storage.createAssetStorageFromEnv({ ASSET_STORAGE_BUCKET: 'space-assets' }), /asset_storage_configuration/);
  assert.ok(storage.createAssetStorageFromEnv(env) instanceof storage.SeaweedStorage);
  assert.throws(() => storage.createAssetStorageFromEnv({ ...env, ASSET_STORAGE_PUBLIC_ENDPOINT: 'file:///tmp' }), /asset_storage_configuration/);
  assert.throws(() => storage.createAssetStorageFromEnv({ ...env, ASSET_STORAGE_ORIGINS: '*' }), /asset_storage_configuration/);
});

test('signed upload policy restricts exact key, exact byte count, safe content type and five minute lifetime', async () => {
  const adapter = new storage.SeaweedStorage(config);
  const upload = await adapter.createUpload('staging/random-id', 3);
  assert.equal(upload.url, 'https://files.example.test/space-assets');
  const policy = JSON.parse(Buffer.from(upload.fields.Policy, 'base64').toString());
  assert.ok(policy.conditions.some(condition => JSON.stringify(condition) === JSON.stringify(['content-length-range', 3, 3])));
  assert.ok(policy.conditions.some(condition => condition.key === 'staging/random-id'));
  assert.ok(policy.conditions.some(condition => condition['Content-Type'] === 'application/octet-stream'));
  assert.ok(Date.parse(policy.expiration) - Date.now() <= 300_000);
  assert.ok(Date.parse(policy.expiration) - Date.now() > 290_000);
  for (const size of [0, -1, 1.5, 25 * 1024 * 1024 + 1]) await assert.rejects(adapter.createUpload('staging/random-id', size), { status: 409, code: 'invalid_upload' });
  const download = new URL(await adapter.download('final/random-id', 'résumé"\r\n.txt'));
  assert.equal(download.origin, config.publicEndpoint);
  assert.equal(download.searchParams.get('X-Amz-Expires'), '60');
  assert.equal(download.searchParams.get('response-content-type'), 'application/octet-stream');
  assert.match(download.searchParams.get('response-content-disposition'), /^attachment;/);
  assert.doesNotMatch(download.searchParams.get('response-content-disposition'), /[\r\n]/);
});

test('upload policy never outlives the absolute reservation deadline', async () => {
  const adapter = new storage.SeaweedStorage(config);
  const deadline = new Date(Date.now() + 294_000);
  const upload = await adapter.createUpload('staging/reserved-earlier', 3, deadline);
  const expiration = Date.parse(JSON.parse(Buffer.from(upload.fields.Policy, 'base64').toString()).expiration);
  assert.ok(expiration <= deadline.getTime(), 'signing must use the existing reservation deadline');
  assert.ok(expiration > deadline.getTime() - 3000, 'usable time remains close to the reservation deadline');
  for (const expiresAt of [new Date(Date.now() - 1), new Date(Date.now() + 1000), new Date('invalid')]) {
    await assert.rejects(adapter.createUpload('staging/expired', 3, expiresAt), { status: 410, code: 'upload_expired' });
  }
  const capped = await adapter.createUpload('staging/capped', 3, new Date(Date.now() + 600_000));
  const cappedExpiration = Date.parse(JSON.parse(Buffer.from(capped.fields.Policy, 'base64').toString()).expiration);
  assert.ok(cappedExpiration <= Date.now() + 300_000, 'policy lifetime cannot exceed five minutes');
});

test('finalization checks source size and etag, conditionally seals bytes, and confirms destination', async t => {
  const requests = [];
  let sourceSize = 3;
  let sealed = false;
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    if (req.method === 'HEAD') {
      if (req.url.startsWith('/space-assets/final/') && !sealed) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Length', sourceSize);
      res.setHeader('ETag', '"source-etag"');
      res.end();
    } else if (req.method === 'PUT') {
      for await (const _chunk of req) { /* Consume the bounded upload. */ }
      sealed = true;
      res.setHeader('ETag', '"source-etag"'); res.end();
    } else if (req.method === 'GET') {
      res.setHeader('Content-Length', 3); res.end('abc');
    } else { res.statusCode = 204; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const adapter = new storage.SeaweedStorage({ ...config, endpoint: `http://127.0.0.1:${server.address().port}` });
  await adapter.finalize('staging/id', 'final/id', 3);
  assert.deepEqual(requests.map(r => r.method), ['HEAD', 'HEAD', 'GET', 'PUT', 'HEAD']);
  assert.equal(requests[2].headers['if-match'], '"source-etag"');
  assert.equal(requests[3].headers['if-none-match'], '*');
  assert.equal(requests[3].headers['content-type'], 'application/octet-stream');
  assert.equal(requests[3].headers['content-disposition'], 'attachment');
  await adapter.finalize('staging/id', 'final/id', 3);
  assert.equal(requests.length, 6, 'retry only checks the sealed destination');
  sourceSize = 2;
  await assert.rejects(adapter.finalize('staging/id', 'final/id', 3), { status: 409, code: 'invalid_upload' });
  await adapter.remove('absent');
});

test('missing staging objects and storage failures are mapped without provider details', async t => {
  let status = 404;
  const server = createServer((_req, res) => { res.statusCode = status; res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const adapter = new storage.SeaweedStorage({ ...config, endpoint: `http://127.0.0.1:${server.address().port}` });
  await assert.rejects(adapter.finalize('staging/id', 'final/id', 3), { status: 409, code: 'upload_not_ready' });
  await adapter.remove('absent');
  status = 403;
  await assert.rejects(adapter.finalize('staging/id', 'final/id', 3), { status: 503, code: 'storage_unavailable', message: 'storage_unavailable' });
});

test('inline signing permits only safe preview MIME types and expires after sixty seconds', async () => {
  const adapter = new storage.SeaweedStorage(config);
  assert.equal(typeof adapter.inline, 'function');
  for (const type of ['image/webp', 'image/gif', 'application/pdf', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4', 'audio/webm', 'video/mp4', 'video/webm', 'video/ogg']) {
    const url = new URL(await adapter.inline('previews/id/display.webp', type));
    assert.equal(url.searchParams.get('response-content-type'), type);
    assert.equal(url.searchParams.get('response-content-disposition'), 'inline');
    assert.equal(url.searchParams.get('X-Amz-Expires'), '60');
  }
  for (const type of ['text/html', 'image/svg+xml', 'application/octet-stream', 'IMAGE/WEBP', 'image/webp\r\nX-Evil: true']) {
    await assert.rejects(adapter.inline('final/id', type), { status: 400, code: 'invalid_preview_type' });
  }
});

test('preview object reads enforce both declared length and streamed byte limits', async t => {
  let mode = 'normal';
  let aborted = false;
  const server = createServer((req, res) => {
    req.on('close', () => { aborted = true; });
    if (mode === 'provider') { res.statusCode = 403; res.end('provider-private-detail'); return; }
    if (mode === 'declared') { res.setHeader('Content-Length', '100'); res.flushHeaders(); return; }
    if (mode === 'streamed') { res.write('ab'); setTimeout(() => res.end('cd'), 5); return; }
    res.setHeader('Content-Length', '3');
    res.end('abc');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const adapter = new storage.SeaweedStorage({ ...config, endpoint: `http://127.0.0.1:${server.address().port}` });
  assert.equal(typeof adapter.read, 'function');
  assert.equal(Buffer.from(await adapter.read('final/id', 3)).toString(), 'abc');
  mode = 'declared';
  await assert.rejects(adapter.read('final/id', 3), { status: 409, code: 'invalid_upload' });
  mode = 'streamed';
  await assert.rejects(adapter.read('final/id', 3), { status: 409, code: 'invalid_upload' });
  mode = 'provider';
  await assert.rejects(adapter.read('final/id', 3), { status: 503, code: 'storage_unavailable', message: 'storage_unavailable' });
  assert.ok(aborted);
});

test('generated preview writes use safe content type and discard original metadata', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ headers: req.headers, body: Buffer.concat(chunks) });
    res.setHeader('ETag', '"preview-etag"');
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const adapter = new storage.SeaweedStorage({ ...config, endpoint: `http://127.0.0.1:${server.address().port}` });
  assert.equal(typeof adapter.write, 'function');
  await adapter.write('previews/id/display.webp', Buffer.from('abc'), 'image/webp');
  assert.equal(requests[0].headers['content-type'], 'image/webp');
  assert.equal(requests[0].headers['content-disposition'], 'attachment');
  assert.equal(requests[0].body.toString(), 'abc');
  await assert.rejects(adapter.write('previews/id/display.webp', Buffer.from('abc'), 'text/html'), { status: 400, code: 'invalid_preview_type' });
});


test('range reads request only inclusive bytes and reject ignored or inconsistent provider ranges', async t => {
  let mode = 'normal';
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.headers.range);
    if (mode === 'ignored') { res.setHeader('Content-Length', '1000000'); res.flushHeaders(); return; }
    res.statusCode = 206;
    if (mode !== 'missing') res.setHeader('Content-Range', mode === 'wrong' ? 'bytes 0-2/10' : mode === 'invalid-total' ? 'bytes 2-4/4' : 'bytes 2-4/10');
    if (mode !== 'no-length') res.setHeader('Content-Length', mode === 'length' ? '4' : '3');
    res.end(mode === 'length' ? 'cdef' : mode === 'short' ? 'cd' : mode === 'no-length' ? 'cdef' : 'cde');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const adapter = new storage.SeaweedStorage({ ...config, endpoint: `http://127.0.0.1:${server.address().port}` });
  assert.equal(Buffer.from(await adapter.read('final/id', 3, { start: 2, end: 4 })).toString(), 'cde');
  assert.equal(requests[0], 'bytes=2-4');
  for (mode of ['ignored', 'missing', 'wrong', 'invalid-total', 'length', 'short', 'no-length']) {
    await assert.rejects(adapter.read('final/id', 3, { start: 2, end: 4 }), { status: 503, code: 'storage_unavailable' }, mode);
  }
  assert.equal(requests.length, 8, 'no whole-object fallback');
  const before = requests.length;
  for (const range of [{ start: -1, end: 1 }, { start: 1.5, end: 2 }, { start: 3, end: 2 }, { start: 0, end: Infinity }, { start: 0, end: Number.MAX_SAFE_INTEGER }, { start: 0, end: 3 }]) {
    await assert.rejects(adapter.read('final/id', 3, range), { status: 409, code: 'invalid_upload' });
  }
  assert.equal(requests.length, before, 'invalid ranges never reach storage');
});

test('an attachment deadline aborts a response stalled after headers', {timeout:3000}, async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, {'content-type':'application/pdf','content-length':'100'});
    res.write('%PDF-1.4\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const adapter = new storage.SeaweedStorage({...config, endpoint:`http://127.0.0.1:${server.address().port}`});
  try {
    await assert.rejects(adapter.read('files/pdf',100,undefined,undefined,AbortSignal.timeout(100)), {code:'storage_unavailable'});
  } finally {
    adapter.client.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
