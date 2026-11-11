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
export interface ThreadContext {
  thread_id: string;
  through_sequence: string;
  root: ThreadContextMessage | null;
  messages: ThreadContextMessage[];
  has_earlier_messages: boolean;
}
export const SUMMARY_LIMIT = 280;

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
  const v = record(value, ['thread_id', 'through_sequence', 'root', 'messages', 'has_earlier_messages']);
  const through = chatCursor(v.through_sequence);
  const parseMessage = (value: unknown): ThreadContextMessage => {
    const parsed = parseThreadContextMessage(value);
    if (BigInt(parsed.sequence) > BigInt(through)) throw new AppError(400, 'invalid_thread_sequence');
    return parsed;
  };
  if (!Array.isArray(v.messages) || v.messages.length > 16 || typeof v.has_earlier_messages !== 'boolean') throw new AppError(400, 'invalid_thread_context');
  return { thread_id: uuid(v.thread_id), through_sequence: through, root: v.root === null ? null : parseMessage(v.root), messages: v.messages.map(parseMessage), has_earlier_messages: v.has_earlier_messages };
}
