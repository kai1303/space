import { sql } from 'drizzle-orm';
import {
  AppError, uuid, encodeChannelCursor, parseChannelCursor,
  CHANNEL_MEMORY_DAYS, CHANNEL_PAGE_DEFAULT, CHANNEL_PAGE_MAX, CHANNEL_TOP_TOPICS, SUMMARY_LIMIT, TOPIC_NAME_MAX,
  type ChannelMemoryHeader, type ChannelMemoryPage, type MemoryFact, type MemoryNode, type SessionMemory, type ThreadMemory, type ThreadContextMessage,
} from '@space/contracts';
import type { DbSession } from './database.js';
import { contextMessage, messageColumns, readThreadContext, rows, type MessageRow } from './thread-context.js';

// Memory is built from messages. The three layers are read from Space's own messages, which always work,
// and are ranked by meaning when the Graph RAG store is configured. The store only proposes message ids;
// every text shown here is read from `messages` in the requested channel, thread or session, so a stale or
// wrong id can never show anything outside the scope the caller already passed the access check for.
export interface MemoryScope { channelId: string; threadId?: string; sessionId?: string }
export type IndexedFact = MemoryFact & { evidence_revisions: Record<string, string> };
export interface MemoryIndex {
  related(scope: MemoryScope, query: string, limit: number): Promise<string[]>;
  // Topics and facts the extraction step wrote for one thread. Facts are checked against Space before they are shown.
  threadKnowledge?(scope: MemoryScope & { threadId: string }): Promise<{ topics: string[]; facts: IndexedFact[] }>;
  // Topic names discussed by the most threads of one channel active in the last `days`, most threads first.
  channelTopics?(scope: { channelId: string }, days: number, limit: number): Promise<string[]>;
}
let index: MemoryIndex | undefined;
export function useMemoryIndex(next: MemoryIndex | undefined) { index = next; }

export const MEMORY_QUERY_LIMIT = 500;
const RELATED_LIMIT = 8;
function checkedQuery(query: string | undefined): string | undefined {
  if (query === undefined) return undefined;
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > MEMORY_QUERY_LIMIT || trimmed.includes('\0')) throw new AppError(400, 'invalid_memory_query');
  return trimmed;
}
async function ranked(scope: MemoryScope, query: string | undefined, limit: number): Promise<string[]> {
  if (!index || query === undefined) return [];
  try { return [...new Set(await index.related(scope, query, limit))].filter(id => /^[0-9a-f-]{36}$/.test(id)).slice(0, limit); }
  catch { return []; }   // ranking is an enhancement; memory still reads without it
}
const firstLine = sql`left(split_part(btrim(text), E'\n', 1), ${SUMMARY_LIMIT})`;
const live = sql`deleted_at IS NULL AND retained_at IS NULL`;

type ThreadRow = { thread_id: string; title: string; last_at: string; sessions: number };
function threadNode(row: ThreadRow, channelId: string): MemoryNode {
  return { ref: { kind: 'thread', id: row.thread_id }, parent: { kind: 'channel', id: channelId }, summary: row.title, updated_at: row.last_at, children: { kind: 'session', count: row.sessions } };
}

// What the channel is for. Name, topic and description come from Space. Counted topics stand in for an
// empty topic; they are derived text, so a store failure only leaves them out.
async function channelHeader(c: DbSession, channelId: string, countTopics: boolean): Promise<ChannelMemoryHeader> {
  const [row] = await rows<{ name: string; topic: string; description: string }>(c, sql`SELECT name, topic, description FROM channels WHERE id = ${channelId}`);
  if (!row) throw new AppError(404, 'channel_not_found');
  let top: string[] = [];
  if (countTopics && !row.topic.trim() && index?.channelTopics) {
    try { top = await index.channelTopics({ channelId }, CHANNEL_MEMORY_DAYS, CHANNEL_TOP_TOPICS); } catch { top = []; }
    top = [...new Set(top.filter(t => typeof t === 'string' && t.trim() && t.length <= TOPIC_NAME_MAX && !t.includes('\0')))].slice(0, CHANNEL_TOP_TOPICS);
  }
  return { name: row.name, topic: row.topic, description: row.description, top_topics: top };
}

// Task preparation passes countTopics: false so it never waits on the Graph RAG store.
export async function readChannelMemory(c: DbSession, channelId: string, after?: string, limit = CHANNEL_PAGE_DEFAULT, query?: string,
  { countTopics = true }: { countTopics?: boolean } = {}): Promise<ChannelMemoryPage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > CHANNEL_PAGE_MAX) throw new AppError(400, 'invalid_memory_limit');
  const asked = checkedQuery(query);
  const cursor = after === undefined ? null : parseChannelCursor(after);
  // Only the first page carries the header, so paging does not repeat it.
  const header = cursor ? {} : { channel: await channelHeader(c, channelId, countTopics) };
  const asOf = cursor?.as_of ?? (await rows<{ now: string }>(c, sql`SELECT now()::text AS now`))[0]!.now;
  const select = (where: ReturnType<typeof sql>, order: ReturnType<typeof sql>, count: number) => rows<ThreadRow>(c, sql`
    WITH active AS (
      SELECT thread_id, max(created_at) AS last_at FROM messages
      WHERE channel_id = ${channelId} AND agent_session_id IS NULL AND ${live}
        AND created_at <= ${asOf}::timestamptz AND created_at > ${asOf}::timestamptz - make_interval(days => ${CHANNEL_MEMORY_DAYS})
      GROUP BY thread_id)
    SELECT a.thread_id, ${sql.raw('root.title')} AS title, a.last_at::text AS last_at,
      (SELECT count(*)::int FROM agent_sessions s WHERE s.origin_thread_id = a.thread_id) AS sessions
    FROM active a JOIN LATERAL (
      SELECT ${firstLine} AS title FROM messages WHERE channel_id = ${channelId} AND thread_id = a.thread_id AND agent_session_id IS NULL AND ${live} ORDER BY sequence LIMIT 1) root ON true
    WHERE ${where} ORDER BY ${order} LIMIT ${count}`);
  if (asked !== undefined && index) {
    const hits = await ranked({ channelId }, asked, 50);
    if (hits.length) {
      const owners = await rows<{ id: string; thread_id: string }>(c, sql`SELECT id, thread_id FROM messages WHERE channel_id = ${channelId} AND agent_session_id IS NULL AND id = ANY(${sql.param(hits)}::uuid[]) AND ${live}`);
      const threadOf = new Map(owners.map(o => [o.id, o.thread_id]));
      const order = new Map<string, number>();
      for (const id of hits) { const t = threadOf.get(id); if (t && !order.has(t)) order.set(t, order.size); }
      const found = await select(sql`a.thread_id = ANY(${sql.param([...order.keys()])}::uuid[])`, sql`a.last_at DESC, a.thread_id DESC`, 50);
      found.sort((a, b) => (order.get(a.thread_id) ?? 99) - (order.get(b.thread_id) ?? 99));
      return { channel_id: channelId, ...header, nodes: found.slice(0, limit).map(row => threadNode(row, channelId)), next_cursor: null };
    }
  }
  // Snapshot at as_of so a message written between pages cannot move a thread across the cursor.
  const found = await select(cursor ? sql`(a.last_at, a.thread_id) < (${cursor.created_at}::timestamptz, ${cursor.thread_id}::uuid)` : sql`true`, sql`a.last_at DESC, a.thread_id DESC`, limit + 1);
  const page = found.slice(0, limit);
  const last = page.at(-1);
  return {
    channel_id: channelId,
    ...header,
    nodes: page.map(row => threadNode(row, channelId)),
    next_cursor: found.length > limit && last ? encodeChannelCursor({ as_of: asOf, created_at: last.last_at, thread_id: last.thread_id }) : null,
  };
}

async function sessionNodes(c: DbSession, threadId: string): Promise<MemoryNode[]> {
  const found = await rows<{ id: string; title: string; state: 'active' | 'ended'; agent: string; updated_at: string }>(c, sql`
    SELECT a.id, a.title, a.state, d.name AS agent,
      coalesce((SELECT max(m.created_at) FROM messages m WHERE m.agent_session_id = a.id), a.created_at)::text AS updated_at
    FROM agent_sessions a JOIN agent_installations i ON i.id = a.installation_id JOIN agent_definitions d ON d.id = i.definition_id
    WHERE a.origin_thread_id = ${threadId} ORDER BY a.created_at DESC, a.id DESC LIMIT 50`);
  return found.map(row => ({ ref: { kind: 'session', id: row.id }, parent: { kind: 'thread', id: threadId }, summary: row.title, updated_at: row.updated_at, children: null, title: row.title, agent: row.agent, state: row.state }));
}

async function relatedMessages(c: DbSession, scope: MemoryScope, query: string | undefined, exclude: Set<string>): Promise<ThreadContextMessage[]> {
  const ids = (await ranked(scope, query, RELATED_LIMIT + exclude.size)).filter(id => !exclude.has(id));
  if (!ids.length) return [];
  const where = scope.sessionId ? sql`agent_session_id = ${scope.sessionId}` : sql`thread_id = ${scope.threadId} AND agent_session_id IS NULL`;
  const found = await rows<MessageRow>(c, sql`SELECT ${messageColumns} FROM messages WHERE channel_id = ${scope.channelId} AND ${where} AND ${live} AND id = ANY(${sql.param(ids)}::uuid[])`);
  const byId = new Map(found.map(row => [row.id, contextMessage(row)]));
  return ids.flatMap(id => byId.get(id) ?? []).slice(0, RELATED_LIMIT);
}

export async function readThreadMemory(c: DbSession, channelId: string, threadId: string, query?: string): Promise<ThreadMemory> {
  const asked = checkedQuery(query);
  const context = await readThreadContext(c, channelId, uuid(threadId));
  const sessions = await sessionNodes(c, context.thread_id);
  const [last] = await rows<{ last_at: string }>(c, sql`SELECT max(created_at)::text AS last_at FROM messages WHERE channel_id = ${channelId} AND thread_id = ${context.thread_id} AND agent_session_id IS NULL AND ${live}`);
  const shown = new Set([context.root?.id, ...context.messages.map(m => m.id)].filter((id): id is string => Boolean(id)));
  const { topics, facts } = await threadKnowledge(c, channelId, context.thread_id);
  return {
    node: { ref: { kind: 'thread', id: context.thread_id }, parent: { kind: 'channel', id: channelId }, summary: (context.root?.text ?? '').split('\n')[0]!.trim().slice(0, SUMMARY_LIMIT), updated_at: last?.last_at ?? '', children: { kind: 'session', count: sessions.length } },
    context, sessions, related: await relatedMessages(c, { channelId, threadId: context.thread_id }, asked, shown), topics, facts,
  };
}

// A fact is shown only if every one of its evidence messages is a live message of this thread, so derived
// text never says more than its sources. Topics are shown only when at least one fact or the thread survives.
async function threadKnowledge(c: DbSession, channelId: string, threadId: string): Promise<{ topics: string[]; facts: MemoryFact[] }> {
  if (!index?.threadKnowledge) return { topics: [], facts: [] };
  let found: { topics: string[]; facts: IndexedFact[] };
  try { found = await index.threadKnowledge({ channelId, threadId }); } catch { return { topics: [], facts: [] }; }
  const cited = [...new Set(found.facts.flatMap(f => f.message_ids))].filter(id => /^[0-9a-f-]{36}$/.test(id)).slice(0, 128);
  const revisions = new Map(cited.length ? (await rows<{ id: string; revision: string }>(c, sql`
    SELECT id, search_revision::text AS revision FROM messages WHERE channel_id = ${channelId} AND thread_id = ${threadId}
    AND agent_session_id IS NULL AND ${live} AND id = ANY(${sql.param(cited)}::uuid[])`)).map(row => [row.id, row.revision] as const) : []);
  const facts = found.facts.filter(f => f.message_ids.length && f.message_ids.every(id =>
    revisions.has(id) && revisions.get(id) === f.evidence_revisions[id])).slice(0, 8)
    .map(({ evidence_revisions: _, ...fact }) => fact);
  return { topics: found.topics.slice(0, 5), facts };
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
function ownSession(session: { installation_id: string; state: string }, installationId: string | null) {
  if (installationId === null || session.installation_id !== installationId) throw new AppError(403, 'session_private');
  if (session.state === 'ended') throw new AppError(409, 'session_ended');
}

// installationId is the caller's bound installation; null means an unbound key.
export async function readSessionMemory(c: DbSession, channelId: string, sessionId: string, installationId: string | null, query?: string): Promise<SessionMemory> {
  const session = await sessionRow(c, channelId, sessionId);
  ownSession(session, installationId);
  return sessionMemoryFor(c, channelId, session, checkedQuery(query));
}
// People: the route authorizes thread access first. Ended sessions stay readable as history.
export async function readSessionMemoryForPerson(c: DbSession, channelId: string, sessionId: string, query?: string): Promise<SessionMemory> {
  return sessionMemoryFor(c, channelId, await sessionRow(c, channelId, sessionId), checkedQuery(query));
}
async function sessionMemoryFor(c: DbSession, channelId: string, session: Awaited<ReturnType<typeof sessionRow>>, query: string | undefined): Promise<SessionMemory> {
  const recent = await rows<MessageRow>(c, sql`SELECT ${messageColumns} FROM messages
    WHERE channel_id = ${channelId} AND thread_id = ${session.thread_id} AND agent_session_id = ${session.id} AND ${live}
    ORDER BY sequence DESC LIMIT 16`);
  const messages = recent.reverse().map(contextMessage);
  const [last] = await rows<{ last_at: string }>(c, sql`SELECT max(created_at)::text AS last_at FROM messages WHERE channel_id = ${channelId} AND agent_session_id = ${session.id}`);
  return {
    node: { ref: { kind: 'session', id: session.id }, parent: { kind: 'thread', id: session.thread_id }, summary: session.title, updated_at: last?.last_at ?? session.created_at, children: null, title: session.title, agent: session.agent, state: session.state },
    messages, related: await relatedMessages(c, { channelId, threadId: session.thread_id, sessionId: session.id }, query, new Set(messages.map(m => m.id))),
  };
}
