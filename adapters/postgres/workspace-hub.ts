import { sessionWorkStatus } from './session-work-status.js';
import type { Pool } from 'pg';
import type { StarredAgentSession } from '@space/contracts';
import { sql, type SQL } from 'drizzle-orm';
import { AppError, HUB_FILE_KINDS, parsePage, parseHubTodo, parseHubToggle, parseHubFileQuery, record, uuid, type HubMessage, type HubFile, type HubTodo, type Page } from '@space/contracts';
import { database } from './database.js';
import { requireWorkspaceAccess } from './access.js';
import { page } from './membership.js';

const missing = () => new AppError(404, 'not_found');
const chronologicalCursor = (row: { id: string; created_at: string }) => Buffer.from(JSON.stringify({ time: row.created_at, id: row.id })).toString('base64url');
function chronologicalPage(input: unknown) {
  const v = record(input, ['after', 'limit']);
  const { limit } = parsePage({ limit: v.limit });
  if (v.after === undefined) return { limit, after: undefined };
  try {
    if (typeof v.after !== 'string' || v.after.length > 512 || !/^[A-Za-z0-9_-]+$/.test(v.after)) throw new Error();
    const decoded = Buffer.from(v.after, 'base64url');
    if (decoded.toString('base64url') !== v.after) throw new Error();
    const cursor = record(JSON.parse(decoded.toString('utf8')), ['time', 'id']);
    if (typeof cursor.time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(cursor.time)
      || !Number.isFinite(Date.parse(cursor.time)) || new Date(cursor.time).toISOString().slice(0, 10) !== cursor.time.slice(0, 10)) throw new Error();
    return { limit, after: { time: cursor.time, id: uuid(cursor.id) } };
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
            'channel_id',c.id,'channel_archived',c.archived_at IS NOT NULL) AS session
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
    actor = uuid(actor); workspace = uuid(workspace);
    const { after, limit } = chronologicalPage(input);
    return this.db.transaction(async c => {
      await requireWorkspaceAccess(c, actor, workspace);
      let scope: SQL;
      if (view === 'sent') scope = sql`m.user_id=${actor} AND m.deleted_at IS NULL`;
      else if (view === 'saved') scope = sql`EXISTS(SELECT 1 FROM hub_saved_messages saved
        WHERE saved.workspace_id=${workspace} AND saved.user_id=${actor} AND saved.message_id=m.id AND saved.channel_id=m.channel_id)`;
      else scope = sql`NOT EXISTS(SELECT 1 FROM messages earlier WHERE earlier.workspace_id=m.workspace_id
          AND earlier.channel_id=m.channel_id AND earlier.thread_id=m.thread_id AND earlier.sequence<m.sequence AND earlier.agent_session_id IS NULL)
        AND EXISTS(SELECT 1 FROM messages reply WHERE reply.workspace_id=m.workspace_id AND reply.channel_id=m.channel_id
          AND reply.thread_id=m.thread_id AND reply.sequence>m.sequence AND reply.agent_session_id IS NULL)
        AND (m.user_id=${actor} OR EXISTS(SELECT 1 FROM messages participant WHERE participant.workspace_id=m.workspace_id
          AND participant.channel_id=m.channel_id AND participant.thread_id=m.thread_id AND participant.user_id=${actor} AND participant.agent_session_id IS NULL)
          OR EXISTS(SELECT 1 FROM notification_subscriptions followed WHERE followed.thread_id=m.thread_id AND followed.user_id=${actor} AND followed.following))`;
      const rows = await c.execute<HubMessage & Record<string, unknown>>(sql`SELECT m.id,m.channel_id,${channelName(actor)} AS channel_name,m.thread_id,m.text,m.document,
        coalesce(u.display_name,d.name,'Agent') AS author_name,to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
        (SELECT count(*)::int FROM messages reply WHERE reply.workspace_id=m.workspace_id AND reply.channel_id=m.channel_id
          AND reply.thread_id=m.thread_id AND reply.id<>m.id AND reply.agent_session_id IS NULL) AS reply_count
        FROM messages m JOIN channels c ON c.workspace_id=m.workspace_id AND c.id=m.channel_id
        LEFT JOIN users u ON u.id=m.user_id LEFT JOIN agent_installations i ON i.id=m.installation_id LEFT JOIN agent_definitions d ON d.id=i.definition_id
        WHERE m.workspace_id=${workspace} AND m.agent_session_id IS NULL AND ${channelAccess(actor, workspace)} AND ${scope}
          ${after ? sql`AND (m.created_at,m.id)<(${after.time}::timestamptz,${after.id}::uuid)` : sql``}
        ORDER BY m.created_at DESC,m.id DESC LIMIT ${limit + 1}`);
      return page(rows.rows, limit, chronologicalCursor);
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
        WHERE a.workspace_id=${workspace} AND a.status='ready' AND m.agent_session_id IS NULL AND ${channelAccess(actor, workspace)}
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
      WHERE a.workspace_id=${workspace} AND a.id=${id} AND a.status='ready' AND m.agent_session_id IS NULL AND ${channelAccess(actor, workspace)}
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

  async saved(actor: string, workspace: string, message: string, input: unknown) {
    actor = uuid(actor); workspace = uuid(workspace); message = uuid(message);
    const v = record(input, ['channel_id', 'active']), channel = uuid(v.channel_id), { active } = parseHubToggle({ active: v.active });
    const visible = sql`SELECT m.id FROM messages m JOIN channels c ON c.id=m.channel_id AND c.workspace_id=m.workspace_id
      WHERE m.workspace_id=${workspace} AND m.channel_id=${channel} AND m.id=${message} AND m.deleted_at IS NULL AND m.agent_session_id IS NULL AND ${channelAccess(actor, workspace)}`;
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
