import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { AppError, MAX_MEMORY_BYTES, memoryContent } from '@space/contracts';

const uuidDirectory = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function* directories(parent: string) {
  for await (const entry of await opendir(parent)) {
    if (!uuidDirectory.test(entry.name)) continue;
    if (!entry.isDirectory()) throw new Error(`Invalid legacy memory directory: ${join(parent, entry.name)}`);
    yield entry.name;
  }
}

async function readDocument(path: string): Promise<string | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(error => { if (!missing(error)) throw error; });
  if (!file) return;
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Expected a regular Markdown file');
    if (stat.size > MAX_MEMORY_BYTES) throw new AppError(413, 'memory_too_large');
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw new Error('Legacy memory changed during import');
    return memoryContent(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } finally { await file.close(); }
}

// Run against the read-only legacy volume after old writers are stopped. Import every surviving
// channel, including those currently disabled or using another provider. A retry preserves newer DB writes.
export async function importMemoryDocuments(pool: Pool, root: string, allowMissingRoot = false): Promise<number> {
  const info = await lstat(root).catch(error => { if (!allowMissingRoot || !missing(error)) throw error; });
  if (!info) return 0;
  if (!info.isDirectory()) throw new Error(`Invalid legacy memory directory: ${root}`);
  let imported = 0;
  for await (const workspace of directories(root)) {
    for await (const channel of directories(join(root, workspace))) {
      const args = [workspace, channel];
      const { rowCount } = await pool.query(`SELECT 1 FROM channels c WHERE c.workspace_id=$1 AND c.id=$2
        AND NOT EXISTS (SELECT 1 FROM channel_memory_documents d WHERE d.channel_id=c.id)`, args);
      if (!rowCount) continue;
      const path = join(root, workspace, channel, 'memory.md');
      let content;
      try { content = await readDocument(path); }
      catch (cause) { throw new Error(`Could not import legacy memory: ${path}`, { cause }); }
      if (content === undefined) continue;
      const saved = await pool.query(`INSERT INTO channel_memory_documents(workspace_id,channel_id,content)
        SELECT workspace_id,id,$3 FROM channels WHERE workspace_id=$1 AND id=$2 ON CONFLICT (channel_id) DO NOTHING`,
        [...args, content]);
      imported += saved.rowCount ?? 0;
    }
  }
  return imported;
}
