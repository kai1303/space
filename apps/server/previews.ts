import type { AssetPreview } from '@space/contracts';
import { AssetTokenizer } from './asset-tokenizer.js';
import { fileTypeFromBuffer, fileTypeFromTokenizer } from 'file-type';
import sharp from 'sharp';
import type { AssetStorage } from './storage.js';

const maxBytes = 25 * 1024 * 1024;
const maxPixels = 40_000_000;
const maxTextBytes = 256 * 1024;
const rasterTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);
const mediaTypes: Record<string, 'audio' | 'video'> = {
  'audio/mpeg': 'audio', 'audio/wav': 'audio', 'audio/ogg': 'audio',
  'audio/flac': 'audio', 'audio/mp4': 'audio', 'audio/webm': 'audio',
  'video/mp4': 'video', 'video/webm': 'video', 'video/ogg': 'video',
};
const textLanguages: Record<string, string> = {
  log: 'plaintext', txt: 'plaintext', md: 'markdown', markdown: 'markdown', json: 'json', csv: 'plaintext',
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', py: 'python',
  go: 'go', rs: 'rust', java: 'java', css: 'css', html: 'html', xml: 'xml',
  yaml: 'yaml', yml: 'yaml', sh: 'bash', sql: 'sql', svg: 'xml',
};
const unsupported = (reason: string): AssetPreview => ({ kind: 'unsupported', reason });

export async function generateAssetPreview(storage: AssetStorage, id: string, name: string, key: string, size: number, sealed?: Uint8Array): Promise<AssetPreview> {
  if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes) return unsupported('This file exceeds the preview size limit.');
  // The sealed original already has a verified size; PDF classification only needs a prefix.
  if (/\.pdf$/i.test(name)) {
    const limit = Math.min(size, 4100);
    const prefix = sealed?.subarray(0, limit) ?? await storage.read(key, limit, { start: 0, end: limit - 1 });
    if (prefix.length !== limit) return unsupported('The uploaded file size could not be verified.');
    try {
      if ((await fileTypeFromBuffer(prefix))?.mime === 'application/pdf') return { kind: 'pdf', mime: 'application/pdf' };
    } catch { /* Unrecognized prefixes fall back to full byte classification. */ }
  }
  let original = sealed;
  const load = async () => original ??= await storage.read(key, maxBytes);
  const tokenizer = !sealed && size >= 1024 * 1024 ? new AssetTokenizer(storage, key, size) : undefined;
  if (!tokenizer && (await load()).length !== size) return unsupported('The uploaded file size could not be verified.');
  let detected;
  try {
    detected = tokenizer ? await fileTypeFromTokenizer(tokenizer) : await fileTypeFromBuffer(original!);
  } catch (error) {
    if (tokenizer?.failure) throw tokenizer.failure;
    return unsupported('This file could not be recognized.');
  }
  if (tokenizer?.failure) throw tokenizer.failure;
  original ??= tokenizer?.original;
  if (detected && rasterTypes.has(detected.mime)) {
    const bytes = await load();
    if (bytes.length !== size) return unsupported('The uploaded file size could not be verified.');
    // Decode before writing; storage outages must remain retryable rather than becoming unsupported.
    let image: { preview: AssetPreview; thumbnail: Buffer; display?: Buffer };
    try {
      const meta = await sharp(bytes, { limitInputPixels: maxPixels, failOn: 'warning' }).metadata();
      let width = meta.width, height = meta.pageHeight ?? meta.height;
      const pages = meta.pages ?? 1;
      if (!width || !height || pages > 500 || width * height * pages > maxPixels) return unsupported('This image is too large to preview.');
      if ([5, 6, 7, 8].includes(meta.orientation ?? 0)) [width, height] = [height, width];
      const thumbnail = await sharp(bytes, { limitInputPixels: maxPixels, failOn: 'warning' })
        .rotate().resize({ width: 360, height: 240, fit: 'inside', withoutEnlargement: true }).webp({ effort: 2 }).toBuffer();
      if (detected.mime === 'image/gif') {
        // Validate all frames before allowing the browser to play the original GIF.
        await sharp(bytes, { animated: true, limitInputPixels: maxPixels, failOn: 'warning' }).raw().toBuffer();
        image = { preview: { kind: 'image', mime: 'image/gif', width, height }, thumbnail };
      } else {
        // Tiny static images use one encoding and object for both card and viewer.
        const display = width <= 360 && height <= 240 ? thumbnail : await sharp(bytes, { limitInputPixels: maxPixels, failOn: 'warning' })
          .rotate().resize({ width: 1600, height: 1200, fit: 'inside', withoutEnlargement: true }).webp({ effort: 2 }).toBuffer();
        image = { preview: { kind: 'image', mime: 'image/webp', width, height }, thumbnail, display };
      }
    } catch { return unsupported('This image could not be decoded safely.'); }
    if (image.thumbnail !== image.display) await storage.write(`previews/${id}/thumbnail.webp`, image.thumbnail, 'image/webp');
    if (image.display) await storage.write(`previews/${id}/display.webp`, image.display, 'image/webp');
    return image.preview;
  }
  const ext = detected?.ext;
  if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx' || ext === 'odt' || ext === 'ods' || ext === 'odp')
    return { kind: 'office', fileType: ext };
  if (detected?.mime === 'application/pdf') return { kind: 'pdf', mime: 'application/pdf' };
  // The detector identifies the container. Audio-only WebM and MP4 can share video magic.
  if (detected?.mime === 'video/webm' && /\.weba$/i.test(name)) return { kind: 'audio', mime: 'audio/webm' };
  if (detected?.mime === 'audio/x-m4a' || (detected?.mime === 'video/mp4' && /\.m4a$/i.test(name)))
    return { kind: 'audio', mime: 'audio/mp4' };
  if (detected?.mime === 'audio/ogg; codecs=opus') return { kind: 'audio', mime: 'audio/ogg' };
  if (detected && mediaTypes[detected.mime]) return { kind: mediaTypes[detected.mime]!, mime: detected.mime };
  // Recognized binary formats never fall back to text, even with a misleading extension.
  if (detected && detected.mime !== 'application/xml') return unsupported('A preview is not available for this file type.');
  const language = textLanguages[name.split('.').at(-1)?.toLowerCase() ?? ''];
  if (!language) return unsupported('A preview is not available for this file type.');
  const bytes = await load();
  if (bytes.length !== size) return unsupported('The uploaded file size could not be verified.');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return unsupported('This file does not contain valid UTF-8 text.'); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) return unsupported('This file contains binary data.');
  const truncated = bytes.length > maxTextBytes;
  if (truncated) {
    let end = maxTextBytes;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
  }
  return { kind: 'text', text, language, truncated };
}
