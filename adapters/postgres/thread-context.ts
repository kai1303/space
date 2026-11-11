import { sql } from 'drizzle-orm';
import { AppError, chatCursor, uuid, type ThreadContext, type ThreadContextMessage, type MemoryRecord, type MemoryInput } from '@space/contracts';
import type { DbSession } from './database.js';

export async function rows<T>(c: DbSession, query: Parameters<DbSession['execute']>[0]): Promise<T[]> {
  return (await c.execute(query)).rows as T[];
}
export async function assertContextThread(c: DbSession, channelId: string, threadId: string) {
  const found = await rows(c, sql`SELECT id FROM threads WHERE id=${uuid(threadId)} AND channel_id=${channelId}`);
  if (!found.length) throw new AppError(404, 'thread_not_found');
}
// Only attachment metadata is returned. Files retain their existing authorized download flow.
function message(row: ThreadContextMessage & { author_id: string; author_type: 'human' | 'agent' | 'app' | 'workflow'; text_length: number }): ThreadContextMessage {
  // PostgreSQL counts code points; contracts count UTF-16 units. Never split an emoji.
  const excerpt = row.text.slice(0,1000).replace(/[\uD800-\uDBFF]$/, '');
  return { id: row.id, sequence: row.sequence, text: excerpt, text_truncated: row.text_length > 1000 || excerpt !== row.text, author: { id: row.author_id, kind: row.author_type }, attachments: row.attachments };
}
const columns = sql`id, sequence::text, left(text,1000) AS text, length(text) AS text_length,
  coalesce(user_id,installation_id,webhook_id) AS author_id, author_type, attachments`;
type Row = Parameters<typeof message>[0];
export const memoryColumns = sql`revision,through_sequence::text,content,summary,source_message_ids,producer_id,producer_name,created_at::text`;
async function memory(c: DbSession, threadId: string, through: string): Promise<MemoryRecord | null> {
  const [row] = await rows<MemoryRecord>(c, sql`SELECT ${memoryColumns}
    FROM memory_revisions WHERE thread_id=${threadId} AND session_id IS NULL AND through_sequence<=${through}::bigint ORDER BY revision DESC LIMIT 1`);
  return row ?? null;
}
export async function readThreadContext(c: DbSession, channelId: string, threadId: string, through?: string, options: { includeSessions?: boolean } = {}): Promise<ThreadContext> {
  await assertContextThread(c, channelId, threadId);
  const visible = options.includeSessions === false ? sql`AND agent_session_id IS NULL` : sql``;
  const [latest] = await rows<{ sequence: string }>(c, sql`SELECT sequence::text FROM messages WHERE channel_id=${channelId} AND thread_id=${threadId} ${visible} ORDER BY messages.sequence DESC LIMIT 1`);
  const watermark = through === undefined ? latest?.sequence ?? '0' : chatCursor(through);
  const recent = await rows<Row>(c, sql`SELECT ${columns} FROM messages WHERE channel_id=${channelId} AND thread_id=${threadId} ${visible} AND sequence<=${watermark}::bigint ORDER BY messages.sequence DESC LIMIT 17`);
  const [root] = await rows<Row>(c, sql`SELECT ${columns} FROM messages WHERE channel_id=${channelId} AND thread_id=${threadId} ${visible} AND sequence<=${watermark}::bigint ORDER BY messages.sequence LIMIT 1`);
  return { thread_id: threadId, through_sequence: watermark, root: root ? message(root) : null,
    messages: recent.slice(0,16).reverse().map(message), memory: await memory(c, threadId, watermark), has_earlier_messages: recent.length > 16 };
}
export async function readThreadMessages(c: DbSession, channelId: string, threadId: string, after = '0', limit = 20) {
  await assertContextThread(c, channelId, threadId);
  const cursor = chatCursor(after);
  const found = await rows<Row>(c, sql`SELECT ${columns} FROM messages WHERE channel_id=${channelId} AND thread_id=${threadId} AND sequence>${cursor}::bigint ORDER BY messages.sequence LIMIT ${limit+1}`);
  const page = found.slice(0,limit);
  return { messages: page.map(message), cursor: page.at(-1)?.sequence ?? cursor, has_more: found.length > limit };
}
// The watermark may be any message in the thread, so turn-end saves can use the latest one.
export async function assertMemorySources(c: DbSession, channelId: string, threadId: string, input: MemoryInput, scope: 'thread' | 'session') {
  const [boundary] = await rows(c, sql`SELECT id FROM messages WHERE channel_id=${channelId} AND thread_id=${threadId} AND sequence=${input.through_sequence}::bigint`);
  if (!boundary) throw new AppError(400, `invalid_${scope}_watermark`);
  const found = await rows<{ id: string }>(c, sql`SELECT id FROM messages WHERE channel_id=${channelId} AND thread_id=${threadId}
    AND id = ANY(${sql.param(input.source_message_ids)}::uuid[]) AND sequence<=${input.through_sequence}::bigint`);
  if (found.length !== input.source_message_ids.length) throw new AppError(400, `invalid_${scope}_source`);
}

// Optimistic concurrency: the partial unique index on (thread_id, revision) rejects a competing insert.
export async function writeThreadMemory(c: DbSession, channelId: string, threadId: string, input: MemoryInput, producer: { id: string; name: string }): Promise<MemoryRecord> {
  await assertContextThread(c, channelId, threadId);
  const current = await memory(c, threadId, '9223372036854775807');
  if ((current?.revision ?? 0) !== input.revision) throw new AppError(409, 'thread_memory_conflict');
  if (current && BigInt(input.through_sequence) < BigInt(current.through_sequence)) throw new AppError(409, 'thread_memory_watermark_conflict');
  await assertMemorySources(c, channelId, threadId, input, 'thread');
  const [saved] = await rows<MemoryRecord>(c, sql`INSERT INTO memory_revisions(thread_id,channel_id,revision,through_sequence,content,summary,source_message_ids,producer_id,producer_name)
    VALUES(${threadId},${channelId},${input.revision+1},${input.through_sequence}::bigint,${input.content},${input.summary},${sql.param(input.source_message_ids)}::uuid[],${producer.id},${producer.name})
    ON CONFLICT (thread_id, revision) WHERE session_id IS NULL DO NOTHING
    RETURNING ${memoryColumns}`);
  if (!saved) throw new AppError(409, 'thread_memory_conflict');
  return saved;
}
