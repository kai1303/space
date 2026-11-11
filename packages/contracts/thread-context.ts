import { AppError, record, text, uuid } from './validation.js';
import { chatCursor } from './chat.js';
import type { AssetAttachment } from './assets.js';

export interface ThreadContextMessage {
  id: string;
  sequence: string;
  text: string;
  text_truncated: boolean;
  author: { id: string; kind: 'human' | 'agent' | 'app' | 'workflow' };
  attachments: AssetAttachment[];
}
export interface MemoryRecord {
  revision: number;
  through_sequence: string;
  content: string;
  summary: string;
  source_message_ids: string[];
  producer_id: string;
  producer_name: string;
  created_at: string;
}
export interface ThreadContext {
  thread_id: string;
  through_sequence: string;
  root: ThreadContextMessage | null;
  messages: ThreadContextMessage[];
  memory: MemoryRecord | null;
  has_earlier_messages: boolean;
}
export interface MemoryInput {
  revision: number;
  through_sequence: string;
  content: string;
  summary: string;
  source_message_ids: string[];
}
export const MEMORY_LIMIT = 6000;
export const SUMMARY_LIMIT = 280;

export function parseMemoryInput(value: unknown): MemoryInput {
  const v = record(value, ['revision', 'through_sequence', 'content', 'summary', 'source_message_ids']);
  if (!Number.isSafeInteger(v.revision) || (v.revision as number) < 0 || !Array.isArray(v.source_message_ids) || v.source_message_ids.length < 1 || v.source_message_ids.length > 32) throw new AppError(400, 'invalid_thread_memory');
  if (typeof v.content === 'string' && v.content.trim().length > MEMORY_LIMIT) throw new AppError(413, 'memory_content_too_large');
  if (typeof v.summary !== 'string' || !v.summary.trim() || v.summary.trim().length > SUMMARY_LIMIT || v.summary.includes('\0')) throw new AppError(400, 'invalid_summary');
  return { revision: v.revision as number, through_sequence: chatCursor(v.through_sequence), content: text(v.content, MEMORY_LIMIT), summary: v.summary.trim(), source_message_ids: [...new Set(v.source_message_ids.map(uuid))] };
}

export function parseThreadContextMessage(value: unknown): ThreadContextMessage {
  const m = record(value, ['id', 'sequence', 'text', 'text_truncated', 'author', 'attachments']);
  const author = record(m.author, ['id', 'kind']);
  if (!['human', 'agent', 'app', 'workflow'].includes(author.kind as string) || typeof m.text !== 'string' || m.text.length > 1000 || m.text.includes('\0') || typeof m.text_truncated !== 'boolean' || !Array.isArray(m.attachments) || m.attachments.length > 20) throw new AppError(400, 'invalid_thread_message');
  const attachments = m.attachments.map(raw => {
    const a = record(raw, ['id', 'name', 'size', 'type']);
    if (!Number.isSafeInteger(a.size) || (a.size as number) < 0) throw new AppError(400, 'invalid_attachment');
    return { id: uuid(a.id), name: text(a.name, 255), size: a.size as number, type: text(a.type, 255) };
  });
  return { id: uuid(m.id), sequence: chatCursor(m.sequence), text: m.text, text_truncated: m.text_truncated, author: { id: uuid(author.id), kind: author.kind as ThreadContextMessage['author']['kind'] }, attachments };
}

export function parseThreadContext(value: unknown): ThreadContext {
  const v = record(value, ['thread_id', 'through_sequence', 'root', 'messages', 'memory', 'has_earlier_messages']);
  const through = chatCursor(v.through_sequence);
  const parseMessage = (value: unknown): ThreadContextMessage => {
    const parsed = parseThreadContextMessage(value);
    if (BigInt(parsed.sequence) > BigInt(through)) throw new AppError(400, 'invalid_thread_sequence');
    return parsed;
  };
  if (!Array.isArray(v.messages) || v.messages.length > 16 || typeof v.has_earlier_messages !== 'boolean') throw new AppError(400, 'invalid_thread_context');
  let memory: MemoryRecord | null = null;
  if (v.memory !== null) {
    const p = record(v.memory, ['revision', 'through_sequence', 'content', 'summary', 'source_message_ids', 'producer_id', 'producer_name', 'created_at']);
    const parsed = parseMemoryInput({ revision: p.revision, through_sequence: p.through_sequence, content: p.content, summary: p.summary, source_message_ids: p.source_message_ids });
    if (parsed.revision < 1 || BigInt(parsed.through_sequence) > BigInt(through) || typeof p.created_at !== 'string' || !Number.isFinite(Date.parse(p.created_at))) throw new AppError(400, 'invalid_thread_memory');
    memory = { ...parsed, producer_id: uuid(p.producer_id), producer_name: text(p.producer_name, 100), created_at: p.created_at };
  }
  return { thread_id: uuid(v.thread_id), through_sequence: through, root: v.root === null ? null : parseMessage(v.root), messages: v.messages.map(parseMessage), memory, has_earlier_messages: v.has_earlier_messages };
}
