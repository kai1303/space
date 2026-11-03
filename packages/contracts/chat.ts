import { isUnicodeEmoji } from './emoji.js';
import { AppError, record, text, uuid } from './validation.js';
import { parseRichDocument, type RichDocument } from './rich-text.js';
import { parseAssetIds, type AssetAttachment } from './assets.js';
import type { AgentResponse } from './agent-response.js';
export interface MessageReaction { emoji: string; count: number; user_ids: string[] }
export interface ChatMessage {
  reactions?: MessageReaction[];
  reaction_sequence?: string;
  id: string; channel_id: string; thread_id: string; task_id: string | null;
  text: string; created_at: string; client_message_id: string | null;
  // Older immutable replay payloads omit this; their event sequence is identical.
  sequence?: string;
  thread_root_id?: string;
  reply_count?: number;
  document?: RichDocument | null;
  agent_response?: AgentResponse | null;
  attachments?: AssetAttachment[];
  author: { kind: 'human' | 'agent'; id: string; name: string };
}
export interface ChatTaskEvent {
  task_id: string; type: string; actor_id: string; installation_id: string; owner_id: string; data: Record<string, unknown>;
}
export type ChatEvent = { channel_id: string; thread_id: string; sequence: string; occurred_at: string } & (
  { type: 'message.created'; payload: ChatMessage } | { type: 'message.updated'; payload: ChatMessage } | { type: 'task.event'; payload: ChatTaskEvent }
);
export interface ChatHistory { events: ChatEvent[]; cursor: string; oldest_cursor: string; has_more: boolean }
export interface ChannelUnread {
  channel_id: string; last_read_sequence: string; latest_sequence: string; unread_count: number;
}
export interface WorkspaceUnread { workspace_id: string; channels: ChannelUnread[] }
export interface MessagePage {
  messages: ChatMessage[]; older_cursor: string | null; newer_cursor: string | null;
  has_older: boolean; has_newer: boolean; event_cursor: string;
}
export function parseMessagePage(input: unknown = {}) {
  const v = record(input, ['before', 'after', 'limit']);
  if (v.before !== undefined && v.after !== undefined) throw new AppError(400, 'invalid_cursor');
  const before = v.before === undefined ? undefined : chatCursor(v.before);
  const after = v.after === undefined ? undefined : chatCursor(v.after);
  const limit = v.limit === undefined ? 50 : typeof v.limit === 'string' && /^[1-9]\d{0,2}$/.test(v.limit) ? Number(v.limit) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError(400, 'invalid_limit');
  return { before, after, limit };
}
export function chatCursor(value: unknown = '0'): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n) throw new AppError(400, 'invalid_cursor');
  return value;
}
export function parseMessageInput(input: unknown) {
  const v = record(input, ['client_message_id', 'thread_id', 'text', 'document', 'asset_ids', 'broadcast_confirmed']);
  if (v.broadcast_confirmed !== undefined && typeof v.broadcast_confirmed !== 'boolean') throw new AppError(400, 'invalid_confirmation');
  const asset_ids = v.asset_ids === undefined ? undefined : parseAssetIds(v.asset_ids);
  const plain = asset_ids?.length && typeof v.text === 'string' && !v.text.trim() ? '' : text(v.text, 16000).trim();
  if (typeof v.text !== 'string' || v.text.length > 16000 || v.text.includes('\0')) throw new AppError(400, 'invalid_text');
  const document = v.document === undefined ? undefined : parseRichDocument(v.document);
  if (document && document.ops.map(op => op.insert).join('').trim() !== plain) throw new AppError(400, 'document_text_mismatch');
  return { ...(v.broadcast_confirmed === true ? { broadcast_confirmed: true } : {}), client_message_id: uuid(v.client_message_id), text: plain, thread_id: v.thread_id === undefined ? null : uuid(v.thread_id), ...(document ? { document } : {}), ...(asset_ids ? { asset_ids } : {}) };
}
export function parseChannelInput(input: unknown) {
  const v = record(input, ['name', 'private']);
  if (typeof v.private !== 'boolean') throw new AppError(400, 'invalid_visibility');
  return { name: text(v.name, 80).trim(), private: v.private };
}

export interface ChannelSummary {
  id: string; workspace_id: string; name: string; private: boolean; joined: boolean;
  topic: string; description: string; archived_at: string | null; created_by: string | null; created_at: string;
}
export interface ChannelDetails extends ChannelSummary {
  creator_name: string | null; member_count: number; can_manage: boolean;
}
export interface ChannelMember { id: string; name: string; image: string | null; title: string; presence: 'active' | 'away' }
export function parseChannelUpdate(input: unknown) {
  const v = record(input, ['name', 'topic', 'description', 'archived']);
  if (!Object.keys(v).length) throw new AppError(400, 'empty_update');
  const result: { name?: string; topic?: string; description?: string; archived?: boolean } = {};
  if (v.name !== undefined) result.name = text(v.name, 80).trim();
  for (const [key, max] of [['topic', 250], ['description', 2000]] as const) if (key in v) {
    const value = v[key];
    if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new AppError(400, 'invalid_text');
    result[key] = value.trim();
  }
  if ('archived' in v) {
    if (typeof v.archived !== 'boolean' || Object.keys(v).length !== 1) throw new AppError(400, 'invalid_archive_update');
    result.archived = v.archived;
  }
  return result;
}

export function parseReactionInput(input: unknown) {
  const v = record(input, ['emoji', 'active']);
  if (!isUnicodeEmoji(v.emoji) || typeof v.active !== 'boolean') throw new AppError(400, 'invalid_reaction');
  return { emoji: v.emoji, active: v.active };
}
