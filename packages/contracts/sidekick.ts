import { AppError, record, text, uuid } from './validation.js';
import type { AgentSessionSummary } from './agent-sessions.js';

export type SidekickSource = { channel_id: string; message_ids: string[]; thread_id?: never } | { channel_id: string; thread_id: string; message_ids?: never };
export interface SidekickContext {
  channel_id: string; channel_name: string; thread_id?: string; captured_at: string;
  messages: { id: string; thread_id: string; author: string; text: string; created_at: string; files: string[] }[];
}
export interface SidekickSession extends AgentSessionSummary { channel_id: string }
export interface SidekickAgent { id: string; name: string; owner_id: string; enabled: boolean; capabilities: import('./index.js').AgentCapabilities }
export function parseSidekickInput(value: unknown) {
  const v = record(value, ['client_session_id', 'installation_id', 'skill', 'source']);
  const source = record(v.source, ['channel_id', 'thread_id', 'message_ids']);
  if ((source.thread_id === undefined) === (source.message_ids === undefined)) throw new AppError(400, 'invalid_sidekick_source');
  let selected: SidekickSource;
  const channel_id = uuid(source.channel_id);
  if (source.thread_id !== undefined) selected = { channel_id, thread_id: uuid(source.thread_id) };
  else {
    if (!Array.isArray(source.message_ids) || !source.message_ids.length || source.message_ids.length > 50) throw new AppError(400, 'invalid_sidekick_source');
    selected = { channel_id, message_ids: [...new Set(source.message_ids.map(uuid))].sort() };
  }
  return { client_session_id: uuid(v.client_session_id), installation_id: uuid(v.installation_id), skill: text(v.skill, 80), source: selected };
}
export function parseSidekickContext(value: unknown): SidekickContext {
  const v = record(value, ['channel_id', 'channel_name', 'thread_id', 'captured_at', 'messages']);
  if (!Array.isArray(v.messages) || !v.messages.length || v.messages.length > 50 || new TextEncoder().encode(JSON.stringify(v)).length > 24000) throw new AppError(400, 'sidekick_context_too_large');
  const date = (value: unknown) => { const result = text(value, 40); if (!Number.isFinite(Date.parse(result))) throw new AppError(400, 'invalid_date'); return result; };
  return { channel_id: uuid(v.channel_id), channel_name: text(v.channel_name, 160), ...(v.thread_id === undefined ? {} : { thread_id: uuid(v.thread_id) }), captured_at: date(v.captured_at), messages: v.messages.map(raw => {
    const m = record(raw, ['id', 'thread_id', 'author', 'text', 'created_at', 'files']);
    if (typeof m.text !== 'string' || m.text.length > 40000 || m.text.includes('\0') || !Array.isArray(m.files) || m.files.length > 20) throw new AppError(400, 'invalid_sidekick_message');
    return { id: uuid(m.id), thread_id: uuid(m.thread_id), author: text(m.author, 160), text: m.text, created_at: date(m.created_at), files: m.files.map(name => text(name, 255)) };
  }) };
}
