import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';

const { generateAssetPreview } = await import('./dist/previews.js').catch(() => ({}));
function fixture(bytes, options = {}) {
  const writes = new Map();
  const storage = {
    async read(_key, maxBytes) { assert.equal(maxBytes, 25 * 1024 * 1024); return bytes; },
    async write(key, data, type) { writes.set(key, { data, type }); },
    ...options,
  };
  return { writes, run: (name = 'file.bin', size = bytes.length) => {
    assert.equal(typeof generateAssetPreview, 'function', 'preview generator is exported');
    return generateAssetPreview(storage, 'test-id', name, 'final/test-id', size);
  } };
}

test('detects actual image bytes, rotates and removes metadata while creating bounded WebP derivatives', async () => {
  const bytes = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#123456' } })
    .jpeg().withMetadata({ orientation: 6, exif: { IFD0: { Artist: 'Private author' } } }).toBuffer();
  const { run, writes } = fixture(bytes);
  assert.deepEqual(await run('spoof.html'), { kind: 'image', mime: 'image/webp', width: 1000, height: 2000 });
  assert.equal(writes.size, 2);
  for (const [key, maxWidth, maxHeight] of [['previews/test-id/thumbnail.webp', 360, 240], ['previews/test-id/display.webp', 1600, 1200]]) {
    const object = writes.get(key);
    assert.equal(object.type, 'image/webp');
    const meta = await sharp(object.data).metadata();
    assert.ok(meta.width <= maxWidth && meta.height <= maxHeight);
    assert.equal(meta.format, 'webp');
    assert.equal(meta.exif, undefined);
    assert.equal(meta.orientation, undefined);
  }
});

test('preserves GIF playback and generates a first-frame WebP thumbnail', async () => {
  const gif = await sharp(Buffer.from([255, 0, 0, 0, 255, 0]), { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } }).gif({ delay: [100, 100], loop: 0 }).toBuffer();
  assert.equal((await sharp(gif, { animated: true }).metadata()).pages, 2);
  const { run, writes } = fixture(gif);
  assert.deepEqual(await run('animation.txt'), { kind: 'image', mime: 'image/gif', width: 1, height: 1 });
  assert.deepEqual([...writes.keys()], ['previews/test-id/thumbnail.webp']);
  const firstFrame = await sharp(writes.get('previews/test-id/thumbnail.webp').data).raw().toBuffer();
  assert.ok(firstFrame[0] > 200 && firstFrame[1] < 40, 'thumbnail shows the first red frame');
});

test('small static images share one metadata-stripped WebP for thumbnail and display', async () => {
  for (const [width, count] of [[360, 1], [361, 2]]) {
    const bytes = await sharp({ create: { width, height: 240, channels: 3, background: '#123456' } })
      .png().withMetadata({ exif: { IFD0: { Artist: 'Private author' } } }).toBuffer();
    const { run, writes } = fixture(bytes);
    assert.deepEqual(await run('small.png'), { kind: 'image', mime: 'image/webp', width, height: 240 });
    assert.equal(writes.size, count);
    const meta = await sharp(writes.get('previews/test-id/display.webp').data).metadata();
    assert.equal(meta.width, width);
    assert.equal(meta.height, 240);
    assert.equal(meta.exif, undefined);
  }
});

test('invalid images and excessive decoded dimensions become unsupported without derivatives', async () => {
  const malformed = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
  const huge = await sharp({ create: { width: 6400, height: 6400, channels: 3, background: 'white' } }).png().toBuffer();
  for (const bytes of [malformed, huge]) {
    const { run, writes } = fixture(bytes);
    const preview = await run('file.jpg');
    assert.equal(preview.kind, 'unsupported');
    assert.ok(preview.reason.length);
    assert.equal(writes.size, 0);
  }
});

test('recognizes PDF and common audio/video containers from bytes rather than filenames', async () => {
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0); wav.writeUInt32LE(36, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  const mp4 = Buffer.from('00000018667479706d7034320000000069736f6d6d7034320000000866726565', 'hex');
  assert.deepEqual(await fixture(Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF')).run('file.txt'), { kind: 'pdf', mime: 'application/pdf' });
  assert.deepEqual(await fixture(wav).run('file.png'), { kind: 'audio', mime: 'audio/wav' });
  assert.deepEqual(await fixture(mp4).run('file.txt'), { kind: 'video', mime: 'video/mp4' });
});

test('PDF uploads classify from a bounded range without reading the full original', async () => {
  const bytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(4 * 1024 * 1024)]);
  const calls = [];
  const { run, writes } = fixture(bytes, { async read(key, maxBytes, range) {
    calls.push({ maxBytes, range });
    return range ? bytes.subarray(range.start, range.end + 1) : bytes;
  } });
  assert.deepEqual(await run('report.PDF'), { kind: 'pdf', mime: 'application/pdf' });
  assert.deepEqual(calls, [{ maxBytes: 4100, range: { start: 0, end: 4099 } }]);
  assert.equal(writes.size, 0);
  const spoof = fixture(Buffer.from('<script>not a PDF</script>'), { async read() { return Buffer.from('<script>not a PDF</script>'); } });
  assert.equal((await spoof.run('spoof.pdf')).kind, 'unsupported');
  const error = new Error('storage_unavailable');
  await assert.rejects(fixture(bytes, { async read() { throw error; } }).run('outage.pdf'), error);
});

test('HTML and SVG are inert text; strict UTF-8, binary magic and controls reject unsafe text fallbacks', async () => {
  assert.deepEqual(await fixture(Buffer.from('<script>alert(1)</script>')).run('page.HTML'), { kind: 'text', text: '<script>alert(1)</script>', language: 'html', truncated: false });
  assert.equal((await fixture(Buffer.from('<svg onload="alert(1)"></svg>')).run('icon.svg')).kind, 'text');
  assert.equal((await fixture(Buffer.from('<?xml version="1.0"?><svg onload="alert(1)"></svg>')).run('icon.svg')).kind, 'text');
  assert.equal((await fixture(Buffer.from('<?xml version="1.0"?><root/>')).run('data.xml')).kind, 'text');
  assert.equal((await fixture(Buffer.from('const count = 1;')).run('sample.ts')).language, 'typescript');
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from('binary\0data'), Buffer.from([65, 1, 66]), Buffer.from('PK\x03\x04' + 'not a text file')]) {
    assert.equal((await fixture(bytes).run('spoof.txt')).kind, 'unsupported');
  }
  assert.equal((await fixture(Buffer.from('hello')).run('unknown.bin')).kind, 'unsupported');
});

test('text truncation keeps complete Unicode characters and validates the full original', async () => {
  const bytes = Buffer.from('a'.repeat(256 * 1024 - 1) + '😀more');
  const preview = await fixture(bytes).run('file.txt');
  assert.equal(preview.kind, 'text');
  assert.equal(preview.truncated, true);
  assert.equal(preview.text, 'a'.repeat(256 * 1024 - 1));
  const binaryTail = Buffer.concat([Buffer.alloc(256 * 1024, 65), Buffer.from([0])]);
  assert.equal((await fixture(binaryTail).run('file.txt')).kind, 'unsupported');
});

test('storage errors stay retryable instead of being persisted as unsupported previews', async () => {
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
  const error = Object.assign(new Error('storage_unavailable'), { status: 503, code: 'storage_unavailable' });
  await assert.rejects(fixture(bytes, { async read() { throw error; } }).run(), error);
  await assert.rejects(fixture(bytes, { async write() { throw error; } }).run(), error);
});
