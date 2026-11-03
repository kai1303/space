import { sql } from 'drizzle-orm';
import { AppError, chatCursor, uuid, type ThreadContext, type ThreadContextMessage, type ThreadCheckpoint, type ThreadCheckpointInput } from '@space/contracts';
import type { DbSession } from './database.js';

async function rows<T>(c: DbSession, query: Parameters<DbSession['execute']>[0]): Promise<T[]> {
  return (await c.execute(query)).rows as T[];
}
export async function assertContextThread(c: DbSession, channelId: string, threadId: string) {
  const found = await rows(c, sql`SELECT id FROM threads WHERE id=${uuid(threadId)} AND channel_id=${channelId}`);
  if (!found.length) throw new AppError(404, 'thread_not_found');
}
// Only attachment metadata is returned. Files retain their existing authorized download flow.
function message(row: ThreadContextMessage & { author_id: string; author_type: 'human' | 'agent'; text_length: number }): ThreadContextMessage {
  // PostgreSQL counts code points; contracts count UTF-16 units. Never split an emoji.
  const excerpt = row.text.slice(0,1000).replace(/[\uD800-\uDBFF]$/, '');
  return { id: row.id, sequence: row.sequence, text: excerpt, text_truncated: row.text_length > 1000 || excerpt !== row.text, author: { id: row.author_id, kind: row.author_type }, attachments: row.attachments };
}
const columns = sql`id, sequence::text, left(text,1000) AS text, length(text) AS text_length,
  coalesce(user_id,installation_id) AS author_id, author_type, attachments`;
type Row = Parameters<typeof message>[0];
async function checkpoint(c: DbSession, threadId: string, through: string): Promise<ThreadCheckpoint | null> {
  const [row] = await rows<ThreadCheckpoint>(c, sql`SELECT revision,through_sequence::text,content,source_message_ids,producer_id,producer_name,created_at::text
    FROM thread_checkpoints WHERE thread_id=${threadId} AND through_sequence<=${through}::bigint ORDER BY revision DESC LIMIT 1`);
  return row ?? null;
}
export async function readThreadContext(c: DbSession, channelId: string, threadId: string, through?: string): Promise<ThreadContext> {
  await assertContextThread(c, channelId, threadId);
  const [latest] = await rows<{ sequence: string }>(c, sql`SELECT sequence::text FROM messages WHERE channel_id=${channelId} AND thread_id=${threadId} ORDER BY messages.sequence DESC LIMIT 1`);
  const watermark = through === undefined ? latest?.sequence ?? '0' : chatCursor(through);
  const recent = await rows<Row>(c, sql`SELECT ${columns} FROM messages WHERE channel_id=${channelId} AND thread_id=${threadId} AND sequence<=${watermark}::bigint ORDER BY messages.sequence DESC LIMIT 17`);
  const [root] = await rows<Row>(c, sql`SELECT ${columns} FROM messages WHERE channel_id=${channelId} AND thread_id=${threadId} AND sequence<=${watermark}::bigint ORDER BY messages.sequence LIMIT 1`);
  return { thread_id: threadId, through_sequence: watermark, root: root ? message(root) : null,
    messages: recent.slice(0,16).reverse().map(message), checkpoint: await checkpoint(c, threadId, watermark), has_earlier_messages: recent.length > 16 };
}
export async function readThreadMessages(c: DbSession, channelId: string, threadId: string, after = '0', limit = 20) {
  await assertContextThread(c, channelId, threadId);
  const cursor = chatCursor(after);
  const found = await rows<Row>(c, sql`SELECT ${columns} FROM messages WHERE channel_id=${channelId} AND thread_id=${threadId} AND sequence>${cursor}::bigint ORDER BY messages.sequence LIMIT ${limit+1}`);
  const page = found.slice(0,limit);
  return { messages: page.map(message), cursor: page.at(-1)?.sequence ?? cursor, has_more: found.length > limit };
}
export async function writeThreadCheckpoint(c: DbSession, channelId: string, threadId: string, input: ThreadCheckpointInput, producer: { id: string; name: string }): Promise<ThreadCheckpoint> {
  await assertContextThread(c, channelId, threadId);
  // Serialize competing agents on the thread, including first-checkpoint races.
  await c.execute(sql`SELECT id FROM threads WHERE id=${threadId} FOR UPDATE`);
  const current = await checkpoint(c, threadId, '9223372036854775807');
  if ((current?.revision ?? 0) !== input.revision) throw new AppError(409, 'thread_checkpoint_conflict');
  if (current && BigInt(input.through_sequence) < BigInt(current.through_sequence)) throw new AppError(409, 'thread_checkpoint_watermark_conflict');
  const [boundary] = await rows(c, sql`SELECT id FROM messages WHERE channel_id=${channelId} AND thread_id=${threadId} AND sequence=${input.through_sequence}::bigint`);
  if (!boundary) throw new AppError(400, 'invalid_thread_watermark');
  for (const id of input.source_message_ids) {
    const [source] = await rows(c, sql`SELECT id FROM messages WHERE channel_id=${channelId} AND thread_id=${threadId} AND id=${id} AND sequence<=${input.through_sequence}::bigint`);
    if (!source) throw new AppError(400, 'invalid_thread_source');
  }
  const [saved] = await rows<ThreadCheckpoint>(c, sql`INSERT INTO thread_checkpoints(thread_id,revision,through_sequence,content,source_message_ids,producer_id,producer_name)
    VALUES(${threadId},${input.revision+1},${input.through_sequence}::bigint,${input.content},${sql.param(input.source_message_ids)}::uuid[],${producer.id},${producer.name})
    RETURNING revision,through_sequence::text,content,source_message_ids,producer_id,producer_name,created_at::text`);
  return saved!;
}
