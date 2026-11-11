import { AppError, record, text, uuid } from './validation.js';
import { SUMMARY_LIMIT, parseThreadContextMessage, type ThreadContext, type ThreadContextMessage } from './thread-context.js';

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
export interface MemoryFact { id: string; kind: 'fact' | 'decision' | 'procedure' | 'answer'; text: string; topic: string | null; message_ids: string[] }
export interface ThreadMemory { node: MemoryNode; context: ThreadContext; sessions: MemoryNode[]; related: ThreadContextMessage[]; topics: string[]; facts: MemoryFact[] }
export interface SessionMemory { node: MemoryNode; messages: ThreadContextMessage[]; related: ThreadContextMessage[] }
export interface ChannelCursor { as_of: string; created_at: string; thread_id: string }

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
  const s = record(value, ['node', 'messages', 'related']);
  if (!Array.isArray(s.messages) || s.messages.length > 16 || !Array.isArray(s.related) || s.related.length > 16) throw new AppError(400, 'invalid_session_memory');
  return { node: parseNode(s.node), messages: s.messages.map(parseThreadContextMessage), related: s.related.map(parseThreadContextMessage) };
}
