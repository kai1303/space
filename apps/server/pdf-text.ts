import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AppError, MAX_AGENT_PDF_CHARS, MAX_AGENT_PDF_PAGES, MAX_ASSET_BYTES, type AgentPdfContent } from '@space/contracts';
import type { AssetStorage } from './storage.js';

const execute = promisify(execFile);
let running = 0;

function poppler(tool: string, args: string[], timeout: number) {
  return execute(process.platform === 'linux' ? 'prlimit' : tool, process.platform === 'linux'
    ? ['--as=536870912', '--cpu=4', '--', tool, ...args] : args, {
    timeout, killSignal:'SIGKILL', maxBuffer:256 * 1024, windowsHide:true, encoding:'utf8',
    env:{...process.env, LC_ALL:'C'},
  });
}

export async function readPdfPages(storage: AssetStorage, key: string, size: number, firstPage = 1, count = MAX_AGENT_PDF_PAGES, budgetMs = 8000): Promise<AgentPdfContent> {
  if (!Number.isSafeInteger(firstPage) || firstPage < 1 || !Number.isSafeInteger(count) || count < 1 || count > MAX_AGENT_PDF_PAGES)
    throw new AppError(400, 'invalid_pdf_page');
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 8000) throw new AppError(400, 'invalid_pdf_budget');
  const result: AgentPdfContent = {kind:'pdf', page_count:null, pages:[], status:'unavailable'};
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_ASSET_BYTES) return result;
  if (running >= 2) throw new AppError(503, 'pdf_reader_busy');
  running++;
  let directory: string | undefined;
  try {
    const deadline = Date.now() + budgetMs;
    const signal = AbortSignal.timeout(budgetMs);
    let bytes: Uint8Array;
    try { bytes = await storage.read(key, size, undefined, undefined, signal); }
    catch (error) { if (signal.aborted) return result; throw error; }
    if (bytes.length !== size) return result;
    directory = await mkdtemp(join(tmpdir(), 'space-pdf-text-'));
    const path = join(directory, 'input.pdf');
    await writeFile(path, bytes, {mode:0o600});
    if (Date.now() >= deadline) return result;
    try {
      const info = await poppler('pdfinfo', [path], Math.max(1, Math.min(4000, deadline - Date.now())));
      const total = Number([...info.stdout.matchAll(/^Pages:\s+(\d+)\s*$/gm)].at(-1)?.[1]);
      if (!Number.isSafeInteger(total) || total < 1) return result;
      result.page_count = total;
      if (firstPage > total) return {...result, status:'out_of_range'};
      const length = Math.min(count, total - firstPage + 1);
      const budget = Math.floor(MAX_AGENT_PDF_CHARS / length);
      const pages: AgentPdfContent['pages'] = [];
      for (let page = firstPage; page < firstPage + length; page++) {
        const timeout = deadline - Date.now();
        if (timeout < 1) return result;
        // Extract each physical page separately; a form feed in source text is not a page boundary.
        let text: string, overflow = false;
        try {
          const args = ['-f', String(page), '-l', String(page), '-enc', 'UTF-8', '-nopgbrk', path, '-'];
          text = (await poppler('pdftotext', args, Math.min(timeout, 4000))).stdout;
        } catch (error) {
          const failure = error as NodeJS.ErrnoException & { stdout?: string; message: string };
          if (failure.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || !failure.message.startsWith('stdout') || !failure.stdout) throw error;
          text = failure.stdout;
          overflow = true;
        }
        text = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim();
        const last = text.charCodeAt(budget - 1);
        const end = last >= 0xd800 && last <= 0xdbff ? budget - 1 : budget;
        pages.push({page, text:text.slice(0, end), truncated:overflow || text.length > end});
      }
      return {...result, pages, status:pages.some(p => p.text) ? 'readable' : 'no_text'};
    } catch {
      // A malformed, protected or resource-limited document still permits a metadata-only turn.
      return result;
    }
  } finally {
    try { if (directory) await rm(directory, {recursive:true, force:true}); }
    finally { running--; }
  }
}
