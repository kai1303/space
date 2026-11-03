import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    const input = join(directory, 'input.pdf'), output = join(directory, 'page');
    await writeFile(input, bytes, { mode: 0o600 });
    const args = ['-f', '1', '-l', '1', '-singlefile', '-scale-to', '720', '-png', '-hide-annotations', input, output];
    try {
      // Bound native decoding too; raster dimensions alone do not bound PDF resources.
      await execute(process.platform === 'linux' ? 'prlimit' : 'pdftoppm', process.platform === 'linux'
        ? ['--as=536870912', '--cpu=5', '--fsize=4194304', '--', 'pdftoppm', ...args] : args,
      { timeout: 8000, killSignal: 'SIGKILL', maxBuffer: 65_536, windowsHide: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EACCES' || Number(code) === 127) throw new AppError(503, 'pdf_renderer_unavailable');
      return false;
    }
    const png = await readFile(`${output}.png`);
    let thumbnail: Buffer;
    try {
      thumbnail = await sharp(png, { limitInputPixels: 720 * 720, failOn: 'warning' })
        .resize({ width: 360, height: 240, fit: 'inside', withoutEnlargement: true }).webp().toBuffer();
    } catch { return false; }
    await storage.write(`previews/${id}/thumbnail.webp`, thumbnail, 'image/webp');
    return true;
  } finally {
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    finally { running--; }
  }
}
