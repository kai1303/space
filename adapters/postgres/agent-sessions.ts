import { SidekickStore } from './sidekick.js';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { and, eq, sql } from 'drizzle-orm';
import { AppError, parseAgentSessionInput, parseAgentSessionMessage, parseAgentResponse, record, text, uuid, type AgentSessionDetail, type AgentSessionSummary, type WorkspaceAgentSession, type AgentSessionTurn, type Task } from '@space/contracts';
import { database, type DbSession } from './database.js';
import { hasThreadAccess, requireWorkspaceAccess } from './access.js';
import { sessionTransaction, SessionConflict } from './session-concurrency.js';
import { PostgresStore } from './store.js';
import * as s from './schema.js';
const notFound = () => new AppError(404, 'not_found');
const summaryColumns = sql`a.id,a.workspace_id,a.installation_id,a.origin_thread_id,a.title,a.state,a.managed,a.created_by,a.created_at::text,d.name AS agent_name,i.owner_id,
  CASE WHEN a.managed THEN a.skill ELSE coalesce((SELECT skill FROM tasks WHERE session_id=a.id ORDER BY created_at,id LIMIT 1),a.skill) END AS skill,
  (SELECT count(*)::integer FROM tasks WHERE session_id=a.id) AS turn_count`;

export class AgentSessionStore {
  readonly db; readonly tasks; readonly sidekicks;
  constructor(readonly pool: Pool, tasks = new PostgresStore(pool)) { this.db = database(pool); this.tasks = tasks; this.sidekicks = new SidekickStore(this.db); }
  private async visible(c: DbSession, actor: string, id: string) {
    const [session] = await c.select().from(s.agentSessions).where(eq(s.agentSessions.id, uuid(id)));
    if (!session || !await hasThreadAccess(c, actor, session.origin_thread_id)) throw notFound();
    return session;
  }
  private async summary(c: DbSession, id: string): Promise<AgentSessionSummary> {
    const result = await c.execute<AgentSessionSummary & Record<string, unknown>>(sql`SELECT ${summaryColumns} FROM agent_sessions a JOIN agent_installations i ON i.id=a.installation_id JOIN agent_definitions d ON d.id=i.definition_id WHERE a.id=${id}`);
    const row = result.rows[0];
    if (!row) throw notFound();
    return { ...row, created_at: new Date(row.created_at).toISOString() };
  }
  async list(actor: string, threadId: string): Promise<{ items: AgentSessionSummary[]; next_cursor: null }> {
    return this.db.transaction(async c => {
      if (!await hasThreadAccess(c, actor, uuid(threadId))) throw notFound();
      const result = await c.execute<AgentSessionSummary & Record<string, unknown>>(sql`SELECT ${summaryColumns} FROM agent_sessions a JOIN agent_installations i ON i.id=a.installation_id JOIN agent_definitions d ON d.id=i.definition_id WHERE a.origin_thread_id=${threadId} ORDER BY a.created_at DESC,a.id DESC LIMIT 100`);
      return { items: result.rows.map(row => ({ ...row, created_at: new Date(row.created_at).toISOString() })), next_cursor: null };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
  async listWorkspace(actor: string, workspace: string, raw: unknown = {}) {
    const input = record(raw, ['before']), before = input.before === undefined ? undefined : uuid(input.before);
    return this.db.transaction(async c => {
      await requireWorkspaceAccess(c, actor, workspace);
      if (before) {
        const cursor = await this.visible(c, actor, before);
        if (cursor.workspace_id !== workspace || !cursor.managed) throw notFound();
      }
      const result = await c.execute<WorkspaceAgentSession & Record<string, unknown>>(sql`
        SELECT ${summaryColumns},t.channel_id,ch.archived_at IS NOT NULL AS channel_archived
        FROM agent_sessions a JOIN threads t ON t.id=a.origin_thread_id
        JOIN channels ch ON ch.id=t.channel_id
        JOIN channel_members m ON m.channel_id=t.channel_id AND m.workspace_id=a.workspace_id AND m.user_id=${actor}
        JOIN agent_installations i ON i.id=a.installation_id JOIN agent_definitions d ON d.id=i.definition_id
        WHERE a.workspace_id=${workspace} AND a.managed
        ${before ? sql`AND (a.created_at,a.id)<(SELECT created_at,id FROM agent_sessions WHERE id=${before})` : sql``}
        ORDER BY a.created_at DESC,a.id DESC LIMIT 21`);
      return { items: result.rows.slice(0,20).map(row => ({...row,created_at:new Date(row.created_at).toISOString()})), next_cursor: result.rows.length > 20 ? result.rows[19]!.id : null };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
  async create(actor: string, threadId: string, raw: unknown): Promise<AgentSessionSummary> {
    const input = parseAgentSessionInput(raw); uuid(threadId);
    return sessionTransaction(this.db, async c => {
      if (!await hasThreadAccess(c, actor, threadId)) throw notFound();
      const [thread] = await c.select().from(s.threads).where(eq(s.threads.id, threadId));
      if (!thread) throw notFound();
      const [ref] = await c.select().from(s.agentInstallations).where(eq(s.agentInstallations.id, input.installation_id));
      const [definition] = ref ? await c.select().from(s.agentDefinitions).where(eq(s.agentDefinitions.id, ref.definition_id)) : [];
      if (!definition?.capabilities.persistent_sessions) throw new AppError(409, 'session_connector_unsupported');
      const grants = await c.select().from(s.agentGrants).where(and(eq(s.agentGrants.installation_id, input.installation_id), eq(s.agentGrants.channel_id, thread.channel_id)));
      const [connection] = await c.select({revoked_at:s.agentConnections.revoked_at}).from(s.agentConnections).where(eq(s.agentConnections.installation_id,input.installation_id));
      const skills = definition.capabilities.skills.filter(skill => connection ? !connection.revoked_at : grants.some(grant => grant.skill === skill));
      const skill = input.skill ?? (skills.length === 1 ? skills[0] : undefined);
      if (!skill) throw new AppError(400, 'session_skill_required');
      const installation = await this.tasks.eligible(c, { thread_id: threadId, workspace_id: thread.workspace_id, installation_id: input.installation_id, requester_id: actor, skill }, true);
      await c.insert(s.agentSessions).values({ id: input.client_session_id, workspace_id: thread.workspace_id, installation_id: installation.id, origin_thread_id: threadId, title: input.title, managed: true, created_by: actor, skill }).onConflictDoNothing({ target: s.agentSessions.id });
      const [existing] = await c.select().from(s.agentSessions).where(eq(s.agentSessions.id, input.client_session_id));
      if (!existing || !existing.managed || existing.origin_thread_id !== threadId || existing.installation_id !== input.installation_id || existing.title !== input.title || existing.created_by !== actor || existing.skill !== skill) throw new AppError(409, 'idempotency_conflict');
      return this.summary(c, input.client_session_id);
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
      return { ...(session.handoff_context ? {context:session.handoff_context} : {}), ...(session.managed ? { outputs: session.outputs } : {}), session: await this.summary(c, id), turns, next_cursor: (after || result.rows.length > 20) && turns.length ? turns[0]!.task.id : null, has_newer: after ? result.rows.length > 20 : !!before };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
  async send(actor: string, id: string, raw: unknown, key: string): Promise<Task> {
    return sessionTransaction(this.db, c => this.sendIn(c, actor, id, raw, key));
  }
  async sendIn(c: DbSession, actor: string, id: string, raw: unknown, key: string): Promise<Task> {
    const input = parseAgentSessionMessage(raw); key = text(key, 128);
      const session = await this.visible(c, actor, id);
      if (!session.managed) throw new AppError(409, 'session_unmanaged');
      if (session.state === 'ended') throw new AppError(409, 'session_ended');
      const taskInput = { workspace_id: session.workspace_id, thread_id: session.origin_thread_id, installation_id: session.installation_id, goal: input.text, skill: session.skill, ...(input.document ? { request_document: input.document } : {}) };
      const installation = await this.tasks.eligible(c, { ...taskInput, requester_id: actor, session_id: session.id }, true);
      const hash = createHash('sha256').update(JSON.stringify({ ...taskInput, agent_session_id: id })).digest('hex');
      const [existing] = await c.select().from(s.tasks).where(and(eq(s.tasks.workspace_id, session.workspace_id), eq(s.tasks.requester_id, actor), eq(s.tasks.idempotency_key, key)));
      if (existing) {
        if (existing.request_hash !== hash) throw new AppError(409, 'idempotency_conflict');
        return existing;
      }
      const busy = await c.execute(sql`SELECT 1 FROM tasks WHERE session_id=${id} AND status IN ('awaiting_approval','queued','running') LIMIT 1`);
      if (busy.rows.length) throw new AppError(409, 'session_busy');
      const task = await this.tasks.createTaskIn(c, actor, taskInput, key, hash, session.id);
      const result = installation.owner_id === actor ? await this.tasks.approveTaskIn(c, actor, task.id, session.id) : task;
      const changed = await c.update(s.agentSessions).set({ revision: session.revision + 1 }).where(and(eq(s.agentSessions.id, id), eq(s.agentSessions.revision, session.revision), eq(s.agentSessions.state, 'active'))).returning({ id: s.agentSessions.id });
      if (!changed.length) throw new SessionConflict();
      return result;
  }
  async control(actor: string, id: string, operation: 'stop' | 'end'): Promise<AgentSessionSummary> {
    return sessionTransaction(this.db, c => this.controlIn(c, actor, id, operation));
  }
  async controlIn(c: DbSession, actor: string, id: string, operation: 'stop' | 'end'): Promise<AgentSessionSummary> {
      const session = await this.visible(c, actor, id);
      if (!session.managed) throw new AppError(409, 'session_unmanaged');
      const [installation] = await c.select().from(s.agentInstallations).where(eq(s.agentInstallations.id, session.installation_id));
      if (actor !== session.created_by && actor !== installation?.owner_id) throw new AppError(403, 'session_control_not_authorized');
      const cancelled=await c.execute(sql`UPDATE navigator_followups SET status='cancelled',reason='session_stopped' WHERE session_id=${id} AND status='pending' RETURNING id`);
      const active = await c.select().from(s.tasks).where(and(eq(s.tasks.session_id, id), sql`${s.tasks.status} IN ('awaiting_approval','queued','running')`)).orderBy(s.tasks.id);
      for (const task of active) await this.tasks.stopTaskIn(c, task, actor);
      if (active.length || cancelled.rows.length || (operation === 'end' && session.state !== 'ended')) {
        const changed = await c.update(s.agentSessions).set({ revision: session.revision + 1, ...(operation === 'end' ? { state: 'ended' as const } : {}) }).where(and(eq(s.agentSessions.id, id), eq(s.agentSessions.revision, session.revision))).returning({ id: s.agentSessions.id });
        if (!changed.length) throw new SessionConflict();
      }
      return this.summary(c, id);
  }
}
