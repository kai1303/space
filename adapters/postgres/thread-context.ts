import { sql } from 'drizzle-orm';
import { AppError, chatCursor, uuid, type ThreadContext, type ThreadContextMessage } from '@space/contracts';
import type { DbSession } from './database.js';

export async function rows<T>(c: DbSession, query: Parameters<DbSession['execute']>[0]): Promise<T[]> {
  return (await c.execute(query)).rows as T[];
}
export async function assertContextThread(c: DbSession, channelId: string, threadId: string) {
  const found = await rows(c, sql`SELECT id FROM threads WHERE id=${uuid(threadId)} AND channel_id=${channelId}`);
  if (!found.length) throw new AppError(404, 'thread_not_found');
}
// Only attachment metadata is returned. Files retain their existing authorized download flow.
export function contextMessage(row: ThreadContextMessage & { author_id: string; author_type: 'human' | 'agent' | 'app' | 'workflow'; text_length: number }): ThreadContextMessage {
  // PostgreSQL counts code points; contracts count UTF-16 units. Never split an emoji.
  const excerpt = row.text.slice(0,1000).replace(/[\uD800-\uDBFF]$/, '');
  return { id: row.id, sequence: row.sequence, text: excerpt, text_truncated: row.text_length > 1000 || excerpt !== row.text, author: { id: row.author_id, kind: row.author_type }, attachments: row.attachments };
}
export const messageColumns = sql`id, sequence::text, left(text,1000) AS text, length(text) AS text_length,
  coalesce(user_id,installation_id,webhook_id) AS author_id, author_type, attachments`;
const sharedMessage = sql`agent_session_id IS NULL AND deleted_at IS NULL AND retained_at IS NULL`;
export type MessageRow = Parameters<typeof contextMessage>[0];
export async function readThreadContext(c: DbSession, channelId: string, threadId: string, through?: string): Promise<ThreadContext> {
  await assertContextThread(c, channelId, threadId);
  const [latest] = await rows<{ sequence: string }>(c, sql`SELECT sequence::text FROM messages WHERE channel_id=${channelId} AND thread_id=${threadId} AND ${sharedMessage} ORDER BY messages.sequence DESC LIMIT 1`);
  const watermark = through === undefined ? latest?.sequence ?? '0' : chatCursor(through);
  const recent = await rows<MessageRow>(c, sql`SELECT ${messageColumns} FROM messages WHERE channel_id=${channelId} AND thread_id=${threadId} AND ${sharedMessage} AND sequence<=${watermark}::bigint ORDER BY messages.sequence DESC LIMIT 17`);
  const [root] = await rows<MessageRow>(c, sql`SELECT ${messageColumns} FROM messages WHERE channel_id=${channelId} AND thread_id=${threadId} AND ${sharedMessage} AND sequence<=${watermark}::bigint ORDER BY messages.sequence LIMIT 1`);
  return { thread_id: threadId, through_sequence: watermark, root: root ? contextMessage(root) : null,
    messages: recent.slice(0,16).reverse().map(contextMessage), has_earlier_messages: recent.length > 16 };
}
export async function readThreadMessages(c: DbSession, channelId: string, threadId: string, after = '0', limit = 20) {
  await assertContextThread(c, channelId, threadId);
  const cursor = chatCursor(after);
  const found = await rows<MessageRow>(c, sql`SELECT ${messageColumns} FROM messages WHERE channel_id=${channelId} AND thread_id=${threadId} AND ${sharedMessage} AND sequence>${cursor}::bigint ORDER BY messages.sequence LIMIT ${limit+1}`);
  const page = found.slice(0,limit);
  return { messages: page.map(contextMessage), cursor: page.at(-1)?.sequence ?? cursor, has_more: found.length > limit };
}
