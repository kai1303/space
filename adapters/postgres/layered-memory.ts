import { sql } from 'drizzle-orm';
import {
  AppError, uuid, chatCursor, encodeChannelCursor, parseChannelCursor,
  CHANNEL_MEMORY_DAYS, CHANNEL_PAGE_DEFAULT, CHANNEL_PAGE_MAX, CHECKPOINT_LIMIT,
  type ChannelMemoryPage, type MemoryNode, type SessionMemory, type ThreadMemory, type MemoryConflict, type AgentMemoryUpdate,
  type ThreadCheckpoint, type ThreadCheckpointInput, type ThreadContextMessage,
} from '@space/contracts';
import type { DbSession } from './database.js';
import { assertCheckpointSources, assertContextThread, checkpointColumns, readThreadContext, rows, writeThreadCheckpoint } from './thread-context.js';

export async function readChannelMemory(c: DbSession, channelId: string, after?: string, limit = CHANNEL_PAGE_DEFAULT): Promise<ChannelMemoryPage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > CHANNEL_PAGE_MAX) throw new AppError(400, 'invalid_memory_limit');
  const cursor = after === undefined ? null : parseChannelCursor(after);
  const asOf = cursor?.as_of ?? (await rows<{ now: string }>(c, sql`SELECT now()::text AS now`))[0]!.now;
  // Snapshot at as_of so a checkpoint written between pages cannot move a thread across the cursor.
  const found = await rows<{ thread_id: string; summary: string; created_at: string; sessions: number }>(c, sql`
    SELECT latest.thread_id, latest.summary, latest.created_at::text AS created_at,
      (SELECT count(*)::int FROM agent_sessions a WHERE a.origin_thread_id = latest.thread_id) AS sessions
    FROM (
      SELECT DISTINCT ON (cp.thread_id) cp.thread_id, cp.summary, cp.created_at
      FROM thread_checkpoints cp
      WHERE cp.channel_id = ${channelId} AND cp.session_id IS NULL
        AND cp.created_at <= ${asOf}::timestamptz
        AND cp.created_at > ${asOf}::timestamptz - make_interval(days => ${CHANNEL_MEMORY_DAYS})
      ORDER BY cp.thread_id, cp.revision DESC
    ) latest
    WHERE ${cursor ? sql`(latest.created_at, latest.thread_id) < (${cursor.created_at}::timestamptz, ${cursor.thread_id}::uuid)` : sql`true`}
    ORDER BY latest.created_at DESC, latest.thread_id DESC
    LIMIT ${limit + 1}`);
  const page = found.slice(0, limit);
  const last = page.at(-1);
  return {
    channel_id: channelId,
    nodes: page.map(row => ({ ref: { kind: 'thread', id: row.thread_id }, parent: { kind: 'channel', id: channelId }, summary: row.summary, updated_at: row.created_at, children: { kind: 'session', count: row.sessions } })),
    next_cursor: found.length > limit && last ? encodeChannelCursor({ as_of: asOf, created_at: last.created_at, thread_id: last.thread_id }) : null,
  };
}

async function sessionNodes(c: DbSession, threadId: string): Promise<MemoryNode[]> {
  const found = await rows<{ id: string; title: string; state: 'active' | 'ended'; agent: string; summary: string | null; updated_at: string }>(c, sql`
    SELECT a.id, a.title, a.state, d.name AS agent,
      (SELECT cp.summary FROM thread_checkpoints cp WHERE cp.session_id = a.id ORDER BY cp.revision DESC LIMIT 1) AS summary,
      coalesce((SELECT max(cp.created_at) FROM thread_checkpoints cp WHERE cp.session_id = a.id), a.created_at)::text AS updated_at
    FROM agent_sessions a JOIN agent_installations i ON i.id = a.installation_id JOIN agent_definitions d ON d.id = i.definition_id
    WHERE a.origin_thread_id = ${threadId} ORDER BY a.created_at DESC, a.id DESC LIMIT 50`);
  return found.map(row => ({ ref: { kind: 'session', id: row.id }, parent: { kind: 'thread', id: threadId }, summary: row.summary ?? row.title, updated_at: row.updated_at, children: null, title: row.title, agent: row.agent, state: row.state }));
}

export async function readThreadMemory(c: DbSession, channelId: string, threadId: string): Promise<ThreadMemory> {
  const context = await readThreadContext(c, channelId, uuid(threadId), undefined, { includeSessions: false });
  const sessions = await sessionNodes(c, context.thread_id);
  const cp = context.checkpoint;
  return {
    node: { ref: { kind: 'thread', id: context.thread_id }, parent: { kind: 'channel', id: channelId }, summary: cp?.summary ?? context.root?.text.slice(0, 280) ?? '', updated_at: cp?.created_at ?? '', children: { kind: 'session', count: sessions.length } },
    context, sessions, checkpoint_chars: cp?.content.length ?? 0, limit: CHECKPOINT_LIMIT,
  };
}

async function sessionRow(c: DbSession, channelId: string, sessionId: string) {
  const [row] = await rows<{ id: string; thread_id: string; installation_id: string; title: string; state: 'active' | 'ended'; agent: string; created_at: string }>(c, sql`
    SELECT a.id, a.origin_thread_id AS thread_id, a.installation_id, a.title, a.state, d.name AS agent, a.created_at::text
    FROM agent_sessions a JOIN threads t ON t.id = a.origin_thread_id
    JOIN agent_installations i ON i.id = a.installation_id JOIN agent_definitions d ON d.id = i.definition_id
    WHERE a.id = ${uuid(sessionId)} AND t.channel_id = ${channelId}`);
  if (!row) throw new AppError(404, 'session_not_found');
  return row;
}
async function sessionCheckpoint(c: DbSession, sessionId: string): Promise<ThreadCheckpoint | null> {
  const [row] = await rows<ThreadCheckpoint>(c, sql`SELECT ${checkpointColumns} FROM thread_checkpoints WHERE session_id = ${sessionId} ORDER BY revision DESC LIMIT 1`);
  return row ?? null;
}
function ownSession(session: { installation_id: string; state: string }, installationId: string | null) {
  if (installationId === null || session.installation_id !== installationId) throw new AppError(403, 'session_private');
  if (session.state === 'ended') throw new AppError(409, 'session_ended');
}

// installationId is the caller's bound installation; null means an unbound key.
export async function readSessionMemory(c: DbSession, channelId: string, sessionId: string, installationId: string | null): Promise<SessionMemory> {
  const session = await sessionRow(c, channelId, sessionId);
  ownSession(session, installationId);
  const checkpoint = await sessionCheckpoint(c, session.id);
  const recent = await rows<{ id: string; sequence: string; text: string; text_length: number; author_id: string; attachments: ThreadContextMessage['attachments'] }>(c, sql`
    SELECT id, sequence::text, left(text, 1000) AS text, length(text) AS text_length, installation_id AS author_id, attachments
    FROM messages WHERE channel_id = ${channelId} AND thread_id = ${session.thread_id} AND agent_session_id = ${session.id}
    ORDER BY sequence DESC LIMIT 16`);
  const messages: ThreadContextMessage[] = recent.reverse().map(row => {
    const text = row.text.replace(/[\uD800-\uDBFF]$/, '');
    return { id: row.id, sequence: row.sequence, text, text_truncated: row.text_length > 1000 || text !== row.text, author: { id: row.author_id, kind: 'agent' }, attachments: row.attachments };
  });
  return {
    node: { ref: { kind: 'session', id: session.id }, parent: { kind: 'thread', id: session.thread_id }, summary: checkpoint?.summary ?? session.title, updated_at: checkpoint?.created_at ?? session.created_at, children: null, title: session.title, agent: session.agent, state: session.state },
    checkpoint, messages, checkpoint_chars: checkpoint?.content.length ?? 0, limit: CHECKPOINT_LIMIT,
  };
}

// Optimistic concurrency: the partial unique index on (session_id, revision) rejects a competing insert.
export async function writeSessionCheckpoint(c: DbSession, channelId: string, sessionId: string, installationId: string | null, input: ThreadCheckpointInput, producer: { id: string; name: string }): Promise<ThreadCheckpoint> {
  const session = await sessionRow(c, channelId, sessionId);
  ownSession(session, installationId);
  await assertContextThread(c, channelId, session.thread_id);
  const current = await sessionCheckpoint(c, session.id);
  if ((current?.revision ?? 0) !== input.revision) throw new AppError(409, 'session_checkpoint_conflict');
  if (current && BigInt(chatCursor(input.through_sequence)) < BigInt(current.through_sequence)) throw new AppError(409, 'session_checkpoint_watermark_conflict');
  await assertCheckpointSources(c, channelId, session.thread_id, input, 'session');
  const [saved] = await rows<ThreadCheckpoint>(c, sql`INSERT INTO thread_checkpoints(thread_id,session_id,channel_id,revision,through_sequence,content,summary,source_message_ids,producer_id,producer_name)
    VALUES(${session.thread_id},${session.id},${channelId},${input.revision + 1},${input.through_sequence}::bigint,${input.content},${input.summary},${sql.param(input.source_message_ids)}::uuid[],${producer.id},${producer.name})
    ON CONFLICT (session_id, revision) WHERE session_id IS NOT NULL DO NOTHING
    RETURNING ${checkpointColumns}`);
  if (!saved) throw new AppError(409, 'session_checkpoint_conflict');
  return saved;
}

type TurnScope = 'session' | 'thread';
export type TurnMemoryOutcome = { scope: TurnScope; outcome: 'saved' | 'pending' | 'skipped' };
const conflictCodes = new Set(['thread_checkpoint_conflict', 'session_checkpoint_conflict', 'thread_checkpoint_watermark_conflict', 'session_checkpoint_watermark_conflict']);

// Called inside the execution.completed transaction. It never throws for a bad or stale update,
// so memory problems cannot fail the agent's turn. The writers raise AppError before any SQL error,
// and their inserts use ON CONFLICT DO NOTHING, so the surrounding transaction stays usable.
export async function saveTurnMemory(c: DbSession, input: { channelId: string; threadId: string; sessionId: string | null; installationId: string; producer: { id: string; name: string }; memory: AgentMemoryUpdate }): Promise<TurnMemoryOutcome[]> {
  const [last] = await rows<{ id: string; sequence: string }>(c, sql`SELECT id, sequence::text FROM messages WHERE channel_id=${input.channelId} AND thread_id=${input.threadId} ORDER BY sequence DESC LIMIT 1`);
  const results: TurnMemoryOutcome[] = [];
  for (const scope of ['session', 'thread'] as const) {
    const part = input.memory[scope];
    if (!part) continue;
    if (!last || (scope === 'session' && !input.sessionId)) { results.push({ scope, outcome: 'skipped' }); continue; }
    const key = scope === 'session' ? `session:${input.sessionId}` : `thread:${input.threadId}`;
    const checkpoint = { revision: part.base_revision, through_sequence: last.sequence, content: part.content, summary: part.summary, source_message_ids: [last.id] };
    try {
      if (scope === 'session') await writeSessionCheckpoint(c, input.channelId, input.sessionId!, input.installationId, checkpoint, input.producer);
      else await writeThreadCheckpoint(c, input.channelId, input.threadId, checkpoint, input.producer);
      await c.execute(sql`DELETE FROM memory_pending WHERE installation_id=${input.installationId} AND scope_key=${key}`);
      results.push({ scope, outcome: 'saved' });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (!conflictCodes.has(error.code)) { results.push({ scope, outcome: 'skipped' }); continue; }
      await c.execute(sql`INSERT INTO memory_pending(installation_id,scope_key,base_revision,summary,content)
        VALUES(${input.installationId},${key},${part.base_revision},${part.summary},${part.content})
        ON CONFLICT (installation_id, scope_key) DO UPDATE SET base_revision=EXCLUDED.base_revision, summary=EXCLUDED.summary, content=EXCLUDED.content, created_at=now()`);
      results.push({ scope, outcome: 'pending' });
    }
  }
  return results;
}

export async function readPendingMemory(c: DbSession, installationId: string, threadId: string, sessionId: string | null): Promise<MemoryConflict[]> {
  const keys = [`thread:${threadId}`, ...(sessionId ? [`session:${sessionId}`] : [])];
  return rows<MemoryConflict>(c, sql`
    SELECT split_part(p.scope_key, ':', 1) AS scope, p.base_revision, p.summary, p.content,
      CASE WHEN p.scope_key LIKE 'thread:%'
        THEN coalesce((SELECT max(cp.revision) FROM thread_checkpoints cp WHERE cp.thread_id = ${threadId} AND cp.session_id IS NULL), 0)
        ELSE coalesce((SELECT max(cp.revision) FROM thread_checkpoints cp WHERE cp.session_id::text = split_part(p.scope_key, ':', 2)), 0)
      END AS current_revision
    FROM memory_pending p WHERE p.installation_id=${installationId} AND p.scope_key = ANY(${sql.param(keys)}::text[])
    ORDER BY p.scope_key`);
}
