import { AppError, record } from './validation.js';
import { CHECKPOINT_LIMIT, SUMMARY_LIMIT } from './thread-context.js';
import { parseBlockNotes, type NoteDraft } from './knowledge-notes.js';

export interface AgentMemoryPart { base_revision: number; summary: string; content: string }
export interface AgentMemoryUpdate { session?: AgentMemoryPart; thread?: AgentMemoryPart; notes?: NoteDraft[] }

const OPEN = '<space-memory>', CLOSE = '</space-memory>';

function parsePart(value: unknown): AgentMemoryPart {
  const p = record(value, ['base_revision', 'summary', 'content']);
  if (!Number.isSafeInteger(p.base_revision) || (p.base_revision as number) < 0) throw new AppError(400, 'invalid_memory_update');
  if (typeof p.summary !== 'string' || !p.summary.trim() || p.summary.trim().length > SUMMARY_LIMIT) throw new AppError(400, 'invalid_memory_update');
  if (typeof p.content !== 'string' || !p.content.trim() || p.content.trim().length > CHECKPOINT_LIMIT || p.content.includes('\0')) throw new AppError(400, 'invalid_memory_update');
  return { base_revision: p.base_revision as number, summary: p.summary.trim(), content: p.content.trim() };
}
export function parseAgentMemoryUpdate(value: unknown): AgentMemoryUpdate {
  const v = record(value, ['session', 'thread', 'notes']);
  let notes: NoteDraft[] = [];
  // A bad notes list never costs the checkpoints.
  if (v.notes !== undefined) { try { notes = parseBlockNotes(v.notes); } catch { notes = []; } }
  if (v.session === undefined && v.thread === undefined && !notes.length) throw new AppError(400, 'invalid_memory_update');
  return { ...(v.session === undefined ? {} : { session: parsePart(v.session) }), ...(v.thread === undefined ? {} : { thread: parsePart(v.thread) }), ...(notes.length ? { notes } : {}) };
}

// While streaming, also hold back a trailing partial "<space-memory" so it never flashes on screen.
export function visibleText(raw: string, final: boolean): string {
  const at = raw.indexOf(OPEN);
  if (at >= 0) return raw.slice(0, at).trimEnd();
  if (!final) for (let k = Math.min(OPEN.length - 1, raw.length); k > 0; k--) if (OPEN.startsWith(raw.slice(-k))) return raw.slice(0, -k);
  return raw;
}
export function extractMemoryBlock(raw: string): AgentMemoryUpdate | undefined {
  const start = raw.indexOf(OPEN), end = start < 0 ? -1 : raw.indexOf(CLOSE, start);
  if (start < 0 || end < 0) return undefined;
  try { return parseAgentMemoryUpdate(JSON.parse(raw.slice(start + OPEN.length, end))); } catch { return undefined; }
}
