import { AppError, record, uuid } from './validation.js';

export const NOTE_KINDS = ['fact', 'decision', 'procedure', 'answer'] as const;
export type NoteKind = typeof NOTE_KINDS[number];
export const NOTE_TITLE_LIMIT = 160;
export const NOTE_CONTENT_LIMIT = 16_000;
export const BLOCK_NOTE_CONTENT_LIMIT = 2_000;
export const BLOCK_NOTES_MAX = 3;
export const NOTE_EVIDENCE_MAX = 20;
export const KNOWLEDGE_TITLES_MAX = 20;

export interface NoteDraft { kind: NoteKind; title: string; content: string; message_ids: string[] }
export interface NotePatch { kind?: NoteKind; title?: string; content?: string; message_ids?: string[] }
export interface KnowledgeNote { id: string; channel_id: string; kind: NoteKind; title: string; content: string; evidence: string[]; revision: number; producer_name: string; updated_at: string }
export interface KnowledgeNoteTitle { id: string; kind: NoteKind; title: string; revision: number; updated_at: string }
export interface KnowledgeNotesContext { channel_id: string; notes: KnowledgeNoteTitle[]; truncated: boolean }

function noteKind(value: unknown): NoteKind {
  if (!NOTE_KINDS.includes(value as NoteKind)) throw new AppError(400, 'invalid_note');
  return value as NoteKind;
}
function bounded(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new AppError(400, 'invalid_note');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new AppError(400, 'invalid_note');
  return trimmed;
}
function evidence(value: unknown, min: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > NOTE_EVIDENCE_MAX) throw new AppError(400, 'invalid_note');
  return [...new Set(value.map(id => uuid(id)))].sort();
}
export function parseNoteDraft(value: unknown, contentLimit = NOTE_CONTENT_LIMIT, minEvidence = 1): NoteDraft {
  const v = record(value, ['kind', 'title', 'content', 'message_ids']);
  return { kind: noteKind(v.kind), title: bounded(v.title, NOTE_TITLE_LIMIT), content: bounded(v.content, contentLimit), message_ids: evidence(v.message_ids ?? [], minEvidence) };
}
export function parseNotePatch(value: unknown): NotePatch {
  const v = record(value, ['kind', 'title', 'content', 'message_ids']);
  const patch: NotePatch = {};
  if (v.kind !== undefined) patch.kind = noteKind(v.kind);
  if (v.title !== undefined) patch.title = bounded(v.title, NOTE_TITLE_LIMIT);
  if (v.content !== undefined) patch.content = bounded(v.content, NOTE_CONTENT_LIMIT);
  if (v.message_ids !== undefined) patch.message_ids = evidence(v.message_ids, 1);
  if (!Object.keys(patch).length) throw new AppError(400, 'invalid_note');
  return patch;
}
// Turn-end notes: smaller content and optional evidence. A bad note is dropped on its own.
export function parseBlockNotes(value: unknown): NoteDraft[] {
  if (!Array.isArray(value) || value.length > BLOCK_NOTES_MAX) throw new AppError(400, 'invalid_memory_update');
  return value.flatMap(raw => { try { return [parseNoteDraft(raw, BLOCK_NOTE_CONTENT_LIMIT, 0)]; } catch { return []; } });
}
export function parseKnowledgeNotesContext(value: unknown): KnowledgeNotesContext {
  const v = record(value, ['channel_id', 'notes', 'truncated']);
  if (!Array.isArray(v.notes) || v.notes.length > KNOWLEDGE_TITLES_MAX || typeof v.truncated !== 'boolean') throw new AppError(400, 'invalid_knowledge_notes');
  return { channel_id: uuid(v.channel_id), truncated: v.truncated, notes: v.notes.map(raw => {
    const n = record(raw, ['id', 'kind', 'title', 'revision', 'updated_at']);
    if (!Number.isSafeInteger(n.revision) || (n.revision as number) < 1 || typeof n.updated_at !== 'string' || n.updated_at.length > 64) throw new AppError(400, 'invalid_knowledge_notes');
    return { id: uuid(n.id), kind: noteKind(n.kind), title: bounded(n.title, NOTE_TITLE_LIMIT), revision: n.revision as number, updated_at: n.updated_at };
  }) };
}
