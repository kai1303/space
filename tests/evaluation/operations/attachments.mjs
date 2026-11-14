import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { MAX_ASSET_BYTES } from '@space/contracts';

const fixture = path => readFile(new URL('../../fixtures/' + path, import.meta.url));
export async function attachments(ctx, { call, owner, peer, channel, ws, dm }) {
  const a = call('Attachments'), m = call('Messages'), mp = call('Messages', peer);
  const base = '/workspaces/' + ws + '/hub/files';
  await a('Configuration', 'GET', '/assets/config');
  async function upload(kind, name, bytes, encrypted = false) {
    const room = '/channels/' + (encrypted ? dm : channel);
    const metadata = { name, size: bytes.length, type: 'application/octet-stream', ...(encrypted ? { encrypted } : {}) };
    const { asset, upload } = await a('Reserve ' + kind, 'POST', room + '/assets', metadata, 201);
    ctx.keys.add(upload.fields.key);
    ctx.keys.add('files/' + asset.id);
    if (kind === 'PNG' || kind === 'PDF') ctx.keys.add('previews/' + asset.id + '/thumbnail.webp');
    if (kind === 'PNG') ctx.keys.add('previews/' + asset.id + '/display.webp');
    const blob = new Blob([bytes], {type: 'application/octet-stream'});
    let body = blob;
    if (!upload.put_url) {
      body = new FormData();
      for (const [key, value] of Object.entries(upload.fields)) body.append(key, value);
      body.append('file', blob, name);
    }
    await ctx.measure('Attachments', 'Upload bytes ' + kind, async () => {
      const r = await fetch(upload.put_url ?? upload.url, { method: upload.put_url ? 'PUT' : 'POST', body, signal: AbortSignal.timeout(30000) });
      await r.arrayBuffer();
      assert.ok(r.ok, 'Upload ' + r.status);
    });
    const path = '/assets/' + asset.id;
    assert.equal((await a('Complete ' + kind, 'POST', path + '/complete', {})).id, asset.id);
    if (!encrypted) await a('Send with attachment', 'POST', room + '/messages', { client_message_id: randomUUID(), text: '', asset_ids: [asset.id] }, 201);
    return { path, id: asset.id };
  }
  async function download(label, path, expectedBytes) {
    const data = await ctx.measure('Attachments', label, async () => {
      const url = await a(label + ' redirect', 'GET', path, undefined, 302);
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      assert.ok(r.ok);
      return Buffer.from(await r.arrayBuffer());
    });
    if (expectedBytes) assert.ok(data.equals(expectedBytes), label);
    else assert.ok(data.length > 0);
  }
  const imageBytes = await fixture('preview/preview-image.png');
  const image = await ctx.measure('Attachments', 'Attach PNG and send', () => upload('PNG', 'image.png', imageBytes));
  await a('Channel files', 'GET', '/channels/' + channel + '/assets');
  await a('Workspace files', 'GET', base);
  await a('Star file', 'POST', base + '/' + image.id + '/star', { active: true });
  await a('Record file view', 'POST', base + '/' + image.id + '/view', {});
  const details = await a('File details', 'GET', image.path + '/details');
  await a('Edit file details', 'PUT', image.path + '/details', { name: 'renamed.png', description: 'Image',
    previous_name: details.name, previous_description: details.description });
  assert.equal((await a('Image preview', 'GET', image.path + '/preview')).kind, 'image');
  await download('Image thumbnail', image.path + '/thumbnail');
  await download('Image display', image.path + '/content');
  await download('Original image', image.path + '/original-image', imageBytes);
  const pdfBytes = await fixture('preview/two-pages.pdf');
  const pdf = await upload('PDF', 'two-pages.pdf', pdfBytes);
  assert.ok((await a('PDF bytes', 'GET', pdf.path + '/content')).equals(pdfBytes));
  await a('PDF headers', 'HEAD', pdf.path + '/content');
  assert.ok((await a('PDF range', 'GET', pdf.path + '/content', undefined, 206, { range: 'bytes=0-4' })).equals(pdfBytes.subarray(0, 5)));
  // Cold and cached thumbnails share a dependency. Other file operations can still run after overload.
  try {
    await download('Generate PDF thumbnail', pdf.path + '/thumbnail');
    await download('Cached PDF thumbnail', pdf.path + '/thumbnail');
  } catch (error) {
    if (error.actual !== 503 || !error.message.includes('preview_busy')) throw error;
  }
  for (const [kind, name] of [['audio', 'tone.wav'], ['video', 'clip.mp4'], ['text', 'example.ts'], ['unsupported', 'archive.zip']]) {
    const bytes = await fixture('preview/' + name);
    const file = await upload(kind, name, bytes);
    assert.equal((await a('Preview ' + kind, 'GET', file.path + '/preview')).kind, kind);
    if (kind === 'audio' || kind === 'video') await download('Stream ' + kind, file.path + '/content', bytes);
  }
  const large = Buffer.alloc(MAX_ASSET_BYTES, 0x30);
  const max = await ctx.measure('Attachments', 'Attach 25 MiB and send', () => upload('25 MiB', 'large.bin', large));
  await download('Download 25 MiB', max.path + '/download', large);
  const office = await upload('DOCX', 'Runbook.docx', await fixture('office/Runbook.docx'));
  await a('Office view session', 'GET', office.path + '/office-session');
  await a('Office edit session', 'GET', office.path + '/office-session?mode=edit');
  await a('Office sharing', 'PUT', office.path + '/office-sharing', { enabled: true }, 204);
  const thumb = await a('Generate Office thumbnail', 'GET', office.path + '/thumbnail');
  assert.equal(thumb.toString('ascii', 1, 4), 'PNG');
  const repeat = await a('Reopen Office thumbnail', 'GET', office.path + '/thumbnail');
  assert.ok(repeat.equals(thumb));

  // Ask the real document server for a cached DOCX, as an editor would before a save callback.
  const jwt = claims => {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const data = encode({ alg: 'HS256' }) + '.' + encode({ ...claims, exp: Math.floor(Date.now() / 1000) + 120 });
    return data + '.' + createHmac('sha256', ctx.office.secret).update(data).digest('base64url');
  };
  const edit = (await a('Office edit session', 'GET', office.path + '/office-session?mode=edit')).config;
  const convert = { key: randomUUID(), filetype: 'docx', outputtype: 'docx', url: edit.document.url, async: false };
  const token = jwt(convert);
  const converted = await fetch(new URL('/converter', ctx.office.url), { method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ ...convert, token }), signal: AbortSignal.timeout(30000) });
  assert.ok(converted.ok);
  const result = await converted.json();
  assert.ok(result.endConvert && result.fileUrl, 'DOCX conversion failed: ' + result.error);
  const save = { status: 2, key: edit.document.key, users: [edit.editorConfig.user.id], url: result.fileUrl };
  const service = ctx.client('203.0.113.' + ctx.round);
  const headers = (operation, payload) => ({ authorization: 'Bearer ' + jwt({ operation, payload }) });
  const saved = await service.call('Attachments', 'Office save callback', 'POST', '/v1/office/callback', save, 200, headers('callback', save));
  assert.equal(saved.error, 0);
  const revision = '/v1/office/files/' + office.id + '/1';
  const content = await service.call('Attachments', 'Office revision bytes', 'GET', revision, undefined, 200,
    headers('download', { url: new URL(revision, ctx.office.callbackBase).href }));
  assert.equal(content.readUInt16BE(), 0x504b);
  const enc = '/channels/' + dm + '/encryption';
  const device = () => ({ id: randomUUID(), public_key: '-----BEGIN PGP PUBLIC KEY BLOCK-----\n' + randomBytes(64).toString('base64') +
    '\n-----END PGP PUBLIC KEY BLOCK-----', authorization: randomBytes(32).toString('hex'), recovery: randomBytes(32).toString('hex') });
  const one = device(), two = device(), spare = { ...device(), recovery: one.recovery };
  await m('Enroll DM device', 'POST', enc + '/enroll', one);
  await mp('Enroll DM device', 'POST', enc + '/enroll', two);
  const recipients = [one.id, two.id].sort();
  await m('Read DM encryption', 'GET', enc);
  await m('Enable DM encryption', 'POST', enc + '/enable', { recipients });
  const cipher = randomBytes(16384);
  const file = await upload('encrypted', 'Encrypted file', cipher, true);
  await m('Send encrypted attachment', 'POST', '/channels/' + dm + '/messages', { client_message_id: randomUUID(),
    encrypted: { version: 1, sender: one.id, recipients, ciphertext: randomBytes(128).toString('base64'), asset_ids: [file.id] } }, 201);
  assert.ok((await call('Attachments', peer)('Encrypted content', 'GET', file.path + '/encrypted-content')).equals(cipher));
  await m('Enroll DM device', 'POST', enc + '/enroll', spare);
  await m('Revoke DM device', 'POST', enc + '/revoke', { id: spare.id });
}
