import { sessionWorkStatus } from './session-work-status.js';
import type { Pool } from 'pg';
import type { StarredAgentSession } from '@space/contracts';
import { sql, type SQL } from 'drizzle-orm';
import { AppError, HUB_FILE_KINDS, chatCursor, parsePage, parseHubTodo, parseHubToggle, parseHubFileQuery, record, uuid, type HubMessage, type HubThread, type HubFile, type HubTodo, type Page } from '@space/contracts';
import { database } from './database.js';
import { requireWorkspaceAccess } from './access.js';
import { page } from './membership.js';
import { sessionTransaction } from './session-concurrency.js';

const missing = () => new AppError(404, 'not_found');
const chronologicalCursor = (row: { id: string; created_at: string }) => Buffer.from(JSON.stringify({ time: row.created_at, id: row.id })).toString('base64url');
function chronologicalPage(input: unknown, threads = false) {
  const v = record(input, ['after', 'limit']);
  const { limit } = parsePage({ limit: v.limit });
  if (v.after === undefined) return { limit, after: undefined };
  try {
    if (typeof v.after !== 'string' || v.after.length > 512 || !/^[A-Za-z0-9_-]+$/.test(v.after)) throw new Error();
    const decoded = Buffer.from(v.after, 'base64url');
    if (decoded.toString('base64url') !== v.after) throw new Error();
    const cursor = record(JSON.parse(decoded.toString('utf8')), threads ? ['time', 'id', 'unread'] : ['time', 'id']);
    if (threads && typeof cursor.unread !== 'boolean') throw new Error();
    if (typeof cursor.time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(cursor.time)
      || !Number.isFinite(Date.parse(cursor.time)) || new Date(cursor.time).toISOString().slice(0, 10) !== cursor.time.slice(0, 10)) throw new Error();
    return { limit, after: { time: cursor.time, id: uuid(cursor.id), unread: cursor.unread === true } };
  } catch { throw new AppError(400, 'invalid_cursor'); }
}

// Keep this predicate in each statement, including writes, so a previous access
// check never becomes an authorization grant for a later statement.
const membership = (actor: string, workspace: string) => sql`EXISTS(SELECT 1 FROM workspace_members wm
  WHERE wm.workspace_id=${workspace} AND wm.user_id=${actor} AND wm.active)`;
const channelAccess = (actor: string, workspace: string) => sql`${membership(actor, workspace)} AND EXISTS(
  SELECT 1 FROM channel_members cm WHERE cm.workspace_id=${workspace} AND cm.channel_id=c.id AND cm.user_id=${actor})`;
const channelName = (actor: string) => sql`CASE WHEN c.kind='direct' THEN coalesce((SELECT u.display_name FROM users u
  WHERE u.id=CASE WHEN c.direct_user_low=${actor} THEN c.direct_user_high ELSE c.direct_user_low END),'Direct message') ELSE c.name END`;

const visibleThread = (actor: string) => sql`NOT EXISTS(SELECT 1 FROM agent_sessions hidden
  WHERE hidden.origin_thread_id=t.id AND hidden.handoff_context IS NOT NULL AND hidden.created_by IS DISTINCT FROM ${actor}::uuid)`;
const sameThread = sql`m.workspace_id=t.workspace_id AND m.channel_id=t.channel_id AND m.thread_id=t.id AND m.agent_session_id IS NULL`;
const liveReply = sql`m.deleted_at IS NULL AND m.retained_at IS NULL`;
const preview = (actor: string) => sql`jsonb_build_object('id',m.id,'channel_id',m.channel_id,'thread_id',m.thread_id,'task_id',m.task_id,
  'client_message_id',m.client_message_id,'agent_response',m.agent_response,'text',m.text,'created_at',m.created_at,'sequence',m.sequence::text,'document',m.document,
  'channel_broadcast_sequence', m.channel_broadcast_sequence::text,'deleted_at',m.deleted_at,'attachments',m.attachments,'viewer_saved',EXISTS(SELECT 1 FROM hub_saved_messages saved
    WHERE saved.message_id=m.id AND saved.workspace_id=m.workspace_id AND saved.user_id=${actor}),
  'reaction_sequence',m.reaction_sequence::text,'reactions',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.emoji) FROM (
    SELECT emoji,count(*)::int AS count,array_agg(user_id ORDER BY user_id) AS user_ids FROM message_reactions
    WHERE channel_id=m.channel_id AND message_id=m.id GROUP BY emoji) r),'[]'::jsonb),
  'author',jsonb_build_object('kind',m.author_type,'image',CASE WHEN m.author_type='human' THEN u.image END,
    'id',coalesce(m.user_id,m.installation_id,m.webhook_id),'name',coalesce(m.webhook_name,m.workflow_name,u.display_name,d.name,'Agent')))`;
const previewAuthor = sql`LEFT JOIN users u ON u.id=m.user_id LEFT JOIN agent_installations i ON i.id=m.installation_id
  LEFT JOIN agent_definitions d ON d.id=i.definition_id`;


const savedSource = (actor:string, workspace:string) => sql`m.workspace_id=${workspace} AND m.deleted_at IS NULL AND m.retained_at IS NULL
  AND m.agent_session_id IS NULL AND m.encrypted IS NULL AND NOT EXISTS(SELECT 1 FROM agent_sessions hidden
    WHERE hidden.origin_thread_id=m.thread_id AND hidden.handoff_context IS NOT NULL AND hidden.created_by IS DISTINCT FROM ${actor}::uuid)`;
const todoSource=(actor:string,workspace:string,channel:SQL,message:SQL)=>sql`(${channel} IS NULL OR EXISTS(SELECT 1 FROM messages m JOIN channels c ON c.workspace_id=m.workspace_id AND c.id=m.channel_id WHERE m.workspace_id=${workspace} AND m.channel_id=${channel} AND m.id=${message} AND m.deleted_at IS NULL AND m.agent_session_id IS NULL AND ${channelAccess(actor,workspace)}))`;
const todoOwner=(actor:string,workspace:string)=>sql`t.workspace_id=${workspace} AND t.user_id=${actor} AND ${membership(actor,workspace)} AND ${todoSource(actor,workspace,sql`t.channel_id`,sql`t.message_id`)}`;
const todoColumns=sql`t.id,t.title,t.completed,t.document,t.archived,t.deleted,t.channel_id,t.message_id,
 (SELECT jsonb_build_object('name',s.name,'external_id',t.external_id,'revision',t.external_revision::text,'url',t.external_url) FROM todo_sync_sources s WHERE s.id=t.external_source_id) AS external,
 to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
 to_char(t.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
 to_char(t.remind_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS remind_at,
 to_char(t.reminder_fired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS reminder_fired_at`;

export class WorkspaceHubStore {
  readonly db;
  constructor(readonly pool: Pool) { this.db = database(pool); }

  async starredSessions(actor: string, workspace: string, input: unknown = {}): Promise<Page<StarredAgentSession>> {
    actor=uuid(actor);workspace=uuid(workspace);
    const {after,limit}=parsePage(input);
    return this.db.transaction(async c=>{
      await requireWorkspaceAccess(c,actor,workspace);
      const result=await c.execute<StarredAgentSession & Record<string,unknown>>(sql`
        SELECT a.id,a.title AS name,'agent_session' AS kind,c.private,
          EXISTS(SELECT 1 FROM tasks WHERE session_id=a.id AND status='running') AS working,
          ${sessionWorkStatus(sql`a.id`,sql`a.state`)} AS status,
          (a.created_by IS NOT DISTINCT FROM ${actor}::uuid OR i.owner_id=${actor}) AS can_rename,
          jsonb_build_object('id',a.id,'agent_name',coalesce(ac.name,d.name),'origin_thread_id',a.origin_thread_id,
            'channel_id',c.id,'channel_archived',c.archived_at IS NOT NULL,'code_channel',a.handoff_context IS NULL) AS session
        FROM hub_starred_agent_sessions star
        JOIN agent_sessions a ON a.workspace_id=star.workspace_id AND a.id=star.session_id
        JOIN threads t ON t.workspace_id=a.workspace_id AND t.id=a.origin_thread_id
        JOIN channels c ON c.workspace_id=t.workspace_id AND c.id=t.channel_id
        JOIN agent_installations i ON i.id=a.installation_id JOIN agent_definitions d ON d.id=i.definition_id LEFT JOIN agent_connections ac ON ac.installation_id=i.id
        WHERE star.workspace_id=${workspace} AND star.user_id=${actor} AND a.managed AND ${channelAccess(actor,workspace)}
          AND NOT EXISTS(SELECT 1 FROM session_sidebar_preferences p WHERE p.workspace_id=a.workspace_id
            AND p.user_id=star.user_id AND p.session_id=a.id AND p.archived)
          ${after?sql`AND a.id>${after}::uuid`:sql``}
        ORDER BY a.id LIMIT ${limit+1}`);
      return page(result.rows,limit,row=>row.id);
    });
  }

  async sessionStarState(actor: string, workspace: string, session: string) {
    actor=uuid(actor);workspace=uuid(workspace);session=uuid(session);
    const result=await this.db.execute<{active:boolean}>(sql`
      SELECT EXISTS(SELECT 1 FROM hub_starred_agent_sessions star WHERE star.workspace_id=${workspace}
        AND star.user_id=${actor} AND star.session_id=a.id) AS active
      FROM agent_sessions a JOIN threads t ON t.workspace_id=a.workspace_id AND t.id=a.origin_thread_id
      JOIN channels c ON c.workspace_id=t.workspace_id AND c.id=t.channel_id
      WHERE a.workspace_id=${workspace} AND a.id=${session} AND a.managed AND ${channelAccess(actor,workspace)}`);
    if(!result.rows[0])throw missing();
    return result.rows[0];
  }

  async starSession(actor: string, workspace: string, session: string, input: unknown) {
    actor=uuid(actor);workspace=uuid(workspace);session=uuid(session);
    const {active}=parseHubToggle(input);
    const visible=sql`SELECT a.id FROM agent_sessions a
      JOIN threads t ON t.workspace_id=a.workspace_id AND t.id=a.origin_thread_id
      JOIN channels c ON c.workspace_id=t.workspace_id AND c.id=t.channel_id
      WHERE a.workspace_id=${workspace} AND a.id=${session} AND a.managed AND ${channelAccess(actor,workspace)}`;
    const mutation=active
      ?sql`INSERT INTO hub_starred_agent_sessions(workspace_id,user_id,session_id) SELECT ${workspace},${actor},id FROM visible ON CONFLICT DO NOTHING`
      :sql`DELETE FROM hub_starred_agent_sessions WHERE workspace_id=${workspace} AND user_id=${actor} AND session_id IN(SELECT id FROM visible)`;
    const result=await this.db.execute(sql`WITH visible AS (${visible}),changed AS (${mutation} RETURNING session_id) SELECT id FROM visible`);
    if(!result.rows.length)throw missing();
    return {active};
  }

  async messages(actor: string, workspace: string, view: 'threads' | 'sent' | 'saved', input: unknown = {}): Promise<Page<HubMessage>> {
    if (view === 'threads') return this.threads(actor, workspace, input);
    actor = uuid(actor); workspace = uuid(workspace);
    const { after, limit } = chronologicalPage(input);
    return this.db.transaction(async c => {
      await requireWorkspaceAccess(c, actor, workspace);
      const saved = view === 'saved';
      const sort = saved ? sql`s.created_at` : sql`m.created_at`;
      const visible = saved ? savedSource(actor,workspace) : sql`m.user_id=${actor} AND m.deleted_at IS NULL`;
      const rows = await c.execute<HubMessage & Record<string, unknown>>(sql`SELECT m.id,m.channel_id,${channelName(actor)} AS channel_name,m.thread_id,m.text,m.document,
        ${saved ? sql`to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS saved_at,
          m.user_id AS author_id,u.image AS author_image,c.kind AS channel_kind,m.attachments->0->>'name' AS file_name,` : sql``}
        coalesce(m.webhook_name,m.workflow_name,u.display_name,d.name,'Agent') AS author_name,to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
        (SELECT count(*)::int FROM messages reply WHERE reply.workspace_id=m.workspace_id AND reply.channel_id=m.channel_id
          AND reply.thread_id=m.thread_id AND reply.id<>m.id AND reply.agent_session_id IS NULL) AS reply_count
        FROM messages m JOIN channels c ON c.workspace_id=m.workspace_id AND c.id=m.channel_id
        ${saved ? sql`JOIN hub_saved_messages s ON s.workspace_id=m.workspace_id AND s.user_id=${actor} AND s.channel_id=m.channel_id AND s.message_id=m.id` : sql``}
        LEFT JOIN users u ON u.id=m.user_id LEFT JOIN agent_installations i ON i.id=m.installation_id LEFT JOIN agent_definitions d ON d.id=i.definition_id
        WHERE m.workspace_id=${workspace} AND m.agent_session_id IS NULL AND ${channelAccess(actor, workspace)} AND ${visible}
          ${after ? sql`AND (${sort},m.id)<(${after.time}::timestamptz,${after.id}::uuid)` : sql``}
        ORDER BY ${sort} DESC,m.id DESC LIMIT ${limit + 1}`);
      return page(rows.rows, limit, row => chronologicalCursor({id:row.id,created_at:row.saved_at ?? row.created_at}));
    });
  }

  async threads(actor: string, workspace: string, input: unknown = {}): Promise<Page<HubThread>> {
    actor = uuid(actor); workspace = uuid(workspace);
    const { limit, after } = chronologicalPage(input, true);
    return this.db.transaction(async db => {
      await requireWorkspaceAccess(db, actor, workspace);
      const rows = await db.execute<HubThread & Record<string, unknown>>(sql`
        WITH candidates AS (
          SELECT t.id AS thread_id,t.channel_id,first_msg.id AS root_id,first_msg.sequence AS root_sequence,
            newest.sequence AS latest_sequence,newest.created_at AS activity_at,coalesce(r.last_read_sequence,0) AS read_through,
            EXISTS(SELECT 1 FROM messages m WHERE ${sameThread} AND ${liveReply}
              AND m.sequence>greatest(first_msg.sequence,coalesce(r.last_read_sequence,0)) AND m.user_id IS DISTINCT FROM ${actor}::uuid) AS unread
          FROM threads t JOIN channels c ON c.workspace_id=t.workspace_id AND c.id=t.channel_id
          JOIN channel_members cm ON cm.workspace_id=c.workspace_id AND cm.channel_id=c.id AND cm.user_id=${actor}
          LEFT JOIN notification_subscriptions s ON s.thread_id=t.id AND s.user_id=cm.user_id
          LEFT JOIN thread_reads r ON r.thread_id=t.id AND r.user_id=cm.user_id
          CROSS JOIN LATERAL (SELECT m.id,m.sequence FROM messages m WHERE ${sameThread} ORDER BY m.sequence LIMIT 1) first_msg
          CROSS JOIN LATERAL (SELECT m.sequence,m.created_at FROM messages m WHERE ${sameThread} AND ${liveReply}
            AND m.sequence>first_msg.sequence ORDER BY m.sequence DESC LIMIT 1) newest
          WHERE t.workspace_id=${workspace} AND ${membership(actor,workspace)} AND ${visibleThread(actor)}
            AND coalesce(s.following,(c.kind='direct' AND c.direct_user_low<>c.direct_user_high) OR cm.follow_every_thread)
        ), picked AS MATERIALIZED (
          SELECT * FROM candidates
          ${after ? sql`WHERE (unread,activity_at,thread_id)<(${after.unread},${after.time}::timestamptz,${after.id}::uuid)` : sql``}
          ORDER BY unread DESC,activity_at DESC,thread_id DESC LIMIT ${limit+1}
        )
        SELECT m.id,t.id AS thread_id,t.channel_id,c.kind AS channel_kind,c.archived_at,c.encrypted_since,p.read_through::text AS read_through,${channelName(actor)} AS channel_name,
          m.text,m.document,m.created_at,root.data->'author'->>'name' AS author_name,root.data AS root,
          (summary.data->>'count')::int AS reply_count,summary.data->'participants' AS participants,
          p.latest_sequence::text,to_char(p.activity_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_activity_at,
          (SELECT count(*)::int FROM messages m WHERE ${sameThread} AND ${liveReply} AND m.sequence>greatest(p.root_sequence,p.read_through)
            AND m.user_id IS DISTINCT FROM ${actor}::uuid) AS unread_count,
          (SELECT jsonb_agg(recent.data ORDER BY recent.sequence) FROM (
            SELECT ${preview(actor)} AS data,m.sequence FROM messages m ${previewAuthor}
            WHERE ${sameThread} AND ${liveReply} AND m.sequence>p.root_sequence ORDER BY m.sequence DESC LIMIT 2
          ) recent) AS recent_replies
        FROM picked p JOIN threads t ON t.id=p.thread_id JOIN channels c ON c.id=t.channel_id
        JOIN messages m ON m.workspace_id=t.workspace_id AND m.channel_id=t.channel_id AND m.id=p.root_id
        ${previewAuthor} CROSS JOIN LATERAL (SELECT ${preview(actor)} AS data) root
        CROSS JOIN LATERAL (SELECT chat_reply_summary(t.workspace_id,t.channel_id,t.id) AS data) summary
        ORDER BY p.unread DESC,p.activity_at DESC,p.thread_id DESC`);
      return page(rows.rows, limit, row => Buffer.from(JSON.stringify({
        unread: row.unread_count > 0, time: row.last_activity_at, id: row.thread_id,
      })).toString('base64url'));
    }, {isolationLevel:'repeatable read',accessMode:'read only'});
  }

  async earlierThreadReplies(actor: string, workspace: string, thread: string, input: unknown) {
    workspace = uuid(workspace); thread = uuid(thread);
    const before = chatCursor(record(input, ['before']).before);
    return this.db.transaction(async db => {
      const { rows } = await db.execute<{ message: HubThread['root'] }>(sql`
        SELECT ${preview(actor)} AS message FROM threads t JOIN channels c ON c.id=t.channel_id
        JOIN messages m ON ${sameThread} ${previewAuthor}
        WHERE t.workspace_id=${workspace} AND t.id=${thread} AND ${channelAccess(actor,workspace)} AND ${visibleThread(actor)}
          AND ${liveReply} AND m.sequence<${before}::bigint
          AND m.sequence>(SELECT min(root.sequence) FROM messages root WHERE root.thread_id=t.id AND root.agent_session_id IS NULL)
        ORDER BY m.sequence DESC LIMIT 50`);
      return {items:rows.map(row=>row.message).reverse()};
    });
  }

  async markThreadUnread(actor: string, workspace: string, thread: string, input: unknown) {
    workspace = uuid(workspace); thread = uuid(thread);
    const sequence = chatCursor(record(input, ['sequence']).sequence);
    return sessionTransaction(this.db, async db => {
      const result = await db.execute(sql`
        INSERT INTO thread_reads(workspace_id,channel_id,thread_id,user_id,last_read_sequence)
          SELECT t.workspace_id,t.channel_id,t.id,${actor},prior.sequence
          FROM threads t JOIN channels c ON c.id=t.channel_id JOIN messages m ON ${sameThread}
          CROSS JOIN LATERAL (SELECT max(p.sequence) AS sequence FROM messages p
            WHERE p.thread_id=t.id AND p.agent_session_id IS NULL AND p.sequence<m.sequence) prior
          WHERE t.workspace_id=${workspace} AND t.id=${thread} AND m.sequence=${sequence}::bigint AND ${liveReply}
            AND prior.sequence IS NOT NULL AND ${channelAccess(actor,workspace)} AND ${visibleThread(actor)}
          ON CONFLICT(thread_id,user_id) DO UPDATE SET last_read_sequence=excluded.last_read_sequence
          RETURNING last_read_sequence::text AS sequence`);
      if (!result.rows.length) throw missing();
      return result.rows[0];
    });
  }

  async readThread(actor: string, workspace: string, thread: string, input: unknown) {
    actor = uuid(actor); workspace = uuid(workspace); thread = uuid(thread);
    const sequence = chatCursor(record(input, ['sequence']).sequence);
    if (sequence === '0') throw new AppError(400, 'invalid_cursor');
    return sessionTransaction(this.db, async db => {
      const {rows:[target]} = await db.execute<{channel_id:string; last_read:string|null; seen:boolean}>(sql`
        SELECT t.channel_id,r.last_read_sequence::text AS last_read,
          EXISTS(SELECT 1 FROM messages m WHERE ${sameThread} AND m.sequence=${sequence}::bigint) AS seen
        FROM threads t JOIN channels c ON c.id=t.channel_id LEFT JOIN thread_reads r ON r.thread_id=t.id AND r.user_id=${actor}
        WHERE t.workspace_id=${workspace} AND t.id=${thread} AND ${channelAccess(actor,workspace)} AND ${visibleThread(actor)}`);
      if (!target) throw missing();
      if (!target.seen) throw new AppError(400, 'invalid_thread_sequence');
      if (BigInt(target.last_read ?? '0') >= BigInt(sequence)) return {sequence: target.last_read!};
      await db.execute(sql`INSERT INTO thread_reads(workspace_id,channel_id,thread_id,user_id,last_read_sequence)
        VALUES(${workspace},${target.channel_id},${thread},${actor},${sequence}::bigint)
        ON CONFLICT(thread_id,user_id) DO UPDATE SET last_read_sequence=excluded.last_read_sequence
        WHERE thread_reads.last_read_sequence<excluded.last_read_sequence`);
      return {sequence};
    });
  }

  async files(actor: string, workspace: string, input: unknown = {}): Promise<Page<HubFile>> {
    actor = uuid(actor); workspace = uuid(workspace);
    const query = parseHubFileQuery(input);
    const { after, limit } = chronologicalPage({ ...(query.after === undefined ? {} : { after: query.after }), limit: query.limit });
    const order = query.sort === 'oldest' ? sql`ASC` : sql`DESC`;
    const sortTime = query.sort === 'recent' ? sql`coalesce(state.last_viewed_at,m.created_at)` : sql`m.created_at`;
    const pattern = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
    return this.db.transaction(async c => {
      await requireWorkspaceAccess(c, actor, workspace);
      const rows = await c.execute<HubFile & { sort_at: string } & Record<string, unknown>>(sql`SELECT a.id,a.channel_id,${channelName(actor)} AS channel_name,a.message_id,
        a.name AS filename,a.type AS content_type,a.size AS byte_size,coalesce(a.preview->>'kind','file') AS preview_kind,
        (SELECT entry->>'description' FROM jsonb_array_elements(m.attachments) entry WHERE entry->>'id'=a.id::text LIMIT 1) AS description,
        a.uploader_id,u.display_name AS uploader_name,coalesce(state.starred,false) AS starred,
        to_char(state.last_viewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_viewed_at,
        to_char(${sortTime} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_at,
        to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at FROM assets a
        JOIN channels c ON c.workspace_id=a.workspace_id AND c.id=a.channel_id
        JOIN messages m ON m.workspace_id=a.workspace_id AND m.channel_id=a.channel_id AND m.id=a.message_id
        JOIN users u ON u.id=a.uploader_id
        LEFT JOIN hub_file_state state ON state.workspace_id=a.workspace_id AND state.asset_id=a.id AND state.user_id=${actor}
        WHERE a.workspace_id=${workspace} AND a.status='ready' AND NOT a.encrypted AND m.agent_session_id IS NULL AND ${channelAccess(actor, workspace)}
          ${query.q ? sql`AND a.name ILIKE ${pattern}` : sql``}
          ${query.kinds.length === HUB_FILE_KINDS.length ? sql`` : !query.kinds.length ? sql`AND false` : sql`AND (CASE WHEN a.preview->>'kind' IN ('image','pdf','text','audio','video') THEN a.preview->>'kind' ELSE 'other' END) IN (${sql.join(query.kinds.map(kind => sql`${kind}`), sql`,`)})`}
          ${query.ownership === 'created' ? sql`AND a.uploader_id=${actor}` : query.ownership === 'shared' ? sql`AND a.uploader_id<>${actor}` : sql``}
          ${query.from ? sql`AND a.uploader_id=${query.from}` : sql``}
          ${query.channel ? sql`AND a.channel_id=${query.channel}` : sql``}
          ${query.since ? sql`AND m.created_at>=${query.since}::timestamptz` : sql``}
          ${query.before ? sql`AND m.created_at<${query.before}::timestamptz` : sql``}
          ${query.starred ? sql`AND state.starred` : sql``}
          ${after ? query.sort === 'oldest' ? sql`AND (${sortTime},a.id)>(${after.time}::timestamptz,${after.id}::uuid)` : sql`AND (${sortTime},a.id)<(${after.time}::timestamptz,${after.id}::uuid)` : sql``}
        ORDER BY ${sortTime} ${order},a.id ${order} LIMIT ${limit + 1}`);
      const result = page(rows.rows, limit, row => chronologicalCursor({ id: row.id, created_at: row.sort_at }));
      return { ...result, items: result.items.map(({ sort_at, description, ...file }) => ({ ...file, ...(description ? { description } : {}) })) };
    });
  }

  async fileState(actor: string, workspace: string, id: string, action: 'star' | 'view', input: unknown) {
    actor = uuid(actor); workspace = uuid(workspace); id = uuid(id);
    const active = action === 'star' ? parseHubToggle(input).active : (record(input, []), false);
    // Update only the requested field: simultaneous starring and viewing must preserve both.
    const update = action === 'star' ? sql`starred=EXCLUDED.starred` : sql`last_viewed_at=greatest(hub_file_state.last_viewed_at,EXCLUDED.last_viewed_at)`;
    const result = await this.db.execute(sql`INSERT INTO hub_file_state(workspace_id,user_id,asset_id,starred,last_viewed_at)
      SELECT a.workspace_id,${actor},a.id,${active},${action === 'view' ? sql`clock_timestamp()` : sql`NULL::timestamptz`}
      FROM assets a JOIN channels c ON c.workspace_id=a.workspace_id AND c.id=a.channel_id
      JOIN messages m ON m.workspace_id=a.workspace_id AND m.channel_id=a.channel_id AND m.id=a.message_id
      WHERE a.workspace_id=${workspace} AND a.id=${id} AND a.status='ready' AND NOT a.encrypted AND m.agent_session_id IS NULL AND ${channelAccess(actor, workspace)}
      ON CONFLICT(workspace_id,user_id,asset_id) DO UPDATE SET ${update}
      RETURNING starred,to_json(last_viewed_at)#>>'{}' AS last_viewed_at`);
    if (!result.rows[0]) throw missing();
    return result.rows[0];
  }

  async todos(actor: string, workspace: string, input: unknown = {}): Promise<Page<HubTodo>> {
    actor = uuid(actor); workspace = uuid(workspace);
    const v = record(input, ['after','limit','status','reminder','sort','archived']);
    const {limit}=parsePage({limit:v.limit});
    const choice=(key:string, values:string[], fallback:string) => {const value=v[key]??fallback;if(typeof value!=='string'||!values.includes(value))throw new AppError(400,`invalid_${key}`);return value;};
    const status=choice('status',['all','open','completed'],'all'), reminder=choice('reminder',['all','overdue','upcoming','none'],'all'), sort=choice('sort',['due','oldest','newest'],'due'), archived=choice('archived',['true','false'],'false')==='true';
    let after: {id:string; time:string|null}|undefined;
    if(v.after!==undefined) {
      try {
        if(typeof v.after!=='string'||v.after.length>512||!/^[A-Za-z0-9_-]+$/.test(v.after))throw new Error();
        const decoded=Buffer.from(v.after,'base64url');if(decoded.toString('base64url')!==v.after)throw new Error();
        const cursor=record(JSON.parse(decoded.toString()),['id','time','sort']);if(cursor.sort!==sort)throw new Error();
        if(cursor.time!==null) chronologicalPage({after:Buffer.from(JSON.stringify({id:cursor.id,time:cursor.time})).toString('base64url')});
        else if(sort!=='due')throw new Error();
        after={id:uuid(cursor.id),time:cursor.time as string|null};
      } catch {throw new AppError(400,'invalid_cursor');}
    }
    const order=sort==='due'?sql`t.remind_at ASC NULLS LAST,t.id ASC`:sort==='oldest'?sql`t.created_at ASC,t.id ASC`:sql`t.created_at DESC,t.id DESC`;
    const boundary=!after?sql`true`:sort==='due'?(after.time===null?sql`t.remind_at IS NULL AND t.id>${after.id}::uuid`:sql`(t.remind_at,t.id)>(${after.time}::timestamptz,${after.id}::uuid) OR t.remind_at IS NULL`):sort==='oldest'?sql`(t.created_at,t.id)>(${after.time}::timestamptz,${after.id}::uuid)`:sql`(t.created_at,t.id)<(${after.time}::timestamptz,${after.id}::uuid)`;
    return this.db.transaction(async c=>{
      await requireWorkspaceAccess(c,actor,workspace);
      const rows=await c.execute<HubTodo & Record<string,unknown>>(sql`SELECT ${todoColumns} FROM hub_todos t WHERE ${todoOwner(actor,workspace)} AND NOT t.deleted AND t.archived=${archived}
        AND (${boundary}) ${status==='all'?sql``:sql`AND t.completed=${status==='completed'}`}
        ${reminder==='none'?sql`AND t.remind_at IS NULL`:reminder==='overdue'?sql`AND t.remind_at<now() AND NOT t.completed`:reminder==='upcoming'?sql`AND t.remind_at>=now() AND NOT t.completed`:sql``}
        ORDER BY ${order} LIMIT ${limit+1}`);
      return page(rows.rows,limit,row=>Buffer.from(JSON.stringify({id:row.id,time:sort==='due'?row.remind_at:row.created_at,sort})).toString('base64url'));
    });
  }

  async todoDetail(actor:string,workspace:string,id:string):Promise<HubTodo> {
    actor=uuid(actor);workspace=uuid(workspace);id=uuid(id);
    const rows=await this.db.execute<HubTodo & Record<string,unknown>>(sql`SELECT ${todoColumns} FROM hub_todos t WHERE t.id=${id} AND ${todoOwner(actor,workspace)} AND NOT t.deleted`);
    if(!rows.rows[0])throw missing();return rows.rows[0];
  }

  async todo(actor: string, workspace: string, id: string, input: unknown): Promise<HubTodo> {
    actor=uuid(actor);workspace=uuid(workspace);id=uuid(id);
    const request=parseHubTodo(input), {create_only,expected_updated_at}=request;
    const fields=['title','completed','document','remind_at','archived','deleted'] as const;
    const keys=fields.filter(key=>request[key]!==undefined);
    const value=(key:typeof fields[number])=>key==='document'&&request.document!==null?sql`${JSON.stringify(request.document)}::jsonb`:key==='remind_at'?sql`${request.remind_at}::timestamptz`:sql`${request[key]}`;
    const changed=keys.length?sql`(${sql.join(keys.map(key=>sql`t.${sql.identifier(key)}`),sql`,` )}) IS DISTINCT FROM (${sql.join(keys.map(value),sql`,`)})`:sql`false`;
    const assignments=keys.map(key=>sql`${sql.identifier(key)}=${value(key)}`);
    assignments.push(sql`updated_at=CASE WHEN ${changed} THEN greatest(clock_timestamp(),t.updated_at+interval '1 microsecond') ELSE t.updated_at END`);
    const source=request.channel_id?sql`AND t.channel_id=${request.channel_id} AND t.message_id=${request.message_id}`:sql``;
    return this.db.transaction(async c=>{
      await requireWorkspaceAccess(c,actor,workspace);
      // Creation is idempotent; a retry never substitutes stale fields into a later edit.
      if(request.title!==undefined && expected_updated_at===undefined) {
        const inserted=await c.execute<HubTodo & Record<string,unknown>>(sql`INSERT INTO hub_todos AS t(id,workspace_id,user_id,title,completed,document,remind_at,archived,deleted,channel_id,message_id)
          SELECT ${id},${workspace},${actor},${request.title},${request.completed??false},${request.document?JSON.stringify(request.document):null}::jsonb,${request.remind_at??null}::timestamptz,${request.archived??false},${request.deleted??false},${request.channel_id??null},${request.message_id??null}
          WHERE ${membership(actor,workspace)} AND ${todoSource(actor,workspace,sql`${request.channel_id??null}::uuid`,sql`${request.message_id??null}::uuid`)} ON CONFLICT(id) DO NOTHING RETURNING ${todoColumns}`);
        if(inserted.rows[0])return inserted.rows[0];
      }
      if(create_only) {
        const existing=await c.execute<HubTodo & Record<string,unknown>>(sql`SELECT ${todoColumns} FROM hub_todos t WHERE t.id=${id} AND ${todoOwner(actor,workspace)} ${source}`);
        if(!existing.rows[0])throw missing();return existing.rows[0];
      }
      const rows=await c.execute<HubTodo & Record<string,unknown>>(sql`UPDATE hub_todos t SET ${sql.join(assignments,sql`,`)} WHERE t.id=${id} AND ${todoOwner(actor,workspace)} ${source}
        ${expected_updated_at?sql`AND t.updated_at=${expected_updated_at}::timestamptz`:sql``} RETURNING ${todoColumns}`);
      if(rows.rows[0])return rows.rows[0];
      if(expected_updated_at) {
        // A response may be lost after commit. A matching replay acknowledges the
        // current row without writing, retaining any unrelated concurrent edits.
        const current=await c.execute<HubTodo & {changed:boolean} & Record<string,unknown>>(sql`SELECT ${todoColumns},${changed} AS changed FROM hub_todos t WHERE t.id=${id} AND ${todoOwner(actor,workspace)} ${source}`);
        if(current.rows[0]) {
          const {changed:differs,...item}=current.rows[0];
          if(!differs)return item;
          throw new AppError(409,'todo_conflict');
        }
      }
      throw missing();
    });
  }

  async cleanupTodos(actor:string,workspace:string,input:unknown):Promise<Page<HubTodo>> {
    actor=uuid(actor);workspace=uuid(workspace);
    const v=record(input,['action','scope','after']);
    if(typeof v.action!=='string'||!['complete','archive','delete','remove_deleted'].includes(v.action))throw new AppError(400,'invalid_action');
    if(typeof v.scope!=='string'||!['all','completed','overdue','overdue30'].includes(v.scope))throw new AppError(400,'invalid_scope');
    if(v.action==='remove_deleted' && v.scope!=='all')throw new AppError(400,'invalid_scope');
    const after=v.after===undefined?undefined:uuid(v.after);
    const key=v.action==='complete'?'completed':v.action==='archive'?'archived':'deleted';
    const scope=v.scope==='completed'?sql`t.completed`:v.scope==='overdue'?sql`NOT t.completed AND t.remind_at<now()`:v.scope==='overdue30'?sql`NOT t.completed AND t.remind_at<now()-interval '30 days'`:sql`true`;
    // Missing source cleanup authorizes only the personal row. Missing access
    // is not evidence of source deletion, so check existence without membership.
    const owner=v.action==='remove_deleted'
      ? sql`t.workspace_id=${workspace} AND t.user_id=${actor} AND ${membership(actor,workspace)} AND t.message_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.workspace_id=t.workspace_id AND m.channel_id=t.channel_id AND m.id=t.message_id AND m.deleted_at IS NULL)`
      : todoOwner(actor,workspace);
    const eligible=sql`${owner} AND NOT t.deleted AND NOT t.archived AND NOT t.${sql.identifier(key)} AND ${scope} ${after?sql`AND t.id>${after}::uuid`:sql``}`;
    return this.db.transaction(async c=>{
      await requireWorkspaceAccess(c,actor,workspace);
      const rows=await c.execute<HubTodo & Record<string,unknown>>(sql`WITH candidates AS (SELECT t.id FROM hub_todos t WHERE ${eligible} ORDER BY t.id LIMIT 241), changed AS (
        UPDATE hub_todos t SET ${sql.identifier(key)}=true,updated_at=greatest(clock_timestamp(),t.updated_at+interval '1 microsecond') WHERE t.id IN(SELECT id FROM candidates ORDER BY id LIMIT 240) AND ${eligible} RETURNING ${todoColumns}
      ) SELECT changed.*,EXISTS(SELECT 1 FROM candidates OFFSET 240) AS has_more FROM changed ORDER BY id`);
      const items=rows.rows.map(({has_more,...item})=>(v.action==='remove_deleted'
        ? {...item,title:'Deleted message',document:null,channel_id:null,message_id:null}
        : item) as unknown as HubTodo);
      return {items,next_cursor:rows.rows[0]?.has_more&&items.length?items[items.length-1]!.id:null};
    });
  }

  async savedState(actor:string, workspace:string, channel:string, input:unknown) {
    const {ids}=record(input,['ids']);
    if (!Array.isArray(ids) || ids.length>500) throw new AppError(400,'invalid_message_ids');
    const keys=ids.map(id=>uuid(id));
    const rows=await this.db.execute<{message_id:string}>(sql`SELECT s.message_id FROM hub_saved_messages s
      JOIN messages m ON m.channel_id=s.channel_id AND m.id=s.message_id JOIN channels c ON c.id=s.channel_id
      WHERE s.workspace_id=${workspace} AND s.user_id=${actor} AND s.channel_id=${channel} AND s.message_id=ANY(${sql.param(keys)}::uuid[])
        AND ${channelAccess(actor,workspace)} AND ${savedSource(actor,workspace)}`);
    return {ids:rows.rows.map(row=>row.message_id)};
  }

  // DELETE RETURNING hands each bookmark to at most one concurrent mover. The todo
  // and removal commit together, so retrying after a lost response cannot duplicate it.
  async cleanupSaved(actor:string, workspace:string, input:unknown) {
    const {action,message_id,before}=record(input,['action','message_id','before']);
    if(action!=='clear' && action!=='move') throw new AppError(400,'invalid_saved_action');
    const id=message_id===undefined?undefined:uuid(message_id);
    if(before!==undefined && (typeof before!=='string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(before) || !Number.isFinite(Date.parse(before)))) throw new AppError(400,'invalid_cursor');
    return this.db.transaction(async db=>{
      await requireWorkspaceAccess(db,actor,workspace);
      const cutoff=sql`least(now(),coalesce(${before??null}::timestamptz,now()))`;
      const result=await db.execute<{count:number; before:string}>(sql`WITH candidates AS MATERIALIZED (
        SELECT s.channel_id,s.message_id,s.created_at,m.text,m.document,m.attachments FROM hub_saved_messages s
        JOIN messages m ON m.channel_id=s.channel_id AND m.id=s.message_id JOIN channels c ON c.id=s.channel_id
        WHERE s.workspace_id=${workspace} AND s.user_id=${actor} AND s.created_at<=${cutoff}
          AND ${channelAccess(actor,workspace)} AND ${savedSource(actor,workspace)}
          ${id?sql`AND s.message_id=${id}`:sql``}
        ORDER BY s.created_at DESC,s.message_id DESC LIMIT 100
      ), removed AS (
        DELETE FROM hub_saved_messages s USING candidates p WHERE s.workspace_id=${workspace} AND s.user_id=${actor}
          AND s.message_id=p.message_id AND s.created_at=p.created_at RETURNING s.message_id
      ) ${action==='move'?sql`, moved AS (
        INSERT INTO hub_todos(id,workspace_id,user_id,title,document,channel_id,message_id)
        SELECT gen_random_uuid(),${workspace},${actor},left(coalesce(nullif(trim(p.text),''),p.attachments->0->>'name','Shared message'),500),
          p.document,p.channel_id,p.message_id FROM candidates p JOIN removed USING(message_id)
      )`:sql``}
      SELECT count(*)::int AS count,to_char(${cutoff} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS before FROM removed`);
      return result.rows[0]!;
    });
  }

  async saved(actor: string, workspace: string, message: string, input: unknown) {
    actor = uuid(actor); workspace = uuid(workspace); message = uuid(message);
    const v = record(input, ['channel_id', 'active']), channel = uuid(v.channel_id), { active } = parseHubToggle({ active: v.active });
    const visible = sql`SELECT m.id FROM messages m JOIN channels c ON c.id=m.channel_id AND c.workspace_id=m.workspace_id
      WHERE m.workspace_id=${workspace} AND m.channel_id=${channel} AND m.id=${message} AND ${savedSource(actor,workspace)} AND ${channelAccess(actor, workspace)}`;
    const mutation = active
      ? sql`INSERT INTO hub_saved_messages(workspace_id,user_id,channel_id,message_id)
          SELECT ${workspace},${actor},${channel},id FROM visible ON CONFLICT DO NOTHING`
      : sql`DELETE FROM hub_saved_messages WHERE workspace_id=${workspace} AND user_id=${actor} AND channel_id=${channel} AND message_id IN (SELECT id FROM visible)`;
    const rows = await this.db.execute(sql`WITH visible AS (${visible}), changed AS (${mutation} RETURNING message_id) SELECT id FROM visible`);
    if (!rows.rows.length) throw missing();
    return { active };
  }

  async starred(actor: string, workspace: string, input: unknown = {}): Promise<Page<{ id: string; name: string; kind: string; private: boolean }>> {
    actor = uuid(actor); workspace = uuid(workspace);
    const { after, limit } = parsePage(input);
    return this.db.transaction(async c => {
      await requireWorkspaceAccess(c, actor, workspace);
      const rows = await c.execute<{ id: string; name: string; kind: string; private: boolean }>(sql`SELECT c.id,${channelName(actor)} AS name,c.kind,c.private FROM hub_starred_channels starred
        JOIN channels c ON c.workspace_id=starred.workspace_id AND c.id=starred.channel_id
        WHERE starred.workspace_id=${workspace} AND starred.user_id=${actor} AND ${channelAccess(actor, workspace)}
          ${after ? sql`AND c.id>${after}::uuid` : sql``} ORDER BY c.id LIMIT ${limit + 1}`);
      return page(rows.rows, limit, row => row.id);
    });
  }

  async starState(actor:string,workspace:string,channel:string) {
    actor=uuid(actor);workspace=uuid(workspace);channel=uuid(channel);
    const rows=await this.db.execute<{active:boolean}>(sql`SELECT EXISTS(SELECT 1 FROM hub_starred_channels star WHERE star.workspace_id=${workspace} AND star.user_id=${actor} AND star.channel_id=c.id) AS active FROM channels c WHERE c.workspace_id=${workspace} AND c.id=${channel} AND ${channelAccess(actor,workspace)}`);
    if(!rows.rows[0])throw missing();
    return rows.rows[0];
  }

  async star(actor: string, workspace: string, channel: string, input: unknown) {
    actor = uuid(actor); workspace = uuid(workspace); channel = uuid(channel);
    const { active } = parseHubToggle(input);
    const visible = sql`SELECT c.id FROM channels c WHERE c.workspace_id=${workspace} AND c.id=${channel} AND ${channelAccess(actor, workspace)}`;
    const mutation = active
      ? sql`INSERT INTO hub_starred_channels(workspace_id,user_id,channel_id) SELECT ${workspace},${actor},id FROM visible ON CONFLICT DO NOTHING`
      : sql`DELETE FROM hub_starred_channels WHERE workspace_id=${workspace} AND user_id=${actor} AND channel_id IN (SELECT id FROM visible)`;
    const rows = await this.db.execute(sql`WITH visible AS (${visible}), changed AS (${mutation} RETURNING channel_id) SELECT id FROM visible`);
    if (!rows.rows.length) throw missing();
    return { active };
  }
}
