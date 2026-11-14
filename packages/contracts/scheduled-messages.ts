import { AppError, record, uuid } from './validation.js';
import { parseMessageInput } from './chat.js';
import type { AssetAttachment } from './assets.js';
import type { RichDocument } from './rich-text.js';

export const SCHEDULE_MIN_LEAD_MS = 60_000;
export const SCHEDULE_MAX_LEAD_MS = 120 * 24 * 60 * 60_000;
export const MAX_PENDING_SCHEDULED = 100;

export type ScheduledMessageStatus = 'pending' | 'sending' | 'sent' | 'cancelled' | 'failed';
export interface ScheduledMessage {
  id: string; workspace_id: string; channel_id: string; channel_name: string; thread_id: string | null;
  also_send_to_channel?: boolean; text: string; document: RichDocument | null; attachments: Pick<AssetAttachment, 'id' | 'name' | 'size' | 'type'>[];
  send_at: string; status: ScheduledMessageStatus; message_id: string | null; error: string | null; created_at: string;
}

function sendAt(value: unknown, now: number): string {
  if (typeof value !== 'string' || value.length > 40) throw new AppError(400, 'invalid_send_at');
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw new AppError(400, 'invalid_send_at');
  if (at < now + SCHEDULE_MIN_LEAD_MS - 5_000 || at > now + SCHEDULE_MAX_LEAD_MS) throw new AppError(400, 'send_at_out_of_range');
  return new Date(at).toISOString();
}

// The schedule id doubles as the message's client_message_id, so a repeated delivery sends at most once.
export function parseScheduledMessageInput(input: unknown, now = Date.now()) {
  const v = record(input, ['id', 'thread_id', 'text', 'document', 'asset_ids', 'asset_descriptions', 'send_at', 'also_send_to_channel']);
  const id = uuid(v.id);
  const message = parseMessageInput({ client_message_id: id, text: v.text, also_send_to_channel: v.also_send_to_channel, ...(v.thread_id !== undefined ? { thread_id: v.thread_id } : {}),
    ...(v.document !== undefined ? { document: v.document } : {}), ...(v.asset_ids !== undefined ? { asset_ids: v.asset_ids } : {}),
    ...(v.asset_descriptions !== undefined ? { asset_descriptions: v.asset_descriptions } : {}) });
  if (!message.text && !message.asset_ids?.length) throw new AppError(400, 'invalid_text');
  return { id, send_at: sendAt(v.send_at, now), message };
}

export function parseScheduledMessageUpdate(input: unknown, now = Date.now()) {
  const v = record(input, ['send_at']);
  return { send_at: sendAt(v.send_at, now) };
}
