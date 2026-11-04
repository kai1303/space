import { AppError, record, text } from './validation.js';
import { parseRichDocument, type RichDocument } from './rich-text.js';

export interface TodoSyncInput {
  external_id: string;
  revision: string;
  title: string;
  completed: boolean;
  document: RichDocument | null;
  url: string | null;
}
export function parseTodoSync(input: unknown): TodoSyncInput {
  const value = record(input, ['external_id', 'revision', 'title', 'completed', 'document', 'url']);
  const revision = value.revision;
  if (typeof revision !== 'string' || !/^[1-9]\d{0,18}$/.test(revision) || BigInt(revision) > 9223372036854775807n) throw new AppError(400, 'invalid_revision');
  if (typeof value.completed !== 'boolean') throw new AppError(400, 'invalid_completed');
  let url: string | null = null;
  if (value.url != null) {
    try {
      const parsed = new URL(text(value.url, 2048));
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
      url = parsed.href;
    } catch { throw new AppError(400, 'invalid_source_url'); }
  }
  return { external_id: text(value.external_id, 200), revision, title: text(value.title, 500).trim(), completed: value.completed,
    document: value.document == null ? null : parseRichDocument(value.document), url };
}
