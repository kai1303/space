import { readSessionResources } from './session-resources.js';
import { sessionWorkStatus } from './session-work-status.js';
import { discoverSessions } from './session-discovery.js';
import { directTurnTarget, runTurn, type TurnPlan } from './direct-turn-admission.js';
import { SessionTeamStore } from './session-team.js';
import { SidekickStore } from './sidekick.js';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { and, eq, sql } from 'drizzle-orm';
import { isLocalAgentSkill, supportsModelSettings, isLegacyCodexSetting, type CodexSettings, AppError, parseAgentSessionInput, parseAgentSessionMessage, parseAgentResponse, record, text, uuid, type SessionRelatedAgent, type AgentSessionDetail, type AgentSessionSummary, type WorkspaceAgentSession, type AgentSessionTurn, type SessionInput, type Task } from '@space/contracts';
import { database, type DbSession } from './database.js';
import { hasChannelAccess, hasThreadAccess, requireWorkspaceAccess } from './access.js';
import { sessionSidebarActivity } from './session-sidebar-activity.js';
import { sessionTransaction, SessionConflict } from './session-concurrency.js';
import {sessionToolApprovals} from './tool-approvals.js';
import { PostgresStore } from './store.js';
import * as s from './schema.js';
const notFound = () => new AppError(404, 'not_found');
const summaryColumns = sql`a.id,a.workspace_id,a.installation_id,a.origin_thread_id,a.title,a.state,a.queue_paused,a.managed,a.created_by,a.created_at::text,coalesce(ac.name,d.name) AS agent_name,i.owner_id,
  (a.managed AND a.handoff_context IS NULL) AS code_channel,
  (a.managed AND i.connector_id IN ('codex.local','claude.local')) AS supports_steering,
  CASE WHEN a.managed THEN a.skill ELSE coalesce((SELECT skill FROM tasks WHERE session_id=a.id ORDER BY created_at,id LIMIT 1),a.skill) END AS skill,
  (SELECT count(*)::integer FROM tasks WHERE session_id=a.id) AS turn_count`;

// Unmoved sessions retain their creation-time/UUID order. Moved rows share
// the target's anchor and have an exact numeric position on either side of it.
const sidebarKey = sql`coalesce(p.anchor_time,a.created_at),coalesce(p.anchor_id,a.id),coalesce(p.position,0),a.id`;
const sidebarJoin = (actor: string) => sql`LEFT JOIN session_sidebar_preferences p
  ON p.workspace_id=a.workspace_id AND p.user_id=${actor} AND p.session_id=a.id`;

export class AgentSessionStore {
  readonly db; readonly tasks; readonly sidekicks; readonly team;
  constructor(readonly pool: Pool, tasks = new PostgresStore(pool)) { this.db = database(pool); this.tasks = tasks; this.sidekicks = new SidekickStore(this.db); this.team = new SessionTeamStore(this.db); }
  private async visible(c: DbSession, actor: string, id: string) {
    const [session] = await c.select().from(s.agentSessions).where(eq(s.agentSessions.id, uuid(id)));
    if (!session || !await hasThreadAccess(c, actor, session.origin_thread_id)) throw notFound();
    return session;
  }
  async resources(actor: string, id: string, query: unknown) {
    return this.db.transaction(async c => {
      const session = await this.visible(c, actor, id);
      if (!session.managed || session.handoff_context) throw notFound();
      return readSessionResources(c, session, query);
    }, {isolationLevel:'repeatable read', accessMode:'read only'});
  }
  async models(actor:string, id:string) {
    return this.db.transaction(async c => {
      const session = await this.visible(c,actor,id);
      return await this.connectedModels(c,session.installation_id) ?? [];
    }, {isolationLevel:'repeatable read', accessMode:'read only'});
  }
  private async connectedModels(c:DbSession, installation:string) {
    const [connection] = await c.select({models:s.agentConnections.model_catalog}).from(s.agentConnections)
      .where(and(eq(s.agentConnections.installation_id,installation),sql`auth_status='ready' AND connection_id IS NOT NULL AND revoked_at IS NULL AND last_seen_at > now()-interval '45 seconds'`));
    return connection?.models;
  }
  private async validateSelection(c:DbSession, installation:string, skill:string, settings?:CodexSettings) {
    if (!settings) return;
    const catalog = await this.connectedModels(c,installation);
    if (!catalog) {
      // Existing clients can still send their original Codex settings to an older connector.
      if (skill === 'codex.run' && isLegacyCodexSetting(settings)) return;
      throw new AppError(409,'model_selection_unavailable');
    }
    if (!supportsModelSettings(catalog,settings)) throw new AppError(409,'model_selection_unavailable');
  }
  async location(actor: string, id: string) {
    return this.db.transaction(async c => {
      const session = await this.visible(c, actor, id);
      const { rows: [location] } = await c.execute<{ channel_id:string; channel_archived:boolean; agent_name:string }>(sql`
        SELECT ch.id AS channel_id, ch.archived_at IS NOT NULL AS channel_archived, coalesce(ac.name,d.name) AS agent_name
        FROM threads t JOIN channels ch ON ch.id=t.channel_id
        JOIN agent_installations i ON i.id=${session.installation_id}
        JOIN agent_definitions d ON d.id=i.definition_id LEFT JOIN agent_connections ac ON ac.installation_id=i.id WHERE t.id=${session.origin_thread_id}`);
      if (!location) throw notFound();
      return { id:session.id, workspace_id:session.workspace_id, origin_thread_id:session.origin_thread_id, ...location };
    }, {isolationLevel:'repeatable read', accessMode:'read only'});
  }
  private async summary(c: DbSession, id: string): Promise<AgentSessionSummary> {
    const result = await c.execute<AgentSessionSummary & Record<string, unknown>>(sql`SELECT ${summaryColumns} FROM agent_sessions a JOIN agent_installations i ON i.id=a.installation_id JOIN agent_definitions d ON d.id=i.definition_id LEFT JOIN agent_connections ac ON ac.installation_id=i.id WHERE a.id=${id}`);
    const row = result.rows[0];
    if (!row) throw notFound();
    return { ...row, created_at: new Date(row.created_at).toISOString() };
  }
  async list(actor: string, threadId: string): Promise<{ items: AgentSessionSummary[]; next_cursor: null }> {
    return this.db.transaction(async c => {
      if (!await hasThreadAccess(c, actor, uuid(threadId))) throw notFound();
      const result = await c.execute<AgentSessionSummary & Record<string, unknown>>(sql`SELECT ${summaryColumns} FROM agent_sessions a JOIN agent_installations i ON i.id=a.installation_id JOIN agent_definitions d ON d.id=i.definition_id LEFT JOIN agent_connections ac ON ac.installation_id=i.id WHERE a.origin_thread_id=${threadId} ORDER BY a.created_at DESC,a.id DESC LIMIT 100`);
      return { items: result.rows.map(row => ({ ...row, created_at: new Date(row.created_at).toISOString() })), next_cursor: null };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
  discover(actor: string, workspace: string, query: unknown) {
    return discoverSessions(this.db, actor, workspace, query);
  }
  async listWorkspace(actor: string, workspace: string, raw: unknown = {}) {
    const input = record(raw, ['before','archived']), before = input.before === undefined ? undefined : uuid(input.before);
    if (input.archived !== undefined && input.archived !== 'true' && input.archived !== 'false') throw new AppError(400,'invalid_archive_filter');
    return this.db.transaction(async c => {
      await requireWorkspaceAccess(c, actor, workspace);
      if (before) {
        const cursor = await this.visible(c, actor, before);
        if (cursor.workspace_id !== workspace || !cursor.managed) throw notFound();
      }
      const result = await c.execute<WorkspaceAgentSession & Record<string, unknown>>(sql`
        SELECT ${summaryColumns},EXISTS(SELECT 1 FROM tasks WHERE session_id=a.id AND status='running') AS working,
          ${sessionWorkStatus(sql`a.id`,sql`a.state`)} AS status,
          t.channel_id,ch.archived_at IS NOT NULL AS channel_archived, idle.expires::text AS sidebar_expires_at,
          extract(epoch FROM (idle.expires - now()))*1000 AS expires_in_ms
        FROM agent_sessions a JOIN threads t ON t.id=a.origin_thread_id
        JOIN channels ch ON ch.id=t.channel_id
        JOIN channel_members m ON m.channel_id=t.channel_id AND m.workspace_id=a.workspace_id AND m.user_id=${actor}
        JOIN agent_installations i ON i.id=a.installation_id JOIN agent_definitions d ON d.id=i.definition_id LEFT JOIN agent_connections ac ON ac.installation_id=i.id
        ${sidebarJoin(actor)}
        ${sessionSidebarActivity}
        WHERE a.workspace_id=${workspace} AND a.managed AND coalesce(p.archived,false)=${input.archived === 'true'} AND (idle.expires IS NULL OR idle.expires > now())
        ${before ? sql`AND (${sidebarKey})<(SELECT ${sidebarKey} FROM agent_sessions a ${sidebarJoin(actor)} WHERE a.id=${before})` : sql``}
        ORDER BY coalesce(p.anchor_time,a.created_at) DESC,coalesce(p.anchor_id,a.id) DESC,coalesce(p.position,0) DESC,a.id DESC LIMIT 21`);
      return { items: result.rows.slice(0,20).map(({expires_in_ms,sidebar_expires_at,...row}) => ({...row,
        ...(sidebar_expires_at ? {sidebar_expires_at:new Date(sidebar_expires_at).toISOString(),sidebar_expires_in_ms: Math.ceil(Number(expires_in_ms))} : {}),
        created_at:new Date(row.created_at).toISOString()})), next_cursor: result.rows.length > 20 ? result.rows[19]!.id : null };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
  async updateSidebar(actor: string, id: string, raw: unknown) {
    const input = record(raw, ['archived','target','side']);
    const archive = input.archived;
    const move = archive === undefined;
    if (move ? !['before','after'].includes(String(input.side)) : typeof archive !== 'boolean' || input.target !== undefined || input.side !== undefined)
      throw new AppError(400,'invalid_sidebar_action');
    const targetId = move ? uuid(input.target) : undefined;
    if (targetId === id) throw new AppError(400,'invalid_sidebar_target');
    return sessionTransaction(this.db, async c => {
      const session = await this.visible(c,actor,id);
      if (!session.managed) throw notFound();
      const workspace = session.workspace_id;
      if (!move) {
        await c.execute(sql`INSERT INTO session_sidebar_preferences(workspace_id,user_id,session_id,archived)
          VALUES(${workspace},${actor},${id},${archive})
          ON CONFLICT(workspace_id,user_id,session_id) DO UPDATE SET archived=excluded.archived`);
      } else {
        const target = await this.visible(c,actor,targetId!);
        if (!target.managed || target.workspace_id !== workspace) throw notFound();
        const before = input.side === 'before';
        const result = await c.execute(sql`WITH anchor AS (
          SELECT coalesce(p.anchor_time,a.created_at) AS time,coalesce(p.anchor_id,a.id) AS id,coalesce(p.position,0) AS position
          FROM agent_sessions a ${sidebarJoin(actor)} WHERE a.id=${targetId} AND NOT coalesce(p.archived,false)
        ), placement AS (
          SELECT anchor.*, (SELECT ${before ? sql`min(n)` : sql`max(n)`} FROM (
            SELECT position AS n FROM session_sidebar_preferences WHERE workspace_id=${workspace} AND user_id=${actor}
              AND anchor_id=anchor.id AND session_id<>${id}
            UNION ALL SELECT 0
          ) neighbors WHERE n ${before ? sql`>` : sql`<`} anchor.position) AS neighbor FROM anchor
        )
        INSERT INTO session_sidebar_preferences(workspace_id,user_id,session_id,anchor_time,anchor_id,position)
          SELECT ${workspace},${actor},${id},time,id,coalesce((position+neighbor)*0.5,position+${before ? 1 : -1}::numeric)
          FROM placement
        ON CONFLICT(workspace_id,user_id,session_id) DO UPDATE SET anchor_time=excluded.anchor_time,
          anchor_id=excluded.anchor_id,position=excluded.position WHERE NOT session_sidebar_preferences.archived
        RETURNING session_id`);
        if (!result.rows.length) throw new AppError(409,'session_list_changed');
      }
      return {ok:true};
    });
  }
  async create(actor: string, threadId: string, raw: unknown): Promise<AgentSessionSummary> {
    const input = parseAgentSessionInput(raw); uuid(threadId);
    return sessionTransaction(this.db, c => this.createIn(c,actor,threadId,input,null));
  }
  async createForChannel(actor: string, channelId: string, raw: unknown): Promise<AgentSessionSummary> {
    const {client_thread_id, ...fields} = record(raw, ['client_thread_id','client_session_id','installation_id','title','skill','project_token']);
    const threadId = uuid(client_thread_id), input = parseAgentSessionInput(fields);
    return sessionTransaction(this.db, async c => {
      const [channel] = await c.select().from(s.channels).where(eq(s.channels.id,uuid(channelId)));
      if (!channel || channel.kind !== 'channel' || !await hasChannelAccess(c,actor,channel.workspace_id,channelId)) throw notFound();
      const inserted = await c.insert(s.threads).values({id:threadId,workspace_id:channel.workspace_id,channel_id:channelId})
        .onConflictDoNothing().returning({id:s.threads.id});
      if (!inserted.length) {
        const [existing] = await c.select({id:s.agentSessions.id}).from(s.agentSessions)
          .innerJoin(s.threads,eq(s.threads.id,s.agentSessions.origin_thread_id))
          .where(and(eq(s.agentSessions.id,input.client_session_id),eq(s.threads.id,threadId),eq(s.threads.channel_id,channelId)));
        if (!existing) throw new AppError(409,'idempotency_conflict');
      }
      return this.createIn(c,actor,threadId,input,null);
    });
  }
  private async createIn(c:DbSession, actor:string, threadId:string, input:ReturnType<typeof parseAgentSessionInput>, parentId:string|null) {
    if (!await hasThreadAccess(c, actor, threadId)) throw notFound();
    const [thread] = await c.select().from(s.threads).where(eq(s.threads.id, threadId));
    if (!thread) throw notFound();
    const [ref] = await c.select().from(s.agentInstallations).where(eq(s.agentInstallations.id, input.installation_id));
    const [definition] = ref ? await c.select().from(s.agentDefinitions).where(eq(s.agentDefinitions.id, ref.definition_id)) : [];
    if (!definition?.capabilities.persistent_sessions) throw new AppError(409, 'session_connector_unsupported');
    const grants = await c.select().from(s.agentGrants).where(and(eq(s.agentGrants.installation_id, input.installation_id), eq(s.agentGrants.channel_id, thread.channel_id)));
    const [connection] = await c.select({revoked_at:s.agentConnections.revoked_at}).from(s.agentConnections).where(eq(s.agentConnections.installation_id,input.installation_id));
    if (input.project_token && (!connection || ref?.owner_id !== actor)) throw new AppError(403, 'installation_not_owned');
    const skills = definition.capabilities.skills.filter(skill => connection ? !connection.revoked_at : grants.some(grant => grant.skill === skill));
    const skill = input.skill ?? (skills.length === 1 ? skills[0] : undefined);
    if (!skill) throw new AppError(400, 'session_skill_required');
    const installation = await this.tasks.eligible(c, { thread_id: threadId, workspace_id: thread.workspace_id, installation_id: input.installation_id, requester_id: actor, skill }, true);
    await c.insert(s.agentSessions).values({ id: input.client_session_id, project_token:input.project_token, parent_session_id: parentId, workspace_id: thread.workspace_id, installation_id: installation.id, origin_thread_id: threadId, title: input.title, managed: true, created_by: actor, skill }).onConflictDoNothing({ target: s.agentSessions.id });
    const [existing] = await c.select().from(s.agentSessions).where(eq(s.agentSessions.id, input.client_session_id));
    if (!existing || existing.project_token !== (input.project_token ?? null) || existing.parent_session_id !== parentId || !existing.managed || existing.origin_thread_id !== threadId || existing.installation_id !== input.installation_id || (existing.creation_title ?? existing.title) !== input.title || existing.created_by !== actor || existing.skill !== skill) throw new AppError(409, 'idempotency_conflict');
    return this.summary(c, input.client_session_id);
  }
  async inviteAgent(actor:string, parentId:string, key:string, raw:unknown) {
    const v = record(raw,['installation_id','skill','prompt','context']);
    const prompt = text(v.prompt,2000).trim();
    const context = v.context === undefined ? '' : text(v.context,1800).trim();
    const message = context ? prompt+'\n\nContext selected by the requester:\n'+context : prompt;
    const id = uuid(key);
    const input = parseAgentSessionInput({client_session_id:id, installation_id:v.installation_id, skill:v.skill, title:prompt.slice(0,120)});
    return sessionTransaction(this.db, async c => {
      const parent = await this.visible(c,actor,parentId);
      if (!parent.managed || parent.handoff_context || parent.state !== 'active' || parent.installation_id === input.installation_id)
        throw new AppError(409,'session_handoff_unavailable');
      const [size] = (await c.execute<{count:number}>(sql`SELECT count(*)::int AS count FROM agent_sessions WHERE parent_session_id=${parent.id} AND id<>${id}`)).rows;
      if (size!.count >= 32) throw new AppError(409,'session_helper_limit');
      const child = await this.createIn(c,actor,parent.origin_thread_id,input,parent.id);
      await this.addInputIn(c,actor,child.id,id,'queue',{text:message});
      return {id:child.id};
    });
  }
  async read(actor: string, id: string, query: unknown = {}): Promise<AgentSessionDetail> {
    const v = record(query, ['before','after']), before = v.before === undefined ? undefined : uuid(v.before), after = v.after === undefined ? undefined : uuid(v.after);
    if (before && after) throw new AppError(400, 'invalid_cursor');
    const cursor = before ?? after;
    return this.db.transaction(async c => {
      const session = await this.visible(c, actor, id);
      if (cursor && !(await c.select({ id: s.tasks.id }).from(s.tasks).where(and(eq(s.tasks.id, cursor), eq(s.tasks.session_id, id)))).length) throw notFound();
      const result = await c.execute<{ task: Task & { created_at: string }; requester_name: string; payload: Record<string, unknown> | null; response_payload: Record<string, unknown> | null } & Record<string, unknown>>(sql`
        SELECT to_jsonb(t)||jsonb_build_object('request_document',coalesce(t.request_document,origin.document)) AS task,u.display_name AS requester_name,latest.payload,snapshot.payload AS response_payload
        FROM tasks t JOIN users u ON u.id=t.requester_id
        -- Older routed tasks saved only text; recover markup only from their exact matching source message.
        LEFT JOIN LATERAL (
          SELECT m.document FROM navigator_decisions n JOIN messages m ON m.thread_id=n.thread_id AND m.sequence=n.through_sequence
          WHERE t.request_document IS NULL AND n.thread_id=t.thread_id AND n.route='mention' AND n.decision->>'task_id'=t.id::text
            AND m.workspace_id=t.workspace_id AND m.user_id=t.requester_id AND m.text=t.goal
          LIMIT 1
        ) origin ON true
        LEFT JOIN LATERAL (SELECT payload FROM task_events WHERE correlation_id=t.id ORDER BY sequence DESC LIMIT 1) latest ON true
        LEFT JOIN LATERAL (SELECT payload FROM task_events WHERE correlation_id=t.id AND payload ? 'response' ORDER BY sequence DESC LIMIT 1) snapshot ON true
        WHERE t.session_id=${id} ${before ? sql`AND (t.created_at,t.id)<(SELECT created_at,id FROM tasks WHERE id=${before} AND session_id=${id})` : sql``}
        ${after ? sql`AND (t.created_at,t.id)>(SELECT created_at,id FROM tasks WHERE id=${after} AND session_id=${id})` : sql``}
        ORDER BY t.created_at ${after ? sql`ASC` : sql`DESC`},t.id ${after ? sql`ASC` : sql`DESC`} LIMIT 21`);
      const rows = result.rows.slice(0, 20);
      const turns: AgentSessionTurn[] = (after ? rows : rows.reverse()).map(row => ({ task: row.task, created_at: new Date(row.task.created_at).toISOString(), requester_name: row.requester_name,
        ...(row.response_payload?.response ? { response: parseAgentResponse(row.response_payload.response) } : {}),
        detail: String(row.payload?.text ?? row.payload?.result ?? row.payload?.error ?? row.payload?.code ?? '') }));
      const audience = await c.execute(sql`SELECT ch.name,ch.kind,ch.direct_user_low,ch.direct_user_high FROM threads th JOIN channels ch ON ch.id=th.channel_id WHERE th.id=${session.origin_thread_id}`);
      const origin=audience.rows[0];
      const audienceLabel=origin?.kind==='direct' ? origin.direct_user_low===origin.direct_user_high ? 'Private session: only you' : 'Participants in the source direct conversation' : `Members of #${origin?.name ?? 'the source channel'}`;
      const executions = turns.flatMap(turn => turn.task.active_execution_id ? [sql`${turn.task.active_execution_id}::uuid`] : []);
      const inputs = await c.execute<SessionInput & Record<string,unknown>>(sql`SELECT i.id,actor_id,u.display_name AS actor_name,to_json(i.created_at) #>> '{}' AS created_at,kind,state,execution_id,detail,jsonb_array_length(body->'asset_ids') AS file_count,body->>'text' AS text,body->'document' AS document,body->>'browser_url' AS browser_url
        FROM agent_session_inputs i JOIN users u ON u.id=i.actor_id WHERE session_id=${id} AND (
          (kind='queue' AND state IN ('pending','blocked'))
          ${executions.length ? sql`OR (kind='steer' AND execution_id IN (${sql.join(executions, sql`,`)}))` : sql``})
        ORDER BY position`);
      const steering = new Map<string,SessionInput[]>();
      for (const input of inputs.rows) {
        if (input.kind !== 'steer' || !input.execution_id) continue;
        const receipts = steering.get(input.execution_id) ?? [];
        receipts.push(input);
        steering.set(input.execution_id, receipts);
      }
      for (const turn of turns) turn.steering = steering.get(turn.task.active_execution_id ?? '');
      const related = await c.execute<SessionRelatedAgent>(sql`SELECT a.id, a.title, coalesce(ac.name,d.name) AS agent_name, u.display_name AS owner_name,
        CASE WHEN a.id=${session.parent_session_id}::uuid THEN 'parent' ELSE 'helper' END AS relation
        FROM agent_sessions a JOIN agent_installations i ON i.id=a.installation_id JOIN agent_definitions d ON d.id=i.definition_id
        JOIN users u ON u.id=i.owner_id LEFT JOIN agent_connections ac ON ac.installation_id=i.id
        WHERE a.origin_thread_id=${session.origin_thread_id} AND (a.id=${session.parent_session_id}::uuid OR a.parent_session_id=${session.id})
        ORDER BY a.created_at,a.id LIMIT 33`);
      // Ended sessions cannot accept another turn. The last turn is therefore a stable
      // summary reference, including for sessions archived before this field existed.
      const finalSummary = session.state === 'ended' ? (await c.execute<{task_id:string; excerpt:string}>(sql`
        SELECT id AS task_id, left(result,480) AS excerpt FROM (
          SELECT id,status,result FROM tasks WHERE session_id=${id} ORDER BY created_at DESC,id DESC LIMIT 1
        ) last_turn WHERE status='completed' AND nullif(trim(result),'') IS NOT NULL`)).rows[0] : undefined;
      return { ...(finalSummary ? {final_summary:finalSummary} : {}), related_agents:related.rows, session_goal:session.session_goal, inputs:inputs.rows.filter(input => input.kind === 'queue'), audience:audienceLabel, tool_approvals:await sessionToolApprovals(c,id), ...(session.handoff_context ? {context:session.handoff_context} : {}), ...(session.managed ? { outputs: session.outputs } : {}), session: await this.summary(c, id), turns, next_cursor: (after || result.rows.length > 20) && turns.length ? turns[0]!.task.id : null, has_newer: after ? result.rows.length > 20 : !!before };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
  async send(actor: string, id: string, raw: unknown, key: string): Promise<Task> {
    return runTurn(this.db, c => this.prepareSend(c, actor, id, raw, key), this.tasks.admitLocalTurn);
  }
  async sendIn(c: DbSession, actor: string, id: string, raw: unknown, key: string): Promise<Task> {
    const plan = await this.prepareSend(c, actor, id, raw, key);
    return 'existing' in plan ? plan.existing : plan.commit();
  }
  private async prepareSend(c: DbSession, actor: string, id: string, raw: unknown, key: string, queueInputId?: string): Promise<TurnPlan> {
    const input = parseAgentSessionMessage(raw); key = text(key, 128);
    const session = await this.visible(c, actor, id);
    if (!session.managed) throw new AppError(409, 'session_unmanaged');
    if (session.state === 'ended') throw new AppError(409, 'session_ended');
    if (input.codex_settings && !isLocalAgentSkill(session.skill)) throw new AppError(400,'invalid_codex_settings');
    if (input.browser_url && !session.handoff_context?.browser_url) throw new AppError(400,'invalid_browser_page');
    const taskInput = { ...(input.browser_url ? {browser_url:input.browser_url} : {}), ...(input.goal_action ? {goal_action:input.goal_action} : {}), ...(input.codex_settings ? {codex_settings:input.codex_settings} : {}), workspace_id: session.workspace_id, thread_id: session.origin_thread_id, installation_id: session.installation_id, goal: input.text || 'Review the attached files.', skill: session.skill, ...(input.document ? { request_document: input.document } : {}) };
    const installation = await this.tasks.eligible(c, { ...taskInput, requester_id: actor, session_id: session.id }, true);
    if (input.goal_action) {
      if (actor !== installation.owner_id) throw new AppError(403,'owner_required');
      if (!['codex.local','claude.local'].includes(installation.connector_id) || !['codex.run','claude.run'].includes(session.skill) || input.asset_ids.length ||
          (session.skill==='claude.run' && ['pause','resume'].includes(input.goal_action.kind))) throw new AppError(400,'invalid_goal_action');
    }
    const hash = createHash('sha256').update(JSON.stringify({ ...taskInput, ...(input.asset_ids.length ? { text:input.text, asset_ids:input.asset_ids, asset_descriptions:input.asset_descriptions } : {}), agent_session_id: id })).digest('hex');
    const [existing] = await c.select().from(s.tasks).where(and(eq(s.tasks.workspace_id, session.workspace_id), eq(s.tasks.requester_id, actor), eq(s.tasks.idempotency_key, key)));
    if (existing) {
      if (existing.request_hash !== hash) throw new AppError(409, 'idempotency_conflict');
      return { existing };
    }
    await this.validateSelection(c,session.installation_id,session.skill,input.codex_settings);
    const busy = await c.execute(sql`SELECT 1 FROM tasks WHERE session_id=${id} AND status IN ('awaiting_approval','queued','running') LIMIT 1`);
    if (!queueInputId && (await c.execute(sql`SELECT 1 FROM agent_session_inputs WHERE session_id=${id} AND kind='queue' AND state IN ('pending','blocked') LIMIT 1`)).rows.length) throw new AppError(409,'session_queue_pending');
    if (busy.rows.length) throw new AppError(409, 'session_busy');
    const target = !queueInputId && installation.owner_id === actor && this.tasks.admitLocalTurn ? await directTurnTarget(c, installation, session) : undefined;
    const commit = async () => {
      const task = await this.tasks.createTaskIn(c, actor, taskInput, key, hash, session.id);
      if (input.asset_ids.length) {
        const ids = sql.join(input.asset_ids.map(id=>sql`${id}::uuid`), sql`,`);
        const attached = await c.execute<{id:string; name:string; size:number; type:string}>(sql`
          UPDATE assets SET task_id=${task.id},queue_input_id=NULL
          WHERE id IN (${ids}) AND channel_id=(SELECT channel_id FROM threads WHERE id=${session.origin_thread_id})
            AND workspace_id=${session.workspace_id} AND uploader_id=${actor} AND status='ready'
            AND message_id IS NULL AND task_id IS NULL AND ${queueInputId
              ? sql`queue_input_id=${queueInputId}`
              : sql`queue_input_id IS NULL AND expires_at>clock_timestamp()`}
            AND NOT EXISTS (SELECT 1 FROM scheduled_messages WHERE status IN ('pending','sending') AND asset_ids && ARRAY[${ids}])
          RETURNING id,name,size,type`);
        if (attached.rows.length !== input.asset_ids.length) throw new AppError(409,'asset_unavailable');
        task.attachments = input.asset_ids.map(id => {
          const file = attached.rows.find(row=>row.id===id)!;
          const description = input.asset_descriptions?.[id];
          return description ? {...file,description} : file;
        });
        await c.update(s.tasks).set({attachments:task.attachments}).where(eq(s.tasks.id,task.id));
      }
      const result = installation.owner_id === actor ? await this.tasks.approveTaskIn(c, actor, task.id, session.id,!!queueInputId) : task;
      const changed = await c.update(s.agentSessions).set({ revision: session.revision + 1 }).where(and(eq(s.agentSessions.id, id), eq(s.agentSessions.revision, session.revision), eq(s.agentSessions.state, 'active'))).returning({ id: s.agentSessions.id });
      if (!changed.length) throw new SessionConflict();
      return result;
    };
    return { target, commit };
  }
  async addInput(actor:string,id:string,key:string,kind:'queue'|'steer',raw:unknown,execution?:string,sourceId?:string) {
    return sessionTransaction(this.db,c=>this.addInputIn(c,actor,id,key,kind,raw,execution,sourceId));
  }
  private async addInputIn(c:DbSession,actor:string,id:string,key:string,kind:'queue'|'steer',raw:unknown,execution?:string,sourceId?:string) {
    key=uuid(key);
    const body=parseAgentSessionMessage(raw);
    if (body.goal_action && kind!=='steer') throw new AppError(400,'send_goal_separately');
    if (kind==='steer' && (!body.text.trim() || body.asset_ids.length)) throw new AppError(400,'steer_requires_text');
    const hash=createHash('sha256').update(JSON.stringify([kind,execution,body,...(sourceId ? [sourceId] : [])])).digest('hex');
    const session=await this.visible(c,actor,id);
    if (!session.managed || session.state!=='active') throw new AppError(409,'session_unavailable');
    const installation=await this.tasks.eligible(c,{...session,session_id:id,thread_id:session.origin_thread_id,requester_id:actor},true);
    if (body.browser_url && !session.handoff_context?.browser_url) throw new AppError(400,'invalid_browser_page');
    if(body.codex_settings && (kind==='steer' || !isLocalAgentSkill(session.skill))) throw new AppError(400,'invalid_codex_settings');
    if (body.goal_action && (session.skill==='claude.run' && !['set','clear'].includes(body.goal_action.kind) || !['claude.run','codex.run'].includes(session.skill))) throw new AppError(400,'invalid_goal_action');
    if(kind==='steer' && actor!==installation.owner_id) throw new AppError(403,'owner_required');
    const prior=(await c.execute<{actor_id:string;session_id:string;request_hash:string;state:string}>(sql`SELECT actor_id,session_id,request_hash,state FROM agent_session_inputs WHERE id=${key}`)).rows[0];
    if(prior){
      if(prior.actor_id!==actor || prior.session_id!==id || prior.request_hash!==hash) throw new AppError(409,'idempotency_conflict');
      return {state:prior.state,connection:null};
    }
    await this.validateSelection(c,session.installation_id,session.skill,body.codex_settings);
    let connection:string|null=null;
    if(kind==='steer'){
      if(!['codex.local','claude.local'].includes(installation.connector_id)) throw new AppError(409,'steer_unsupported');
      const run=(await c.execute<{connection_id:string}>(sql`SELECT a.connection_id FROM tasks t JOIN agent_connections a ON a.installation_id=t.installation_id
        WHERE t.session_id=${id} AND t.status='running' AND (${!body.goal_action} OR t.goal_action IS NOT NULL) AND t.active_execution_id=${execution} AND a.last_seen_at>now()-interval '45 seconds' AND a.auth_status='ready' AND a.connection_id IS NOT NULL AND a.revoked_at IS NULL`)).rows[0];
      if(!run) throw new AppError(409,'turn_not_running');
      connection=run.connection_id;
    }
    const count=await c.execute(sql`SELECT count(*)::int AS n FROM agent_session_inputs WHERE session_id=${id} AND kind=${kind} AND
      (kind='queue' AND state IN ('pending','blocked') OR kind='steer' AND execution_id=${execution??null})`);
    if(Number(count.rows[0]?.n)>=32) throw new AppError(409,'session_input_limit');
    if (sourceId) {
      const claimed = await c.execute(sql`UPDATE agent_session_inputs SET state='cancelled'
        WHERE id=${sourceId} AND session_id=${id} AND kind='queue' AND state='pending'
          AND body->>'text'=${body.text} AND jsonb_array_length(body->'asset_ids')=0 RETURNING id`);
      if (!claimed.rows.length) throw new AppError(409,'queue_item_changed');
    }
    // Keep the wire payload canonical and omit absent optional fields on replay.
    const payload={browser_url:body.browser_url,goal_action:body.goal_action,codex_settings:body.codex_settings,text:body.text,document:body.document,asset_ids:body.asset_ids,asset_descriptions:body.asset_descriptions};
    const state=kind==='queue'?'pending':'sending';
    await c.execute(sql`INSERT INTO agent_session_inputs(id,session_id,actor_id,kind,execution_id,body,request_hash,state,source_input_id)
      VALUES(${key},${id},${actor},${kind},${execution??null},${JSON.stringify(payload)}::jsonb,${hash},${state},${sourceId??null})`);
    if (body.asset_ids.length) {
      const ids = sql.join(body.asset_ids.map(assetId => sql`${assetId}::uuid`), sql`,`);
      const reserved = await c.execute(sql`UPDATE assets SET queue_input_id=${key}
        WHERE id IN (${ids}) AND channel_id=(SELECT channel_id FROM threads WHERE id=${session.origin_thread_id})
          AND workspace_id=${session.workspace_id} AND uploader_id=${actor} AND status='ready'
          AND message_id IS NULL AND task_id IS NULL AND queue_input_id IS NULL AND expires_at>clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM scheduled_messages WHERE status IN ('pending','sending') AND asset_ids && ARRAY[${ids}])
        RETURNING id`);
      if (reserved.rows.length !== body.asset_ids.length) throw new AppError(409,'asset_unavailable');
    }
    return {state,connection};
  }

  async finishSteer(id:string, state:'sent'|'blocked'|'uncertain',detail:string|null){
    await sessionTransaction(this.db,async c=>{
      const updated=await c.execute<{source_input_id:string|null}>(sql`UPDATE agent_session_inputs SET state=${state},detail=${detail}
        WHERE id=${uuid(id)} AND kind='steer' AND state='sending' RETURNING source_input_id`);
      const source=updated.rows[0]?.source_input_id;
      if (source && state==='blocked') await c.execute(sql`UPDATE agent_session_inputs SET state='blocked',detail=${detail}
        WHERE id=${source} AND state='cancelled' AND EXISTS (SELECT 1 FROM agent_sessions WHERE id=session_id AND state='active')`);
    });
  }

  async changeQueued(actor:string,id:string,key:string,action:'cancel'|'retry'){
    return sessionTransaction(this.db,async c=>{
      const session=await this.visible(c,actor,id);
      const [installation]=await c.select().from(s.agentInstallations).where(eq(s.agentInstallations.id,session.installation_id));
      const result=await c.execute(sql`UPDATE agent_session_inputs SET state=${action==='retry'?'pending':'cancelled'},detail=NULL
        WHERE id=${uuid(key)} AND session_id=${id} AND kind='queue' AND (actor_id=${actor} OR ${installation?.owner_id===actor})
        AND state IN ('blocked',${action==='retry'?'blocked':'pending'}) RETURNING id`);
      if(!result.rows.length) throw new AppError(409,'queue_item_unavailable');
      if (action==='cancel') await c.execute(sql`UPDATE agent_sessions SET queue_paused=false WHERE id=${id} AND queue_paused
        AND NOT EXISTS(SELECT 1 FROM agent_session_inputs WHERE session_id=${id} AND kind='queue' AND state IN ('pending','blocked'))`);
    });
  }

  async reviseQueued(actor:string,id:string,key:string,raw:unknown) {
    const input=record(raw,['text','previous_text','move_to']);
    const moving=input.move_to!==undefined;
    if (moving && (input.text!==undefined || input.previous_text!==undefined)) throw new AppError(400,'invalid_queue_change');
    return sessionTransaction(this.db,async c=>{
      const session=await this.visible(c,actor,id);
      const installation=await this.tasks.eligible(c,{...session,session_id:id,thread_id:session.origin_thread_id,requester_id:actor},true);
      const items=(await c.execute<{id:string;actor_id:string;position:string}>(sql`SELECT id,actor_id,position FROM agent_session_inputs
        WHERE session_id=${id} AND kind='queue' AND state IN ('pending','blocked') ORDER BY position`)).rows;
      const from=items.findIndex(item=>item.id===key);
      if (from<0 || (items[from]!.actor_id!==actor && installation.owner_id!==actor)) throw new AppError(409,'queue_item_unavailable');
      if (moving) {
        const to=items.findIndex(item=>item.id===uuid(input.move_to));
        if (to<0) throw new AppError(409,'queue_item_changed');
        const order=[...items];
        order.splice(to,0,...order.splice(from,1));
        const moves=order.flatMap((item,index)=>item.id===items[index]!.id ? [] : [sql`(${item.id}::uuid,${items[index]!.position}::bigint)`]);
        if (moves.length) await c.execute(sql`UPDATE agent_session_inputs i SET position=v.pos FROM (VALUES ${sql.join(moves,sql`,`)}) v(id,pos) WHERE i.id=v.id`);
      } else {
        const content=text(input.text,4000).trim();
        if (!content || typeof input.previous_text!=='string') throw new AppError(400,'invalid_text');
        const result=await c.execute(sql`UPDATE agent_session_inputs SET body=jsonb_set(body-'document','{text}',to_jsonb(${content}::text))
          WHERE id=${key} AND body->>'text'=${input.previous_text} RETURNING id`);
        if (!result.rows.length) throw new AppError(409,'queue_item_changed');
      }
    });
  }

  async resumeQueue(actor:string,id:string) {
    return sessionTransaction(this.db,async c=>{
      await this.manageable(c,actor,id);
      const resumed=await c.execute(sql`UPDATE agent_sessions SET queue_paused=false,revision=revision+1 WHERE id=${id} AND queue_paused AND state='active' RETURNING id`);
      if (resumed.rows.length) await c.execute(sql`INSERT INTO event_outbox(kind,aggregate_id,payload) VALUES ('task.session_queue',${id},'{}')`);
    });
  }

  async drainQueue(id:string) {
    const head=()=>sql`SELECT id,actor_id,body,state FROM agent_session_inputs WHERE session_id=${id} AND kind='queue' AND state IN ('blocked','pending') AND EXISTS(SELECT 1 FROM agent_sessions WHERE id=${id} AND NOT queue_paused) ORDER BY position LIMIT 1`;
    let inputId:string|undefined;
    try {
      return await runTurn(this.db,async c=>{
        const row=(await c.execute<{id:string;actor_id:string;body:unknown;state:string}>(head())).rows[0];
        if(!row || row.state==='blocked' || (inputId && row.id!==inputId)) throw new AppError(409,'queue_idle');
        inputId=row.id;
        const plan=await this.prepareSend(c,row.actor_id,id,row.body,'session-queue/'+row.id,row.id);
        return {commit:async()=>{
          const task='existing' in plan ? plan.existing : await plan.commit();
          await c.execute(sql`UPDATE agent_session_inputs SET state='sent',task_id=${task.id} WHERE id=${row.id}`);
          return task;
        }};
      },this.tasks.admitLocalTurn);
    } catch(error){
      if(!(error instanceof AppError)) throw error;
      if(['queue_idle','session_busy'].includes(error.code)) return;
      if(!inputId || ['session_conflict','agent_capacity','agent_busy'].includes(error.code)) throw error;
      await this.db.execute(sql`UPDATE agent_session_inputs SET state='blocked',detail=${error.code} WHERE id=${inputId} AND state='pending'`);
    }
  }

  private async manageable(c: DbSession, actor: string, id: string) {
    const session = await this.visible(c, actor, id);
    if (!session.managed) throw new AppError(409, 'session_unmanaged');
    const [installation] = await c.select().from(s.agentInstallations).where(eq(s.agentInstallations.id, session.installation_id));
    if (actor !== session.created_by && actor !== installation?.owner_id) throw new AppError(403, 'session_control_not_authorized');
    return session;
  }
  async rename(actor: string, id: string, raw: unknown) {
    const input = record(raw, ['title', 'previous_title']);
    const title = text(input.title, 160).trim(), previous = text(input.previous_title, 160);
    return sessionTransaction(this.db, async c => {
      const session = await this.manageable(c, actor, id);
      if (session.title !== title) {
        if (session.title !== previous) throw new AppError(409, 'session_title_changed');
        await c.update(s.agentSessions).set({ title, creation_title: session.creation_title ?? session.title })
          .where(eq(s.agentSessions.id, id));
      }
      return this.summary(c, id);
    });
  }
  async reopen(actor: string, id: string): Promise<AgentSessionSummary> {
    return sessionTransaction(this.db, async c => {
      const session = await this.manageable(c, actor, id);
      await this.tasks.eligible(c, {
        workspace_id: session.workspace_id, thread_id: session.origin_thread_id, session_id: id,
        installation_id: session.installation_id, skill: session.skill, requester_id: actor,
      }, true, true);
      if (session.state === 'ended') {
        const changed = await c.update(s.agentSessions)
          .set({ state: 'active', revision: session.revision + 1, queue_paused: false })
          .where(and(eq(s.agentSessions.id, id), eq(s.agentSessions.revision, session.revision)))
          .returning({ id: s.agentSessions.id });
        if (!changed.length) throw new SessionConflict();
      }
      return this.summary(c, id);
    });
  }
  async control(actor: string, id: string, operation: 'stop' | 'end'): Promise<AgentSessionSummary> {
    return sessionTransaction(this.db, c => this.controlIn(c, actor, id, operation));
  }
  async controlIn(c: DbSession, actor: string, id: string, operation: 'stop' | 'end'): Promise<AgentSessionSummary> {
      const session = await this.manageable(c, actor, id);
      const cancelled=await c.execute(sql`UPDATE navigator_followups SET status='cancelled',reason='session_stopped' WHERE session_id=${id} AND status='pending' RETURNING id`);
      const active = await c.select().from(s.tasks).where(and(eq(s.tasks.session_id, id), sql`${s.tasks.status} IN ('awaiting_approval','queued','running')`)).orderBy(s.tasks.id);
      for (const task of active) await this.tasks.stopTaskIn(c, task, actor);
      if (active.length || cancelled.rows.length || (operation === 'end' && session.state !== 'ended')) {
        const changed = await c.update(s.agentSessions).set({ revision: session.revision + 1, ...(operation === 'end' ? { state: 'ended' as const } : {}) }).where(and(eq(s.agentSessions.id, id), eq(s.agentSessions.revision, session.revision))).returning({ id: s.agentSessions.id });
        if (!changed.length) throw new SessionConflict();
      }
      if (operation==='stop') await c.execute(sql`UPDATE agent_sessions SET queue_paused=true WHERE id=${id} AND EXISTS(
        SELECT 1 FROM agent_session_inputs WHERE session_id=${id} AND kind='queue' AND state IN ('pending','blocked'))`);
      else await c.execute(sql`UPDATE agent_session_inputs SET state='cancelled' WHERE session_id=${id} AND kind='queue' AND state IN ('pending','blocked')`);
      return this.summary(c, id);
  }
}
