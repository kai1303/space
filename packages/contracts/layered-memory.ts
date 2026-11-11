import { AppError, record, text, uuid } from './validation.js';
import { MEMORY_LIMIT, SUMMARY_LIMIT, parseMemoryInput, parseThreadContextMessage, type MemoryRecord, type ThreadContext, type ThreadContextMessage } from './thread-context.js';

export type MemoryNodeKind = 'channel' | 'thread' | 'session';
export interface MemoryRef { kind: MemoryNodeKind; id: string }
export interface MemoryNode {
  ref: MemoryRef;
  parent: MemoryRef | null;
  summary: string;
  updated_at: string;
  children: { kind: 'thread' | 'session'; count: number } | null;
  title?: string;
  agent?: string;
  state?: 'active' | 'ended';
}
export interface ChannelMemoryPage { channel_id: string; nodes: MemoryNode[]; next_cursor: string | null }
export interface ThreadMemory { node: MemoryNode; context: ThreadContext; sessions: MemoryNode[]; memory_chars: number; limit: number }
export interface SessionMemory { node: MemoryNode; memory: MemoryRecord | null; messages: ThreadContextMessage[]; memory_chars: number; limit: number }
export interface ChannelCursor { as_of: string; created_at: string; thread_id: string }
export interface MemoryConflict { scope: 'session' | 'thread'; base_revision: number; current_revision: number; summary: string; content: string }

export const CHANNEL_MEMORY_DAYS = 7;
export const CHANNEL_PAGE_DEFAULT = 20;
export const CHANNEL_PAGE_MAX = 50;

// Contracts also run in the browser, so use btoa/atob instead of Node's Buffer.
const toBase64Url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = (s: string) => new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0)));

export function encodeChannelCursor(cursor: ChannelCursor): string {
  return toBase64Url(JSON.stringify(cursor));
}
export function parseChannelCursor(value: unknown): ChannelCursor {
  const invalid = () => new AppError(400, 'invalid_memory_cursor');
  if (typeof value !== 'string' || !value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  let raw: unknown;
  try { raw = JSON.parse(fromBase64Url(value)); } catch { throw invalid(); }
  if (!raw || typeof raw !== 'object') throw invalid();
  const { as_of, created_at, thread_id } = raw as Record<string, unknown>;
  if (typeof as_of !== 'string' || typeof created_at !== 'string' || !Number.isFinite(Date.parse(as_of)) || !Number.isFinite(Date.parse(created_at))) throw invalid();
  try { return { as_of, created_at, thread_id: uuid(thread_id) }; } catch { throw invalid(); }
}

function parseRef(value: unknown): MemoryRef {
  const r = record(value, ['kind', 'id']);
  if (r.kind !== 'channel' && r.kind !== 'thread' && r.kind !== 'session') throw new AppError(400, 'invalid_memory_node');
  return { kind: r.kind, id: uuid(r.id) };
}
function parseNode(value: unknown): MemoryNode {
  const n = record(value, ['ref', 'parent', 'summary', 'updated_at', 'children', 'title', 'agent', 'state']);
  if (typeof n.summary !== 'string' || n.summary.length > SUMMARY_LIMIT || typeof n.updated_at !== 'string') throw new AppError(400, 'invalid_memory_node');
  let children: MemoryNode['children'] = null;
  if (n.children !== null) {
    const ch = record(n.children, ['kind', 'count']);
    if ((ch.kind !== 'thread' && ch.kind !== 'session') || !Number.isSafeInteger(ch.count) || (ch.count as number) < 0) throw new AppError(400, 'invalid_memory_node');
    children = { kind: ch.kind, count: ch.count as number };
  }
  if (n.state !== undefined && n.state !== 'active' && n.state !== 'ended') throw new AppError(400, 'invalid_memory_node');
  return { ref: parseRef(n.ref), parent: n.parent === null ? null : parseRef(n.parent), summary: n.summary, updated_at: n.updated_at, children,
    ...(n.title === undefined ? {} : { title: text(n.title, 160) }), ...(n.agent === undefined ? {} : { agent: text(n.agent, 160) }), ...(n.state === undefined ? {} : { state: n.state as 'active' | 'ended' }) };
}
export function parseChannelMemoryPage(value: unknown): ChannelMemoryPage {
  const p = record(value, ['channel_id', 'nodes', 'next_cursor']);
  if (!Array.isArray(p.nodes) || p.nodes.length > CHANNEL_PAGE_MAX) throw new AppError(400, 'invalid_channel_memory');
  if (p.next_cursor !== null) parseChannelCursor(p.next_cursor);
  return { channel_id: uuid(p.channel_id), nodes: p.nodes.map(parseNode), next_cursor: p.next_cursor as string | null };
}
export function parseSessionMemory(value: unknown): SessionMemory {
  const s = record(value, ['node', 'memory', 'messages', 'memory_chars', 'limit']);
  if (!Array.isArray(s.messages) || s.messages.length > 16 || !Number.isSafeInteger(s.memory_chars) || s.limit !== MEMORY_LIMIT) throw new AppError(400, 'invalid_session_memory');
  let memory: MemoryRecord | null = null;
  if (s.memory !== null) {
    const p = record(s.memory, ['revision', 'through_sequence', 'content', 'summary', 'source_message_ids', 'producer_id', 'producer_name', 'created_at']);
    memory = { ...parseMemoryInput({ revision: p.revision, through_sequence: p.through_sequence, content: p.content, summary: p.summary, source_message_ids: p.source_message_ids }), producer_id: uuid(p.producer_id), producer_name: text(p.producer_name, 100), created_at: text(p.created_at, 64) };
  }
  return { node: parseNode(s.node), memory, messages: s.messages.map(parseThreadContextMessage), memory_chars: s.memory_chars as number, limit: MEMORY_LIMIT };
}
export function parseMemoryConflicts(value: unknown): MemoryConflict[] {
  if (!Array.isArray(value) || value.length > 2) throw new AppError(400, 'invalid_memory_conflicts');
  return value.map(raw => {
    const v = record(raw, ['scope', 'base_revision', 'current_revision', 'summary', 'content']);
    if ((v.scope !== 'session' && v.scope !== 'thread') || !Number.isSafeInteger(v.base_revision) || !Number.isSafeInteger(v.current_revision)) throw new AppError(400, 'invalid_memory_conflicts');
    return { scope: v.scope, base_revision: v.base_revision as number, current_revision: v.current_revision as number, summary: text(v.summary, SUMMARY_LIMIT), content: text(v.content, MEMORY_LIMIT) };
  });
}
