import { AppError, record } from './validation.js';
import { parseBlockNotes, type NoteDraft } from './knowledge-notes.js';

// Memory is built from messages by the Graph RAG store, so agents no longer write it. The block carries
// only Knowledge items that an agent chooses to save.
export interface AgentMemoryUpdate { notes?: NoteDraft[] }

const OPEN = '<space-memory>', CLOSE = '</space-memory>';

export function parseAgentMemoryUpdate(value: unknown): AgentMemoryUpdate {
  const v = record(value, ['notes', 'session', 'thread']);   // old blocks may still carry the retired parts
  let notes: NoteDraft[] = [];
  if (v.notes !== undefined) { try { notes = parseBlockNotes(v.notes); } catch { notes = []; } }
  if (!notes.length) throw new AppError(400, 'invalid_memory_update');
  return { notes };
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
