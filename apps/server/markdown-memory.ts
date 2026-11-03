import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { AppError, MAX_MEMORY_BYTES, memoryContent, memorySourceId, uuid, type MemoryDocument, type MemoryScope, type MemorySource } from '@space/contracts';
import type { MemoryProvider } from '@space/core/memory';
import lockfile from 'proper-lockfile';

const revision = (content: string) => createHash('sha256').update(content).digest('hex');
const sections = (content: string) => [...content.matchAll(/^<!-- space-memory-source:((?:message|document|knowledge):[a-f0-9-]{36}) -->\n([\s\S]*?)^<!-- \/space-memory-source -->\n?/gm)];
function document(content: string): MemoryDocument {
  return { content, revision: revision(content), sources: sections(content).map(match => {
    const url = /^Source: \[View original\]\((\/chat\?[a-z0-9=&%-]+)\)$/m.exec(match[2]!);
    const fingerprint = /^Input fingerprint: ([a-f0-9]{64})$/m.exec(match[2]!)?.[1];
    return { id: match[1]!, title: /^### (.*)$/m.exec(match[2]!)?.[1] ?? 'Saved source', ...(url ? { url: url[1] } : {}), ...(fingerprint ? { fingerprint } : {}) };
  }) };
}

export class MarkdownMemoryProvider implements MemoryProvider {
  readonly id = 'markdown';
  readonly name = 'Markdown files';
  private readonly root: string;
  constructor(directory: string) { this.root = resolve(directory); }
  private async path(scope: MemoryScope, create = false): Promise<string> {
    const workspace = uuid(scope.workspace_id), channel = uuid(scope.channel_id);
    const directories = [this.root, join(this.root, workspace), join(this.root, workspace, channel)];
    for (const directory of directories) {
      if (create) await mkdir(directory, { recursive: directory === this.root, mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new AppError(503, 'memory_storage_unavailable');
    }
    return join(directories[2]!, 'memory.md');
  }
  private async run<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'memory_storage_unavailable');
    }
  }
  private async mutate<T>(scope: MemoryScope, work: (check: () => void) => Promise<T>): Promise<T> {
    return this.run(async () => {
      const path = await this.path(scope, true);
      let compromised: Error | undefined;
      const release = await lockfile.lock(path, { realpath: false, stale: 30_000, update: 5000,
        retries: { retries: 100, factor: 1, minTimeout: 25, maxTimeout: 25, randomize: true },
        onCompromised: error => { compromised = error; } });
      try {
        const check = () => { if (compromised) throw compromised; };
        const result = await work(check);
        check();
        return result;
      } finally { if (!compromised) await release(); }
    });
  }
  async read(scope: MemoryScope): Promise<MemoryDocument> {
    return this.run(async () => {
      try {
        const path = await this.path(scope);
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await file.stat();
          if (!info.isFile()) throw new AppError(503, 'memory_storage_unavailable');
          if (info.size > MAX_MEMORY_BYTES) throw new AppError(413, 'memory_too_large');
          const buffer = Buffer.alloc(MAX_MEMORY_BYTES + 1);
          let size = 0;
          while (size < buffer.length) {
            const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
            if (!bytesRead) break;
            size += bytesRead;
          }
          if (size > MAX_MEMORY_BYTES) throw new AppError(413, 'memory_too_large');
          const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
          memoryContent(content);
          return document(content);
        } finally { await file.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return document('');
        throw error;
      }
    });
  }
  async write(scope: MemoryScope, content: string, expectedRevision: string): Promise<MemoryDocument> {
    return this.mutate(scope, check => this.replace(scope, content, expectedRevision, check));
  }
  private async replace(scope: MemoryScope, content: string, expectedRevision: string, check: () => void): Promise<MemoryDocument> {
    memoryContent(content);
    if (Buffer.byteLength(content, 'utf8') > MAX_MEMORY_BYTES) throw new AppError(413, 'memory_too_large');
    return this.run(async () => {
      const previous = await this.read(scope);
      if (previous.revision !== expectedRevision) throw new AppError(409, 'memory_conflict');
      if (previous.content === content) return previous;
      const path = await this.path(scope, true), temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(content, 'utf8'); await file.sync(); }
        finally { await file.close(); }
        check();
        await rename(temporary, path);
        const directory = await open(dirname(path), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return document(content);
    });
  }
  async ingest(scope: MemoryScope, source: MemorySource): Promise<MemoryDocument> {
    return this.mutate(scope, async check => {
      const id = memorySourceId(source.id), current = await this.read(scope);
      const previous = current.sources.find(item => item.id === id);
      if (previous) {
        if (source.fingerprint && previous.fingerprint !== source.fingerprint) throw new AppError(409, 'memory_source_conflict');
        return current;
      }
      const title = source.title.replace(/[\r\n\u0000-\u001f\u2028\u2029<>]/g, ' ').trim().slice(0, 500);
      const quoted = source.text.split(/\r\n|[\r\n\u2028\u2029]/).map(line => `> ${line}`).join('\n');
      const content = `${current.content}${current.content ? '\n\n' : ''}<!-- space-memory-source:${id} -->\n### ${title}\n${source.url ? `Source: [View original](${source.url})\n` : ''}${source.fingerprint ? `Input fingerprint: ${source.fingerprint}\n` : ''}\n${quoted}\n<!-- /space-memory-source -->\n`;
      return this.replace(scope, content, current.revision, check);
    });
  }
  async remove(scope: MemoryScope, sourceId: string): Promise<MemoryDocument> {
    return this.mutate(scope, async check => {
      const id = memorySourceId(sourceId), current = await this.read(scope);
      const match = sections(current.content).find(section => section[1] === id);
      return match ? this.replace(scope, current.content.replace(match[0], ''), current.revision, check) : current;
    });
  }
  async search(scope: MemoryScope, query: string) {
    const { content } = await this.read(scope), words = query.trim().toLocaleLowerCase().split(/\s+/);
    return content.split('\n').flatMap((line, index) => !line.startsWith('<!--') && words.every(word => line.toLocaleLowerCase().includes(word))
      ? [{ text: line.slice(0, 500), line: index + 1 }] : []).slice(0, 20);
  }
  async clear(scope: MemoryScope): Promise<void> {
    await this.mutate(scope, async check => {
      check();
      try { await unlink(await this.path(scope)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    });
  }
}
