import { AppError, record, text, uuid } from './validation.js';
import { chatCursor } from './chat.js';
import type { AssetAttachment } from './assets.js';

export interface ThreadContextMessage {
  id: string;
  sequence: string;
  text: string;
  text_truncated: boolean;
  author: { id: string; kind: 'human' | 'agent' };
  attachments: AssetAttachment[];
}
export interface ThreadCheckpoint {
  revision: number;
  through_sequence: string;
  content: string;
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
  checkpoint: ThreadCheckpoint | null;
  has_earlier_messages: boolean;
}
export interface ThreadCheckpointInput {
  revision: number;
  through_sequence: string;
  content: string;
  source_message_ids: string[];
}
export function parseThreadCheckpoint(value: unknown): ThreadCheckpointInput {
  const v = record(value, ['revision', 'through_sequence', 'content', 'source_message_ids']);
  if (!Number.isSafeInteger(v.revision) || (v.revision as number) < 0 || !Array.isArray(v.source_message_ids) || v.source_message_ids.length < 1 || v.source_message_ids.length > 32) throw new AppError(400, 'invalid_thread_checkpoint');
  return { revision: v.revision as number, through_sequence: chatCursor(v.through_sequence), content: text(v.content, 6000), source_message_ids: [...new Set(v.source_message_ids.map(uuid))] };
}

export function parseThreadContext(value: unknown): ThreadContext {
  const v = record(value, ['thread_id', 'through_sequence', 'root', 'messages', 'checkpoint', 'has_earlier_messages']);
  const through = chatCursor(v.through_sequence);
  const parseMessage = (value: unknown): ThreadContextMessage => {
    const m = record(value, ['id', 'sequence', 'text', 'text_truncated', 'author', 'attachments']);
    const author = record(m.author, ['id', 'kind']);
    if (!['human', 'agent'].includes(author.kind as string) || typeof m.text !== 'string' || m.text.length > 1000 || m.text.includes('\0') || typeof m.text_truncated !== 'boolean' || !Array.isArray(m.attachments) || m.attachments.length > 20) throw new AppError(400, 'invalid_thread_message');
    const sequence = chatCursor(m.sequence);
    if (BigInt(sequence) > BigInt(through)) throw new AppError(400, 'invalid_thread_sequence');
    const attachments = m.attachments.map(raw => {
      const a = record(raw, ['id', 'name', 'size', 'type']);
      if (!Number.isSafeInteger(a.size) || (a.size as number) < 0) throw new AppError(400, 'invalid_attachment');
      return { id: uuid(a.id), name: text(a.name, 255), size: a.size as number, type: text(a.type, 255) };
    });
    return { id: uuid(m.id), sequence, text: m.text, text_truncated: m.text_truncated, author: { id: uuid(author.id), kind: author.kind as 'human' | 'agent' }, attachments };
  };
  if (!Array.isArray(v.messages) || v.messages.length > 16 || typeof v.has_earlier_messages !== 'boolean') throw new AppError(400, 'invalid_thread_context');
  let checkpoint: ThreadCheckpoint | null = null;
  if (v.checkpoint !== null) {
    const p = record(v.checkpoint, ['revision', 'through_sequence', 'content', 'source_message_ids', 'producer_id', 'producer_name', 'created_at']);
    const parsed = parseThreadCheckpoint({ revision: p.revision, through_sequence: p.through_sequence, content: p.content, source_message_ids: p.source_message_ids });
    if (parsed.revision < 1 || BigInt(parsed.through_sequence) > BigInt(through) || typeof p.created_at !== 'string' || !Number.isFinite(Date.parse(p.created_at))) throw new AppError(400, 'invalid_thread_checkpoint');
    checkpoint = { ...parsed, producer_id: uuid(p.producer_id), producer_name: text(p.producer_name, 100), created_at: p.created_at };
  }
  return { thread_id: uuid(v.thread_id), through_sequence: through, root: v.root === null ? null : parseMessage(v.root), messages: v.messages.map(parseMessage), checkpoint, has_earlier_messages: v.has_earlier_messages };
}
