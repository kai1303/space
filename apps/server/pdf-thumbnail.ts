import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AppError, MAX_ASSET_BYTES } from '@space/contracts';
import sharp from 'sharp';
import type { AssetStorage } from './storage.js';

const execute = promisify(execFile);
let running = 0;

export async function generatePdfThumbnail(storage: AssetStorage, id: string, key: string, size: number): Promise<boolean> {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_ASSET_BYTES) return false;
  if (running >= 2) throw new AppError(503, 'preview_busy');
  running++;
  let directory: string | undefined;
  try {
    const bytes = await storage.read(key, MAX_ASSET_BYTES);
    if (bytes.length !== size) return false;
    directory = await mkdtemp(join(tmpdir(), 'space-pdf-'));
    const input = join(directory, 'input.pdf');
    await writeFile(input, bytes, { mode: 0o600 });
    const args = ['-f', '1', '-l', '1', '-singlefile', '-scale-to', '720', '-hide-annotations', input];
    let raster: Buffer;
    try {
      // Bound native decoding too; raster dimensions alone do not bound PDF resources.
      const {stdout} = await execute(process.platform === 'linux' ? 'prlimit' : 'pdftoppm', process.platform === 'linux'
        ? ['--as=536870912', '--cpu=5', '--fsize=4194304', '--', 'pdftoppm', ...args] : args,
      { encoding: 'buffer', timeout: 8000, killSignal: 'SIGKILL', maxBuffer: 720 * 720 * 3 + 128, windowsHide: true });
      raster = stdout;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EACCES' || Number(code) === 127) throw new AppError(503, 'pdf_renderer_unavailable');
      return false;
    }
    // pdftoppm emits an 8-bit RGB P6 raster. Keep every pixel and avoid an
    // intermediate PNG encode/decode before the final WebP conversion.
    const header = /^P6\n(\d{1,3}) (\d{1,3})\n255\n/.exec(raster.toString('latin1', 0, 32));
    if (!header) return false;
    const width = Number(header[1]), height = Number(header[2]);
    const pixels = raster.subarray(header[0].length);
    if (!width || !height || width > 720 || height > 720 || pixels.length !== width * height * 3) return false;
    let thumbnail: Buffer;
    try {
      thumbnail = await sharp(pixels, { raw: { width, height, channels: 3 } })
        .resize({ width: 360, height: 240, fit: 'inside', withoutEnlargement: true }).webp().toBuffer();
    } catch { return false; }
    await storage.write(`previews/${id}/thumbnail.webp`, thumbnail, 'image/webp');
    return true;
  } finally {
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    finally { running--; }
  }
}
