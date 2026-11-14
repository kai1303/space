import { sql } from 'drizzle-orm';
import {
  AppError,
  parseReactionInput,
  record,
  text,
  uuid,
  type AgentSessionTurn,
  type SessionMessagePart,
  type SessionMessageState,
  type SessionMessageReply,
} from '@space/contracts';
import type { DbSession, Database } from './database.js';
import { sessionTransaction } from './session-concurrency.js';

export async function attachSessionMessageStates(c: DbSession, actor: string, turns: AgentSessionTurn[]) {
  if (!turns.length) return;
  const result = await c.execute<
    Record<string, unknown> & SessionMessageState & { task_id: string; part: SessionMessagePart }
  >(sql`
    SELECT m.task_id,m.part,m.edited_text,m.deleted_at::text,m.pinned,p.saved_at IS NOT NULL AS saved,
      coalesce(p.unread,false) AS unread,coalesce(p.following,true) AS following,
      (SELECT count(*)::int FROM session_message_replies WHERE message_id=m.id) AS reply_count,
      coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY emoji) FROM (
        SELECT emoji,count(*)::int AS count,array_remove(ARRAY[max(user_id::text) FILTER (WHERE user_id=${actor})],NULL) AS user_ids FROM session_message_reactions
        WHERE message_id=m.id GROUP BY emoji) r),'[]') AS reactions
    FROM session_message_state m LEFT JOIN session_message_preferences p ON p.message_id=m.id AND p.user_id=${actor}
    WHERE task_id IN (${sql.join(
      turns.map((t) => sql`${t.task.id}::uuid`),
      sql`,`,
    )})`);
  const byId = new Map(turns.map((turn) => [turn.task.id, turn]));
  for (const { task_id, part, ...state } of result.rows) {
    const turn = byId.get(task_id)!;
    (turn.message_states ??= {})[part] = state;
  }
}

async function target(c: DbSession, actor: string, session: string, task: string, part: string) {
  if (!['request', 'response'].includes(part)) throw new AppError(400, 'invalid_message_part');
  const [row] = (
    await c.execute<{
      workspace_id: string;
      origin_thread_id: string;
      requester_id: string;
      archived: boolean;
    }>(sql`
    SELECT a.workspace_id,a.origin_thread_id,t.requester_id,ch.archived_at IS NOT NULL AS archived
    FROM tasks t JOIN agent_sessions a ON a.id=t.session_id JOIN threads th ON th.id=a.origin_thread_id
    JOIN channels ch ON ch.id=th.channel_id JOIN channel_members cm ON cm.channel_id=ch.id AND cm.user_id=${actor}
    JOIN workspace_members wm ON wm.workspace_id=a.workspace_id AND wm.user_id=cm.user_id AND wm.active
    WHERE a.id=${session} AND t.id=${task}
      AND (${part}='request' OR t.status NOT IN ('queued','running') OR EXISTS (
        SELECT 1 FROM task_events e WHERE e.correlation_id=t.id AND e.payload ? 'response'
          AND (jsonb_array_length(e.payload#>'{response,messages}')>0 OR jsonb_array_length(e.payload#>'{response,tools}')>0
               OR jsonb_array_length(e.payload#>'{response,components}')>0)
      ) OR EXISTS(SELECT 1 FROM agent_event_receipts e WHERE e.installation_id=t.installation_id AND e.event->>'execution_id'=t.active_execution_id::text AND e.event#>>'{payload,transcript,last}'='true'))
      AND (a.handoff_context IS NULL OR a.created_by=${actor})`)
  ).rows;
  if (!row) throw new AppError(404, 'not_found');
  return row;
}

export async function sessionReplies(
  db: Database,
  actor: string,
  session: string,
  task: string,
  part: string,
  query: unknown,
) {
  const { before } = record(query, ['before']);
  const cursor = before === undefined ? null : uuid(before);
  return db.transaction(
    async (c) => {
      await target(c, actor, session, task, part);
      const page = await c.execute<SessionMessageReply & Record<string, unknown>>(sql`
      SELECT r.id,u.display_name AS author,r.body,r.created_at::text FROM session_message_replies r
      JOIN session_message_state m ON m.id=r.message_id JOIN users u ON u.id=r.user_id
      WHERE m.task_id=${task} AND m.part=${part} AND m.deleted_at IS NULL
      ${cursor ? sql`AND (r.created_at,r.id)<(SELECT created_at,id FROM session_message_replies WHERE id=${cursor} AND message_id=m.id)` : sql``}
      ORDER BY r.created_at DESC,r.id DESC LIMIT 31`);
      const items = page.rows.slice(0, 30).reverse();
      return { items, next: page.rows.length > 30 ? items[0]!.id : null };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

export async function changeSessionMessage(
  db: Database,
  actor: string,
  session: string,
  task: string,
  part: string,
  input: unknown,
) {
  const v = record(input, ['action', 'active', 'emoji', 'text', 'id', 'expected']);
  return sessionTransaction(db, async (c) => {
    const row = await target(c, actor, session, task, part);
    if ((v.action === 'edit' || v.action === 'delete') && (part !== 'request' || row.requester_id !== actor))
      throw new AppError(403, 'forbidden');
    if (row.archived && ['edit', 'reply', 'react', 'pin'].includes(String(v.action)))
      throw new AppError(409, 'channel_archived');
    await c.execute(
      sql`INSERT INTO session_message_state(task_id,part) VALUES(${task},${part}) ON CONFLICT DO NOTHING`,
    );
    const [m] = (
      await c.execute<{ id: string; deleted_at: string | null }>(
        sql`SELECT id,deleted_at FROM session_message_state WHERE task_id=${task} AND part=${part}`,
      )
    ).rows;
    if (m!.deleted_at && v.action !== 'delete') throw new AppError(409, 'message_deleted');
    const id = m!.id;
    switch (v.action) {
      case 'react': {
        const { emoji, active } = parseReactionInput({ emoji: v.emoji, active: v.active });
        await c.execute(
          active
            ? sql`INSERT INTO session_message_reactions VALUES(${id},${actor},${emoji}) ON CONFLICT DO NOTHING`
            : sql`DELETE FROM session_message_reactions WHERE message_id=${id} AND user_id=${actor} AND emoji=${emoji}`,
        );
        break;
      }
      case 'edit': {
        const edited = text(v.text, 4000).trim();
        if (!edited) throw new AppError(400, 'empty_message');
        const updated = await c.execute(
          sql`UPDATE session_message_state SET edited_text=${edited} WHERE id=${id} AND deleted_at IS NULL AND edited_text IS NOT DISTINCT FROM ${v.expected == null ? null : text(v.expected, 4000)} RETURNING id`,
        );
        if (!updated.rows.length) throw new AppError(409, 'message_changed');
        break;
      }
      case 'delete':
        await c.execute(
          sql`UPDATE session_message_state SET edited_text=NULL,deleted_at=coalesce(deleted_at,now()) WHERE id=${id}`,
        );
        break;
      case 'pin':
        if (typeof v.active !== 'boolean') throw new AppError(400, 'invalid_toggle');
        await c.execute(sql`UPDATE session_message_state SET pinned=${v.active} WHERE id=${id}`);
        break;
      case 'save':
      case 'unread':
      case 'follow': {
        if (typeof v.active !== 'boolean') throw new AppError(400, 'invalid_toggle');
        const column = sql.identifier(
          v.action === 'save' ? 'saved_at' : v.action === 'unread' ? 'unread' : 'following',
        );
        const value = v.action === 'save' ? (v.active ? sql`now()` : sql`NULL`) : sql`${v.active}`;
        await c.execute(sql`INSERT INTO session_message_preferences(message_id,user_id,${column}) VALUES(${id},${actor},${value})
          ON CONFLICT(message_id,user_id) DO UPDATE SET ${column}=excluded.${column}`);
        break;
      }
      case 'reply': {
        const key = uuid(v.id),
          body = text(v.text, 4000).trim();
        if (!body) throw new AppError(400, 'empty_reply');
        const inserted = await c.execute(
          sql`INSERT INTO session_message_replies(id,message_id,user_id,body) VALUES(${key},${id},${actor},${body}) ON CONFLICT(id) DO NOTHING RETURNING id`,
        );
        if (
          !(
            await c.execute(
              sql`SELECT 1 FROM session_message_replies WHERE id=${key} AND message_id=${id} AND user_id=${actor} AND body=${body}`,
            )
          ).rows.length
        )
          throw new AppError(409, 'reply_conflict');
        if (!inserted.rows.length) return { ok: true };
        await c.execute(
          sql`INSERT INTO session_message_preferences(message_id,user_id) VALUES (${id},${actor}) ON CONFLICT DO NOTHING`,
        );
        await c.execute(
          sql`INSERT INTO session_message_preferences(message_id,user_id) VALUES (${id},${row.requester_id}) ON CONFLICT DO NOTHING`,
        );
        await c.execute(
          sql`UPDATE session_message_preferences SET unread=true WHERE message_id=${id} AND user_id<>${actor} AND following`,
        );
        break;
      }
      default:
        throw new AppError(400, 'invalid_message_action');
    }
    await c.execute(
      sql`INSERT INTO chat_delivery_outbox(workspace_id,resource_scope,resource_id) VALUES(${row.workspace_id},'thread',${row.origin_thread_id})`,
    );
    if (v.action === 'save' || v.action === 'edit' || v.action === 'delete')
      await c.execute(
        sql`INSERT INTO chat_delivery_outbox(workspace_id,resource_scope) VALUES(${row.workspace_id},'metadata')`,
      );
    return { ok: true };
  });
}
