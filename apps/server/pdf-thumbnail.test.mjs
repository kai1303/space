import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

const { generatePdfThumbnail } = await import('./dist/pdf-thumbnail.js').catch(() => ({}));
const pdf = await readFile(new URL('../../tests/fixtures/preview/two-pages.pdf', import.meta.url));
function fixture(bytes = pdf) {
  const writes = [];
  const storage = {
    async read(_key, max) { assert.equal(max, 25 * 1024 * 1024); return bytes; },
    async write(key, data, type) { writes.push({ key, data, type }); },
  };
  return { storage, writes, run: () => { assert.equal(typeof generatePdfThumbnail, 'function'); return generatePdfThumbnail(storage, 'test-id', 'files/test-id', bytes.length); } };
}
test('renders one bounded metadata-free WebP from the first PDF page', async () => {
  const f = fixture();
  assert.equal(await f.run(), true);
  assert.equal(f.writes.length, 1);
  const { key, data, type } = f.writes[0];
  assert.equal(key, 'previews/test-id/thumbnail.webp');
  assert.equal(type, 'image/webp');
  const m = await sharp(data).metadata();
  assert.equal(m.format, 'webp');
  assert.ok(m.width <= 360 && m.height <= 240);
  assert.equal(m.pages, undefined);
  assert.equal(m.exif, undefined);
  assert.ok(data.length < 64 * 1024);
  const pixels = await sharp(data).stats();
  assert.ok(pixels.channels.some(c => c.min < c.max), 'thumbnail contains page content');
});
test('invalid PDF and invalid sizes return no thumbnail without writes', async () => {
  const f = fixture(Buffer.from('%PDF-1.7\ninvalid'));
  assert.equal(await f.run(), false);
  assert.equal(f.writes.length, 0);
  const untouched = { read() { throw new Error('must not read'); } };
  for (const size of [0, -1, NaN, 25 * 1024 * 1024 + 1]) assert.equal(await generatePdfThumbnail(untouched, 'id', 'key', size), false);
});
test('storage outages stay retryable rather than becoming permanent failed thumbnails', async () => {
  const f = fixture();
  const error = new Error('storage unavailable');
  f.storage.read = async () => { throw error; };
  await assert.rejects(f.run(), error);
  const g = fixture();
  g.storage.write = async () => { throw error; };
  await assert.rejects(g.run(), error);
});
test('only two conversions can retain input bytes at once; overload is retryable', async () => {
  const gates = [];
  const storage = { read: () => new Promise(resolve => gates.push(resolve)), write: async () => {} };
  const a = generatePdfThumbnail(storage, 'a', 'a', 15), b = generatePdfThumbnail(storage, 'b', 'b', 15);
  try { await assert.rejects(generatePdfThumbnail(storage, 'c', 'c', 15), { status: 503, code: 'preview_busy' }); }
  finally { gates.forEach(resolve => resolve(Buffer.from('%PDF-1.7\ninvalid'))); }
  assert.deepEqual(await Promise.all([a, b]), [false, false]);
});
