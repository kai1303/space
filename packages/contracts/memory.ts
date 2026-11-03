import { AppError, record, text, uuid } from './validation.js';

export const MAX_MEMORY_CHARS = 200_000;
export const MAX_MEMORY_BYTES = 512 * 1024;
export const MAX_MEMORY_IMPORT_BYTES = 100_000;
export type MemoryScope = { workspace_id: string; channel_id: string };
export type MemorySource = { id: string; title: string; text: string; url?: string; fingerprint?: string };
export type MemoryDocument = { content: string; revision: string; sources: { id: string; title: string; url?: string; fingerprint?: string }[] };
export type MemoryConnection = { thread_id?: string | null; id: string; name: string; access: 'read' | 'write'; created_at: string };
export type MemoryMatch = { text: string; line: number };
export type ChannelMemory = {
  enabled: boolean; provider: string; can_manage: boolean;
  providers: { id: string; name: string }[]; document: MemoryDocument | null;
};
export function memoryContent(input: unknown): string {
  if (typeof input !== 'string' || input.length > MAX_MEMORY_CHARS || input.includes('\0')) throw new AppError(400, 'invalid_memory_content');
  return input;
}
export function memorySourceId(input: unknown): string {
  const value = text(input, 64), [kind, id] = value.split(':');
  if (!['message', 'document', 'knowledge'].includes(kind!) || value !== `${kind}:${uuid(id)}`) throw new AppError(400, 'invalid_memory_source');
  return value;
}
export function parseMemoryConnection(input: unknown): { name: string; access: 'read' | 'write' } {
  const v = record(input, ['name', 'access']);
  if (v.access !== 'read' && v.access !== 'write') throw new AppError(400, 'invalid_memory_access');
  return { name: text(v.name, 100).trim(), access: v.access };
}
export function parseMemoryWrite(input: unknown) {
  const v = record(input, ['content', 'revision']);
  if (typeof v.revision !== 'string' || !/^[a-f0-9]{64}$/.test(v.revision)) throw new AppError(400, 'invalid_memory_revision');
  return { content: memoryContent(v.content), revision: v.revision };
}
export function parseMemorySettings(input: unknown) {
  const v = record(input, ['enabled', 'provider']);
  if (typeof v.enabled !== 'boolean') throw new AppError(400, 'invalid_memory_settings');
  const provider = v.provider === undefined ? undefined : text(v.provider, 64);
  if (provider && !/^[a-z][a-z0-9-]*$/.test(provider)) throw new AppError(400, 'invalid_memory_provider');
  return { enabled: v.enabled, provider };
}
export function parseMemorySource(input: unknown): { message_id: string } | { source_id: string; name: string; content: string } {
  const v = record(input, ['message_id', 'source_id', 'name', 'content']);
  if (v.message_id !== undefined) {
    if (Object.keys(v).length !== 1) throw new AppError(400, 'invalid_memory_source');
    return { message_id: uuid(v.message_id) };
  }
  const name = text(v.name, 255);
  if (!/\.(md|txt|markdown)$/i.test(name) || /[\r\n\u0000-\u001f]/.test(name)) throw new AppError(400, 'invalid_memory_document');
  const content = text(v.content, MAX_MEMORY_IMPORT_BYTES);
  return { source_id: uuid(v.source_id), name, content };
}
