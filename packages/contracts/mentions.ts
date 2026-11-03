import { AppError, record, text, uuid } from './validation.js';
import type { RichDocument } from './rich-text.js';
export type MentionReference = { kind: 'user' | 'agent' | 'broadcast'; id: string; label: string };
export type MentionOption = MentionReference & { detail: string; image?: string | null; joined?: boolean };
export type MentionNotification = { id: string; channel_id: string; channel_name: string; message_id: string; thread_id: string; text: string; author_name: string; created_at: string; read_at: string | null; silent: boolean };
export type MentionActivity = { items: MentionNotification[]; unread_count: number; next_cursor: string | null };
export type MentionSettings = { paused_until: string | null; broadcast_permission: 'all' | 'admins'; can_manage: boolean; general_channel_id: string | null; member_count: number };
export function parseMention(input: unknown): MentionReference {
  const value = record(input, ['kind', 'id', 'label']);
  if (!['user', 'agent', 'broadcast'].includes(String(value.kind))) throw new AppError(400, 'invalid_mention');
  const label = text(value.label, 100).trim();
  if (/[\n\r\t]/.test(label)) throw new AppError(400, 'invalid_mention');
  const id = value.kind === 'broadcast' ? text(value.id, 10) : uuid(value.id);
  if (value.kind === 'broadcast' && (!['here', 'channel', 'everyone'].includes(id) || label !== id)) throw new AppError(400, 'invalid_mention');
  return { kind: value.kind as MentionReference['kind'], id, label };
}
// Block formats belong to newline ops, which can follow the reference in a separate op.
export function mentionOperations(document: RichDocument): { index: number; reference: MentionReference }[] {
  const blocked = new Set<number>(); let line = 0;
  for (const op of document.ops) for (const char of op.insert) if (char === '\n') { if (op.attributes?.['code-block'] || op.attributes?.blockquote) blocked.add(line); line++; }
  line = 0; const result: { index: number; reference: MentionReference }[] = [];
  for (const [index, op] of document.ops.entries()) {
    const a = op.attributes, mention = a?.mention;
    if (mention && !blocked.has(line) && !a.code && !a.link && !a.blockquote && !a['code-block']) result.push({index,reference:mention});
    line += op.insert.split('\n').length - 1;
  }
  return result;
}
export function documentMentions(document: RichDocument): MentionReference[] {
  return [...new Map(mentionOperations(document).map(({reference})=>[`${reference.kind}:${reference.id}`,reference])).values()];
}
