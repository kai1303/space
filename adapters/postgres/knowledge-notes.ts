import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { AppError, KNOWLEDGE_TITLES_MAX, type KnowledgeNote, type KnowledgeNotesContext, type NoteDraft, type NotePatch } from '@space/contracts';
import type { DbSession } from './database.js';
import { rows } from './thread-context.js';
import { agentMemoryAccess } from './memory.js';

export type NoteProducer = { id: string; name: string };
export type NoteScope = { workspaceId: string; channelId: string };
const noteColumns = sql.raw('id, channel_id, kind, title, content, evidence, revision, producer_name, updated_at::text AS updated_at');
const pgCode = (error: unknown) => { const f = error as { code?: string; cause?: { code?: string } }; return f.cause?.code ?? f.code; };

// Every evidence message must be a live message in this channel.
export async function assertNoteEvidence(c: DbSession, channelId: string, ids: string[]) {
  if (!ids.length) throw new AppError(400, 'foreign_evidence');
  const found = await rows<{ id: string }>(c, sql`SELECT id FROM messages WHERE channel_id=${channelId} AND id = ANY(${sql.param(ids)}::uuid[]) AND deleted_at IS NULL`);
  if (found.length !== ids.length) throw new AppError(400, 'foreign_evidence');
}

// Turn-end path: same title in the channel becomes a new revision. One statement, no explicit lock.
// The unique index knowledge_notes_live_title is the ON CONFLICT arbiter.
export async function saveNoteByTitle(c: DbSession, scope: NoteScope, draft: NoteDraft, producer: NoteProducer): Promise<'saved' | 'unchanged'> {
  const saved = await rows<{ id: string }>(c, sql`
    WITH saved AS (
      INSERT INTO knowledge_notes (id, workspace_id, channel_id, kind, title, content, evidence, producer_id, producer_name)
      VALUES (gen_random_uuid(), ${scope.workspaceId}, ${scope.channelId}, ${draft.kind}, ${draft.title}, ${draft.content}, ${sql.param(draft.message_ids)}::uuid[], ${producer.id}, ${producer.name})
      ON CONFLICT (channel_id, title_key) WHERE removed_at IS NULL DO UPDATE SET
        kind = EXCLUDED.kind, title = EXCLUDED.title, content = EXCLUDED.content, evidence = EXCLUDED.evidence,
        producer_id = EXCLUDED.producer_id, producer_name = EXCLUDED.producer_name, fingerprint = NULL,
        revision = knowledge_notes.revision + 1, updated_at = now()
      WHERE (knowledge_notes.kind, knowledge_notes.content, knowledge_notes.evidence)
        IS DISTINCT FROM (EXCLUDED.kind, EXCLUDED.content, EXCLUDED.evidence)
      RETURNING *
    )
    INSERT INTO knowledge_note_revisions (note_id, revision, kind, title, content, evidence, producer_id, producer_name)
    SELECT id, revision, kind, title, content, evidence, producer_id, producer_name FROM saved
    RETURNING note_id AS id`);
  return saved.length ? 'saved' : 'unchanged';
}

export function noteFingerprint(draft: NoteDraft, producerId: string) {
  return createHash('sha256').update(JSON.stringify({ kind: draft.kind, title: draft.title, content: draft.content, message_ids: draft.message_ids, producer: producerId })).digest('hex');
}
async function noteRow(c: DbSession, id: string) {
  const [row] = await rows<KnowledgeNote & { fingerprint: string | null; removed: boolean }>(c, sql`SELECT ${noteColumns}, fingerprint, removed_at IS NOT NULL AS removed FROM knowledge_notes WHERE id=${id}`);
  return row;
}
const publicNote = ({ fingerprint: _f, removed: _r, ...note }: KnowledgeNote & { fingerprint?: string | null; removed?: boolean }): KnowledgeNote => note;

// MCP path: caller-chosen id. Same id plus same input is a retry; a used title is refused.
export async function addNote(c: DbSession, scope: NoteScope, id: string, draft: NoteDraft, producer: NoteProducer): Promise<KnowledgeNote> {
  await assertNoteEvidence(c, scope.channelId, draft.message_ids);
  const fingerprint = noteFingerprint(draft, producer.id);
  const existing = await noteRow(c, id);
  if (existing) {
    if (existing.channel_id !== scope.channelId || existing.fingerprint !== fingerprint) throw new AppError(409, 'note_id_conflict');
    return publicNote(existing);
  }
  let saved: KnowledgeNote[];
  try {
    saved = await rows<KnowledgeNote>(c, sql`
      WITH saved AS (
        INSERT INTO knowledge_notes (id, workspace_id, channel_id, kind, title, content, evidence, producer_id, producer_name, fingerprint)
        VALUES (${id}, ${scope.workspaceId}, ${scope.channelId}, ${draft.kind}, ${draft.title}, ${draft.content}, ${sql.param(draft.message_ids)}::uuid[], ${producer.id}, ${producer.name}, ${fingerprint})
        ON CONFLICT (channel_id, title_key) WHERE removed_at IS NULL DO NOTHING
        RETURNING *
      ), logged AS (
        INSERT INTO knowledge_note_revisions (note_id, revision, kind, title, content, evidence, producer_id, producer_name)
        SELECT id, revision, kind, title, content, evidence, producer_id, producer_name FROM saved
      )
      SELECT ${noteColumns} FROM saved`);
  } catch (error) {
    // Two retries with the same id raced on the primary key: the second reads the first.
    if (pgCode(error) === '23505') return addNote(c, scope, id, draft, producer);
    throw error;
  }
  if (!saved[0]) throw new AppError(409, 'title_taken');
  return saved[0];
}

async function changed(c: DbSession, channelId: string, id: string, statement: Parameters<DbSession['execute']>[0]): Promise<KnowledgeNote> {
  let saved: KnowledgeNote[];
  try { saved = await rows<KnowledgeNote>(c, statement); }
  catch (error) { if (pgCode(error) === '23505') throw new AppError(409, 'title_taken'); throw error; }
  if (saved[0]) return saved[0];
  const current = await noteRow(c, id);
  if (!current || current.channel_id !== channelId || current.removed) throw new AppError(404, 'note_not_found');
  throw new AppError(409, 'note_conflict');
}

export async function updateNote(c: DbSession, channelId: string, id: string, revision: number, patch: NotePatch, producer: NoteProducer): Promise<KnowledgeNote> {
  if (patch.message_ids) await assertNoteEvidence(c, channelId, patch.message_ids);
  return changed(c, channelId, id, sql`
    WITH saved AS (
      UPDATE knowledge_notes SET kind = coalesce(${patch.kind ?? null}::text, kind), title = coalesce(${patch.title ?? null}::text, title),
        content = coalesce(${patch.content ?? null}::text, content), evidence = coalesce(${patch.message_ids ? sql.param(patch.message_ids) : null}::uuid[], evidence),
        producer_id = ${producer.id}, producer_name = ${producer.name}, fingerprint = NULL, revision = revision + 1, updated_at = now()
      WHERE id = ${id} AND channel_id = ${channelId} AND revision = ${revision} AND removed_at IS NULL
      RETURNING *
    ), logged AS (
      INSERT INTO knowledge_note_revisions (note_id, revision, kind, title, content, evidence, producer_id, producer_name)
      SELECT id, revision, kind, title, content, evidence, producer_id, producer_name FROM saved
    )
    SELECT ${noteColumns} FROM saved`);
}

export async function removeNote(c: DbSession, channelId: string, id: string, revision: number, producer: NoteProducer): Promise<KnowledgeNote> {
  return changed(c, channelId, id, sql`
    WITH saved AS (
      UPDATE knowledge_notes SET removed_at = now(), producer_id = ${producer.id}, producer_name = ${producer.name}, revision = revision + 1, updated_at = now()
      WHERE id = ${id} AND channel_id = ${channelId} AND revision = ${revision} AND removed_at IS NULL
      RETURNING *
    ), logged AS (
      INSERT INTO knowledge_note_revisions (note_id, revision, kind, title, content, evidence, producer_id, producer_name, removed)
      SELECT id, revision, kind, title, content, evidence, producer_id, producer_name, true FROM saved
    )
    SELECT ${noteColumns} FROM saved`);
}

export async function listNoteTitles(c: DbSession, channelId: string): Promise<KnowledgeNotesContext> {
  const found = await rows<KnowledgeNotesContext['notes'][number]>(c, sql`
    SELECT id, kind, title, revision, updated_at::text AS updated_at FROM knowledge_notes
    WHERE channel_id = ${channelId} AND removed_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT ${KNOWLEDGE_TITLES_MAX + 1}`);
  return { channel_id: channelId, notes: found.slice(0, KNOWLEDGE_TITLES_MAX), truncated: found.length > KNOWLEDGE_TITLES_MAX };
}

export type TurnNoteOutcome = 'saved' | 'unchanged' | 'knowledge_disabled' | 'no_grant' | 'foreign_evidence';

// Called inside the execution.completed transaction. It never throws for a bad note:
// evidence is checked with a plain SELECT before the insert, so the transaction stays usable.
export async function saveTurnNotes(c: DbSession, input: { channelId: string; installationId: string; producer: NoteProducer; notes: NoteDraft[]; fallbackMessageId: string | null }): Promise<TurnNoteOutcome[]> {
  if (!input.notes.length) return [];
  const [channel] = await rows<{ workspace_id: string; knowledge_enabled: boolean; kind: string }>(c, sql`SELECT workspace_id, knowledge_enabled, kind FROM channels WHERE id=${input.channelId}`);
  if (!channel || channel.kind !== 'channel' || !channel.knowledge_enabled) return input.notes.map(() => 'knowledge_disabled');
  const grant = await agentMemoryAccess(c, { workspace_id: channel.workspace_id, channel_id: input.channelId }, input.installationId);
  if (grant?.access !== 'contribute') return input.notes.map(() => 'no_grant');
  const results: TurnNoteOutcome[] = [];
  for (const note of input.notes) {
    const message_ids = note.message_ids.length ? note.message_ids : input.fallbackMessageId ? [input.fallbackMessageId] : [];
    try { await assertNoteEvidence(c, input.channelId, message_ids); }
    catch (error) { if (error instanceof AppError) { results.push('foreign_evidence'); continue; } throw error; }
    results.push(await saveNoteByTitle(c, { workspaceId: channel.workspace_id, channelId: input.channelId }, { ...note, message_ids }, input.producer));
  }
  return results;
}
