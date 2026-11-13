import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { AppError, MAX_MEMORY_BYTES, memoryContent, memorySourceId, uuid, type MemoryDocument, type MemoryScope, type MemorySource } from '@space/contracts';
import type { MemoryProvider } from '@space/core/memory';

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
  readonly name = 'Markdown';
  constructor(private readonly pool: Pool) {}

  private async query<Row extends QueryResultRow>(statement: string, values: string[]) {
    try { return await this.pool.query<Row>(statement, values); }
    catch { throw new AppError(503, 'memory_storage_unavailable'); }
  }

  async read(scope: MemoryScope): Promise<MemoryDocument> {
    const { rows } = await this.query<{ content: string }>(
      'SELECT content FROM channel_memory_documents WHERE workspace_id=$1 AND channel_id=$2',
      [uuid(scope.workspace_id), uuid(scope.channel_id)]);
    return document(rows[0]?.content ?? '');
  }

  // A saved empty row also prevents a later import from resurrecting a cleared legacy document.
  private async replace(scope: MemoryScope, previous: string, content: string): Promise<boolean> {
    memoryContent(content);
    if (Buffer.byteLength(content) > MAX_MEMORY_BYTES) throw new AppError(413, 'memory_too_large');
    const args = [uuid(scope.workspace_id), uuid(scope.channel_id), content, previous];
    const result = previous === ''
      ? await this.query(`INSERT INTO channel_memory_documents(workspace_id,channel_id,content) VALUES ($1,$2,$3)
          ON CONFLICT (channel_id) DO UPDATE SET content=excluded.content
          WHERE channel_memory_documents.workspace_id=$1 AND channel_memory_documents.content=$4`, args)
      : await this.query(`UPDATE channel_memory_documents SET content=$3
          WHERE workspace_id=$1 AND channel_id=$2 AND content=$4`, args);
    return result.rowCount === 1;
  }

  async write(scope: MemoryScope, content: string, expectedRevision: string): Promise<MemoryDocument> {
    const current = await this.read(scope);
    if (current.revision !== expectedRevision || !await this.replace(scope, current.content, content)) {
      throw new AppError(409, 'memory_conflict');
    }
    return document(content);
  }

  // Source-level edits can rebase on a concurrent change. Full-document edits must keep their original revision.
  private async merge(scope: MemoryScope, edit: (current: MemoryDocument) => string): Promise<MemoryDocument> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const current = await this.read(scope);
      const content = edit(current);
      if (content === current.content) return current;
      if (await this.replace(scope, current.content, content)) return document(content);
    }
    throw new AppError(409, 'memory_conflict');
  }

  async ingest(scope: MemoryScope, source: MemorySource): Promise<MemoryDocument> {
    const id = memorySourceId(source.id);
    return this.merge(scope, current => {
      const previous = current.sources.find(item => item.id === id);
      if (previous) {
        if (source.fingerprint && previous.fingerprint !== source.fingerprint) throw new AppError(409, 'memory_source_conflict');
        return current.content;
      }
      const title = source.title.replace(/[\r\n\u0000-\u001f\u2028\u2029<>]/g, ' ').trim().slice(0, 500);
      const quoted = source.text.split(/\r\n|[\r\n\u2028\u2029]/).map(line => `> ${line}`).join('\n');
      return `${current.content}${current.content ? '\n\n' : ''}<!-- space-memory-source:${id} -->\n### ${title}\n${source.url ? `Source: [View original](${source.url})\n` : ''}${source.fingerprint ? `Input fingerprint: ${source.fingerprint}\n` : ''}\n${quoted}\n<!-- /space-memory-source -->\n`;
    });
  }
  async remove(scope: MemoryScope, sourceId: string): Promise<MemoryDocument> {
    const id = memorySourceId(sourceId);
    return this.merge(scope, current => {
      const match = sections(current.content).find(section => section[1] === id);
      return match ? current.content.replace(match[0], '') : current.content;
    });
  }
  async search(scope: MemoryScope, query: string) {
    const { content } = await this.read(scope), words = query.trim().toLocaleLowerCase().split(/\s+/);
    return content.split('\n').flatMap((line, index) => !line.startsWith('<!--') && words.every(word => line.toLocaleLowerCase().includes(word))
      ? [{ text: line.slice(0, 500), line: index + 1 }] : []).slice(0, 20);
  }
  async clear(scope: MemoryScope): Promise<void> {
    await this.query(`INSERT INTO channel_memory_documents(workspace_id,channel_id,content) VALUES ($1,$2,'')
      ON CONFLICT (channel_id) DO UPDATE SET content='' WHERE channel_memory_documents.workspace_id=$1`,
      [uuid(scope.workspace_id), uuid(scope.channel_id)]);
  }
}
