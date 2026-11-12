import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { and, eq, gt, inArray, sql, getTableColumns } from 'drizzle-orm';
import { AppError, assertTransition, parseAgentEvent, parseAgentResponse, parseTaskInput, text, uuid, type InvocationRequest, type RichDocument, type Task, type AgentInstallation, type WorkplaceEvent } from '@space/contracts';
import { assertEligible, assertApprover } from '@space/core/policy';
import type { Delivery, DeliveryStore, PreparedDelivery } from '@space/core/ports';
import { database, type DbSession } from './database.js';
import * as s from './schema.js';
import { tokenHash } from './bootstrap.js';
import { hasThreadAccess } from './access.js';
import { readThreadContext } from './thread-context.js';
import { readChannelMemory, readSessionMemory } from './layered-memory.js';
import { readKnowledgeContext, saveTurnNotes } from './knowledge-notes.js';
import { sessionTransaction, SessionConflict } from './session-concurrency.js';
import { traceTool, traceToolChanges, traceTurn } from './turn-trace.js';
import { directTurnTarget, runTurn, type AdmitLocalTurn, type TurnPlan } from './direct-turn-admission.js';
import { FoundationStore } from './foundation.js';
const notFound = () => new AppError(404, 'not_found');
const now = sql`now()`;
function mergeOutputPaths<T extends { path: string }>(existing: T[], incoming: T[]): T[] {
  const paths = new Map(existing.map(item => [item.path, item]));
  for (const item of incoming) { paths.delete(item.path); paths.set(item.path, item); }
  return [...paths.values()].slice(-20);
}
function interruptResponse(c: DbSession, taskId: string, snapshot: unknown) {
  if (!snapshot) return;
  const response = parseAgentResponse(snapshot);
  response.messages.forEach(message => { message.status = 'complete'; });
  for (const tool of response.tools) {
    if (tool.status === 'calling' || tool.status === 'running') {
      tool.status = 'interrupted';
      traceTool(c, taskId, tool.id, tool.status);
    }
  }
  delete response.step;
  delete response.activity;
  return response;
}
async function navigatorPresent(c: DbSession) { return Boolean((await c.execute<{present:boolean}>(sql`SELECT to_regclass('navigator_decisions') IS NOT NULL AS present`)).rows[0]?.present); }
export class PostgresStore implements DeliveryStore {
  readonly db;
  admitLocalTurn?: AdmitLocalTurn;
  outboundAccess?: (execution:string,installation:string) => Promise<import('@space/contracts').OutboundAccess|undefined>;
  memoryReader?: (task: Pick<Task, 'installation_id' | 'requester_id' | 'thread_id'>) => Promise<import('@space/contracts').AgentMemoryContext | undefined>;
  constructor(readonly pool: Pool) { this.db = database(pool); }
  async health(): Promise<void> { await this.db.execute(sql`SELECT 1`); }
  async authenticate(token: string): Promise<string> {
    const [row] = await this.db.select().from(s.humanCredentials).where(eq(s.humanCredentials.token_hash, tokenHash(token)));
    if (!row) throw new AppError(401, 'unauthorized');
    return row.user_id;
  }
  private async managed(c: DbSession, sessionId: string | null | undefined): Promise<boolean> {
    return Boolean(sessionId && (await c.select({ managed: s.agentSessions.managed }).from(s.agentSessions).where(eq(s.agentSessions.id, sessionId)))[0]?.managed);
  }
  private async taskTransaction<T>(id: string, work: (c: DbSession) => Promise<T>): Promise<T> {
    uuid(id);
    return sessionTransaction(this.db, work);
  }
  private async task(c: DbSession, id: string): Promise<Task> {
    const query = c.select().from(s.tasks).where(eq(s.tasks.id, uuid(id)));
    const [ref] = await query;
    if (!ref) throw notFound();
    return ref;
  }
  private async visibleTask(c: DbSession, actor: string, id: string): Promise<Task> {
    const task = await this.task(c, id);
    if (!await hasThreadAccess(c, actor, task.thread_id)) throw notFound();
    return task;
  }
  private async installation(c: DbSession, id: string, optimistic = false): Promise<AgentInstallation> {
    const query = c.select({ ...getTableColumns(s.agentInstallations), capabilities: s.agentDefinitions.capabilities })
      .from(s.agentInstallations).innerJoin(s.agentDefinitions, eq(s.agentDefinitions.id, s.agentInstallations.definition_id))
      .where(eq(s.agentInstallations.id, id));
    const [row] = await query;
    if (!row) throw notFound();
    return row;
  }
  async eligible(c: DbSession, task: Pick<Task, 'thread_id' | 'installation_id' | 'skill' | 'workspace_id' | 'requester_id'> & { session_id?: string | null }, optimistic = false, allowEnded = false): Promise<AgentInstallation> {
    optimistic = true;
    const ended = await c.execute(sql`SELECT 1 FROM agent_sessions WHERE id=${task.session_id ?? null} AND managed AND state='ended'`);
    if (!allowEnded && ended.rows.length) throw new AppError(409, 'session_ended');
    const channelQuery = c.select({ archived_at: s.channels.archived_at, kind: s.channels.kind }).from(s.channels)
      .innerJoin(s.threads, eq(s.threads.channel_id, s.channels.id)).where(eq(s.threads.id, task.thread_id));
    const [channel] = await channelQuery;
    if (channel?.archived_at) throw new AppError(409, 'channel_archived');
    const installation = await this.installation(c, task.installation_id, optimistic);
    if (installation.workspace_id !== task.workspace_id) throw notFound();
    const grantsQuery = c.select({ skill: s.agentGrants.skill }).from(s.agentGrants)
      .innerJoin(s.threads, and(eq(s.threads.channel_id, s.agentGrants.channel_id), eq(s.threads.workspace_id, s.agentGrants.workspace_id)))
      .where(and(eq(s.agentGrants.installation_id, installation.id), eq(s.threads.id, task.thread_id), eq(s.agentGrants.skill, task.skill)));
    const grants = await grantsQuery;
    const [connection] = await c.select({ revoked_at: s.agentConnections.revoked_at }).from(s.agentConnections).where(eq(s.agentConnections.installation_id, installation.id));
    const sidekick = channel?.kind === 'direct' ? await c.execute(sql`SELECT 1 FROM agent_sessions a JOIN threads t ON t.id=a.origin_thread_id JOIN channels ch ON ch.id=t.channel_id
      WHERE a.id=${task.session_id ?? null} AND a.handoff_context IS NOT NULL AND a.managed AND a.installation_id=${installation.id}
        AND a.origin_thread_id=${task.thread_id} AND a.created_by=${task.requester_id} AND a.created_by=${installation.owner_id}
        AND ch.kind='direct' AND ch.direct_user_low=a.created_by AND ch.direct_user_high=a.created_by`) : undefined;
    // Connected agents inherit the owner's current access; legacy installations still need a grant.
    const permitted = connection ? !connection.revoked_at : channel?.kind === 'direct' ? !!sidekick?.rows.length : grants.length > 0;
    assertEligible(installation, task.skill, permitted, await hasThreadAccess(c, task.requester_id, task.thread_id), await hasThreadAccess(c, installation.owner_id, task.thread_id));
    return installation;
  }
  private async append(c: DbSession, task: Task, type: string, actor: string, payload: Record<string, unknown>, causationId: string | null = null): Promise<void> {
    const managed = task.session_id && (await c.select({ managed: s.agentSessions.managed }).from(s.agentSessions).where(eq(s.agentSessions.id, task.session_id)))[0]?.managed;
    if (managed) payload = { ...payload, session_managed: true, agent_session_id: task.session_id };
    const conversational=await navigatorPresent(c)&&(await c.execute(sql`SELECT 1 FROM agent_thread_subscriptions WHERE task_id=${task.id} UNION ALL SELECT 1 FROM navigator_decisions WHERE decision->>'task_id'=${task.id} LIMIT 1`)).rows.length>0;
    await c.insert(s.taskEvents).values({
      id: randomUUID(), type, workspace_id: task.workspace_id, actor_id: actor,
      resource_id: type.startsWith('execution.') ? task.active_execution_id! : task.id,
      correlation_id: task.id, causation_id: causationId,
      sequence: sql`(SELECT coalesce(max(sequence),0)+1 FROM task_events WHERE correlation_id=${task.id})`, payload: conversational?{...payload,conversational:true}:payload,
    });
  }
  async createTask(actor: string, rawInput: unknown, key: string): Promise<Task> {
    const input = parseTaskInput(rawInput);
    text(key, 128);
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return sessionTransaction(this.db, c => this.createTaskIn(c, actor, input, key, hash));
  }
  async createTaskIn(c: DbSession, actor: string, input: ReturnType<typeof parseTaskInput> & { request_document?: RichDocument }, key: string, hash = createHash('sha256').update(JSON.stringify(input)).digest('hex'), managedSessionId?: string): Promise<Task> {
      if (!await hasThreadAccess(c, actor, input.thread_id)) throw notFound();
      const [thread] = await c.select().from(s.threads).where(eq(s.threads.id, input.thread_id));
      if (thread?.workspace_id !== input.workspace_id) throw notFound();
      await this.eligible(c, { ...input, requester_id: actor, session_id: managedSessionId }, Boolean(managedSessionId));
      const [existing] = await c.select().from(s.tasks).where(and(eq(s.tasks.workspace_id, input.workspace_id), eq(s.tasks.requester_id, actor), eq(s.tasks.idempotency_key, key)));
      if (existing) {
        if (existing.request_hash !== hash) throw new AppError(409, 'idempotency_conflict');
        return existing;
      }
      const [task] = await c.insert(s.tasks).values({ id: randomUUID(), ...input, ...(managedSessionId ? { session_id: managedSessionId } : {}), requester_id: actor, status: 'awaiting_approval', idempotency_key: key, request_hash: hash }).returning();
      await this.append(c, task!, 'task.proposed', actor, { goal: task!.goal });
      traceTurn(c, task!.id, 'approval', 'proposed');
      return task!;
  }
  async approveTask(actor: string, id: string): Promise<Task> {
    return runTurn(this.db, c => this.prepareApproval(c, actor, id), this.admitLocalTurn);
  }
  async approveTaskIn(c: DbSession, actor: string, id: string, reuseSession?: string): Promise<Task> {
    const plan = await this.prepareApproval(c, actor, id, reuseSession);
    return 'existing' in plan ? plan.existing : plan.commit();
  }
  private async prepareApproval(c: DbSession, actor: string, id: string, reuseSession?: string): Promise<TurnPlan> {
    const task = await this.visibleTask(c, actor, id);
    const installation = await this.eligible(c, task);
    assertApprover(actor, task, installation);
    if (task.status === 'queued' || task.status==='running') return { existing:task };
    assertTransition(task.status, 'queued');
    const managed = task.session_id ? (await c.select().from(s.agentSessions).where(eq(s.agentSessions.id, task.session_id)))[0] : undefined;
    if (managed?.managed && managed.state === 'ended') throw new AppError(409, 'session_ended');
    reuseSession ??= managed?.managed ? managed.id : undefined;
    const target = await directTurnTarget(c, installation, managed, task.revision);
    const commit = async () => {
      const direct = !!target;
      const sessionId = reuseSession ?? randomUUID(), executionId = randomUUID();
      if (reuseSession) {
        const found = await c.select().from(s.agentSessions).where(and(eq(s.agentSessions.id, reuseSession), eq(s.agentSessions.origin_thread_id, task.thread_id), eq(s.agentSessions.installation_id, task.installation_id)));
        if (!found.length) throw new AppError(409, 'invalid_session');
      } else await c.insert(s.agentSessions).values({ id: sessionId, workspace_id: task.workspace_id, installation_id: task.installation_id, origin_thread_id: task.thread_id });
      await c.insert(s.executions).values({ id: executionId, workspace_id: task.workspace_id, task_id: task.id, installation_id: task.installation_id, session_id: sessionId, status: 'queued' });
      const [result] = await c.update(s.tasks).set({ status: direct ? 'running' : 'queued', approved_by: actor, session_id: sessionId, active_execution_id: executionId, revision: sql`${s.tasks.revision}+1`, updated_at: now }).where(and(eq(s.tasks.id, id), eq(s.tasks.revision, task.revision))).returning();
      if (!result) throw new SessionConflict();
      await c.insert(s.outbox).values({ id: randomUUID(), task_id: task.id, execution_id: executionId, ...(direct ? {direct:true,direct_connection:target.connection,state:'delivering' as const,attempts:1,lease_token:randomUUID(),lease_until:sql`now()+interval '31 minutes'`} : {}) });
      // Direct attempts have a fixed deadline and are never renewed or reclaimed.
      if(direct) await c.execute(sql`SELECT pg_notify('space_direct_turn',${JSON.stringify({task_id:task.id})})`);
      await this.append(c, result!, 'task.approved', actor, { execution_id: executionId });
      traceTurn(c, task.id, 'approval', 'approved');
      traceTurn(c, task.id, 'dispatch', direct ? 'direct' : 'queued');
      if(await navigatorPresent(c))await c.execute(sql`UPDATE agent_thread_subscriptions SET session_id=${sessionId},approved_by=${actor} WHERE task_id=${id} AND status='active'`);
      return result!;
    };
    return { target, commit };
  }
  async rejectTask(actor: string, id: string): Promise<Task> {
    return this.taskTransaction(id, async c => {
      const task = await this.visibleTask(c, actor, id);
      assertApprover(actor, task, await this.installation(c, task.installation_id, await this.managed(c, task.session_id)));
      assertTransition(task.status, 'rejected');
      const [result] = await c.update(s.tasks).set({ status: 'rejected', revision: sql`${s.tasks.revision}+1`, updated_at: now }).where(and(eq(s.tasks.id, id), eq(s.tasks.revision, task.revision))).returning();
      if (!result) throw new SessionConflict();
      await this.append(c, result!, 'task.rejected', actor, {});
      traceTurn(c, task.id, 'approval', 'rejected');
      traceTurn(c, task.id, 'outcome', 'rejected');
      if(await navigatorPresent(c))await c.execute(sql`UPDATE agent_thread_subscriptions SET status='closed' WHERE task_id=${id}`);
      return result!;
    });
  }
  async readTask(actor: string, id: string): Promise<Task> { return this.db.transaction(c => this.visibleTask(c, actor, id)); }
  async events(actor: string, id: string, after: number): Promise<WorkplaceEvent[]> {
    if (!Number.isSafeInteger(after) || after < 0) throw new AppError(400, 'invalid_cursor');
    return this.db.transaction(async c => {
      await this.visibleTask(c, actor, id);
      const events = await c.select().from(s.taskEvents).where(and(eq(s.taskEvents.correlation_id, id), gt(s.taskEvents.sequence, after))).orderBy(s.taskEvents.sequence).limit(200);
      return events.map(event => ({ ...event, occurred_at: event.occurred_at.toISOString() }));
    });
  }
  async messages(actor: string, thread: string): Promise<{ text: string; task_id: string | null }[]> {
    return this.db.transaction(async c => {
      if (!await hasThreadAccess(c, actor, uuid(thread))) throw notFound();
      const [ref] = await c.select({ channel_id: s.threads.channel_id }).from(s.threads).where(eq(s.threads.id, thread));
      return c.select({ id: s.messages.id, thread_id: s.messages.thread_id, task_id: s.messages.task_id, installation_id: s.messages.installation_id, text: s.messages.text, created_at: s.messages.created_at })
        .from(s.messages).where(and(eq(s.messages.channel_id, ref!.channel_id), eq(s.messages.thread_id, thread))).orderBy(s.messages.created_at, s.messages.id).limit(200);
    });
  }
  async installations(actor: string, workspace: string): Promise<AgentInstallation[]> { return new FoundationStore(this.pool).list(actor, workspace); }
  async failUnstartedDelivery(delivery: Delivery, code: string): Promise<boolean> {
    return this.taskTransaction(delivery.task_id, async c => {
      const [execution] = await c.select().from(s.executions).where(eq(s.executions.id,delivery.execution_id));
      if (!execution || execution.last_sequence > 0) return false;
      // The task revision fences a concurrent first-event commit. A retry rechecks the execution.
      await this.failDeliveryIn(c,delivery,code,true);
      return true;
    });
  }
  async directDelivery(taskId: string, installationId?: string): Promise<(Delivery & {installation_id:string;connection_id:string;last_sequence:number;status:string}) | undefined> {
    const result = await this.db.execute<Delivery & {installation_id:string;connection_id:string;last_sequence:number;status:string} & Record<string,unknown>>(sql`
      SELECT o.*,t.installation_id,o.direct_connection AS connection_id,e.last_sequence,t.status FROM outbox o JOIN tasks t ON t.id=o.task_id
      JOIN executions e ON e.id=o.execution_id JOIN agent_connections ac ON ac.installation_id=t.installation_id
      WHERE o.task_id=${uuid(taskId)} AND o.direct AND o.state='delivering' AND t.active_execution_id=e.id
      ${installationId ? sql`AND t.installation_id=${uuid(installationId)}` : sql``}`);
    return result.rows[0];
  }
  async claimDelivery(localInstallation?: string, deliveryId?: string): Promise<Delivery | null> {
    // Compatibility for one-shot callers; broker consumers always supply the durable event target.
    if (!deliveryId) {
      const candidate = await this.db.execute<{ id: string }>(sql`SELECT o.id FROM outbox o JOIN tasks t ON t.id=o.task_id JOIN agent_installations i ON i.id=t.installation_id
        WHERE NOT o.direct AND o.state='pending' AND o.available_at<=now() AND ${localInstallation ? sql`i.id=${uuid(localInstallation)} AND EXISTS(SELECT 1 FROM agent_connections ac WHERE ac.installation_id=i.id)` : sql`NOT EXISTS(SELECT 1 FROM agent_connections ac WHERE ac.installation_id=i.id)`} ORDER BY o.available_at,o.id LIMIT 1`);
      deliveryId = candidate.rows[0]?.id;
      if (!deliveryId) return null;
    }
    const result = await this.db.execute<Delivery & Record<string, unknown>>(sql`UPDATE outbox o
      SET state='delivering',attempts=attempts+1,lease_until=now()+interval '30 seconds',lease_token=${randomUUID()}
      FROM tasks t JOIN agent_installations i ON i.id=t.installation_id
      WHERE o.id=${uuid(deliveryId)} AND NOT o.direct AND t.id=o.task_id AND o.state='pending' AND o.available_at<=now()
      AND ${localInstallation ? sql`i.id=${uuid(localInstallation)} AND EXISTS(SELECT 1 FROM agent_connections ac WHERE ac.installation_id=i.id)` : sql`NOT EXISTS(SELECT 1 FROM agent_connections ac WHERE ac.installation_id=i.id)`}
      RETURNING o.*`);
    // Duplicate ready events never invalidate a healthy attempt; its exact deadline owns recovery.
    return result.rows[0] ?? null;
  }
  private async localConnection(c: DbSession, installationId: string, connectionId?: string, optimistic = false) {
    if (connectionId === undefined) return;
    const query = c.select({ id: s.agentConnections.installation_id }).from(s.agentConnections)
      .where(and(eq(s.agentConnections.installation_id, installationId), eq(s.agentConnections.connection_id, connectionId), eq(s.agentConnections.auth_status, 'ready'), sql`${s.agentConnections.revoked_at} IS NULL`, sql`${s.agentConnections.last_seen_at}>now()-interval '45 seconds'`));
    const rows = await query;
    if (!rows.length) throw new AppError(401, 'unauthorized');
  }
  async prepareDelivery(delivery: Delivery, connectionId?: string): Promise<PreparedDelivery | null> {
    const prepared: PreparedDelivery | null = await this.taskTransaction(delivery.task_id, async c => {
      const task = await this.task(c, delivery.task_id);
      if (task.status === 'completed' || task.status === 'failed') return null;
      if (!['queued', 'running'].includes(task.status) || task.active_execution_id !== delivery.execution_id) throw new AppError(409, 'stale_execution');
      const lease = await c.select({ id: s.outbox.id }).from(s.outbox).where(this.liveAttempt(delivery));
      if (!lease.length) throw new AppError(409, 'stale_lease');
      const installation = await this.eligible(c, task);
      await this.localConnection(c, installation.id, connectionId, await this.managed(c, task.session_id));
      const [origin]=await navigatorPresent(c)?(await c.execute<{through_sequence:string}>(sql`SELECT through_sequence::text FROM navigator_decisions WHERE decision->>'task_id'=${task.id} LIMIT 1`)).rows:[];
      const thread=(await c.select().from(s.threads).where(eq(s.threads.id,task.thread_id)))[0]!;
      const working_memory = await readThreadContext(c, thread.channel_id, task.thread_id, origin?.through_sequence);
      const context: NonNullable<InvocationRequest['context']> = { thread_id: task.thread_id, working_memory, messages: working_memory.messages.filter(m => m.text.trim()).map(m => ({ id: m.id, text: m.text, author_type: m.author.kind })) };
      context.channel_memory = await readChannelMemory(c, thread.channel_id, undefined, undefined, undefined, { countTopics: false });
      const notes = await readKnowledgeContext(c, thread.channel_id, task);
      if (notes) context.knowledge_notes = notes;
      if (task.session_id) {
        const own = await readSessionMemory(c, thread.channel_id, task.session_id, task.installation_id).catch(error => {
          if (error instanceof AppError && (error.code === 'session_ended' || error.code === 'session_private')) return undefined;
          throw error;
        });
        if (own) context.agent_session_memory = own;
      }
      const [session] = await c.select().from(s.agentSessions).where(eq(s.agentSessions.id, task.session_id!));
      if (session?.handoff_context) context.handoff = session.handoff_context;
      const priorReady = session?.managed && (await c.execute(sql`SELECT 1 FROM tasks previous JOIN task_events e ON e.correlation_id=previous.id AND e.payload->>'session_ready'='true' WHERE previous.session_id=${task.session_id} AND previous.id<>${task.id} LIMIT 1`)).rows.length > 0;
      return { installation, request: { ...(session?.managed ? { persistent_session: { resume: Boolean(priorReady) } } : {}), schema_version: '1.0', task_id: task.id, session_id: task.session_id!, execution_id: delivery.execution_id, idempotency_key: delivery.execution_id, goal: task.goal, skill: task.skill, context } };
    });
    if (prepared && this.outboundAccess) prepared.request.outbound = await this.outboundAccess(prepared.request.execution_id,prepared.installation.id);
    if (!prepared || !this.memoryReader || prepared.request.context?.handoff) return prepared;
    const task = await this.task(this.db, delivery.task_id);
    const memory = await this.memoryReader(task);
    // Provider I/O does not hold a database connection. Revalidate the delivery afterwards.
    await this.taskTransaction(delivery.task_id, async c => {
      const current = await this.task(c, delivery.task_id);
      if (!['queued', 'running'].includes(current.status) || current.active_execution_id !== delivery.execution_id) throw new AppError(409, 'stale_execution');
      await this.eligible(c, current);
      await this.localConnection(c, prepared.installation.id, connectionId);
      if (!(await c.select({ id: s.outbox.id }).from(s.outbox).where(this.liveAttempt(delivery))).length) throw new AppError(409, 'stale_lease');
    });
    if (memory) prepared.request.context!.channel_notes = memory;
    return prepared;
  }

  async acceptEvent(installationId: string, raw: unknown, delivery?: Delivery, connectionId?: string): Promise<void> {
    const event = parseAgentEvent(raw);
    const [executionRef] = await this.db.select({ task_id: s.executions.task_id }).from(s.executions).where(and(eq(s.executions.id, event.execution_id), eq(s.executions.installation_id, installationId)));
    if (!executionRef) throw notFound();
    await this.taskTransaction(executionRef.task_id, async c => {
      const [ref] = await c.select().from(s.executions).where(and(eq(s.executions.id, event.execution_id), eq(s.executions.installation_id, installationId)));
      if (!ref) throw notFound();
      const task = await this.task(c, ref.task_id);
      const optimistic = await this.managed(c, task.session_id);
      if (delivery) {
        await this.eligible(c, task);
        await this.localConnection(c, installationId, connectionId, await this.managed(c, task.session_id));
        if (delivery.execution_id !== event.execution_id || delivery.task_id !== task.id) throw new AppError(409, 'stale_execution');
        const leaseQuery = c.select({ id: s.outbox.id }).from(s.outbox).where(this.liveAttempt(delivery));
        if (!(await leaseQuery).length) throw new AppError(409, 'stale_lease');
      }
      const [previous] = await c.select({ same: sql<boolean>`${s.agentEventReceipts.event}=${JSON.stringify(event)}::jsonb` })
        .from(s.agentEventReceipts).where(and(eq(s.agentEventReceipts.installation_id, installationId), eq(s.agentEventReceipts.event_id, event.id)));
      if (previous) {
        if (!previous.same) throw new AppError(409, 'event_id_conflict');
        return;
      }
      if (!delivery) await this.eligible(c,task);
      if (task.active_execution_id !== event.execution_id || !['queued', 'running'].includes(task.status)) throw new AppError(409, 'stale_execution');
      const executionQuery = c.select().from(s.executions).where(eq(s.executions.id, event.execution_id));
      const execution = (await executionQuery)[0]!;
      if (event.sequence !== execution.last_sequence + 1) throw new AppError(409, 'event_out_of_order');
      if ((event.type === 'execution.started' && execution.status !== 'queued') || (event.type !== 'execution.started' && execution.status !== 'running')) throw new AppError(409, 'invalid_transition');
      if (event.payload.session_ready) {
        const ready = await c.execute(sql`SELECT 1 FROM agent_sessions a JOIN agent_installations i ON i.id=a.installation_id JOIN agent_definitions d ON d.id=i.definition_id WHERE a.id=${task.session_id} AND a.managed AND d.capabilities->>'persistent_sessions'='true'`);
        if (!ready.rows.length) throw new AppError(400, 'invalid_session_ready');
      }
      const next = event.type === 'execution.completed' ? 'completed' : event.type === 'execution.failed' ? 'failed' : 'running';
      if (task.status !== next) assertTransition(task.status, next);
      await c.insert(s.agentEventReceipts).values({ installation_id: installationId, event_id: event.id, event });
      const changedExecution = await c.update(s.executions).set({ status: next, last_sequence: event.sequence }).where(and(eq(s.executions.id, event.execution_id), eq(s.executions.last_sequence, execution.last_sequence), eq(s.executions.status, execution.status))).returning({ id: s.executions.id });
      const changedTask = await c.update(s.tasks).set({ status: next, result: next === 'completed' ? event.payload.text : null, revision: sql`${s.tasks.revision}+1`, updated_at: now }).where(and(eq(s.tasks.id, task.id), eq(s.tasks.revision, task.revision))).returning({ id: s.tasks.id });
      if (!changedExecution.length || !changedTask.length) throw new SessionConflict();
      if (event.type === 'execution.started') traceTurn(c, task.id, 'execution', 'started');
      await traceToolChanges(c, task.id, event.payload.response?.tools);
      await this.append(c, task, event.type, installationId, { ...event.payload, agent_event_id: event.id, agent_sequence: event.sequence, agent_occurred_at: event.occurred_at }, event.id);
      if (next === 'completed' || next === 'failed') traceTurn(c, task.id, 'outcome', next);
      const session = task.session_id ? (await c.select().from(s.agentSessions).where(eq(s.agentSessions.id, task.session_id)))[0] : undefined;
      const managed = session?.managed;
      const incomingOutputs = event.payload.response?.outputs;
      if (managed && incomingOutputs) {
        const changedSession = await c.update(s.agentSessions).set({ revision: session.revision + 1, outputs: {
          ...(incomingOutputs.preview ?? session.outputs.preview ? { preview: incomingOutputs.preview ?? session.outputs.preview } : {}),
          files: mergeOutputPaths(session.outputs.files, incomingOutputs.files),
          changes: mergeOutputPaths(session.outputs.changes, incomingOutputs.changes),
        } }).where(and(eq(s.agentSessions.id, session.id), eq(s.agentSessions.revision, session.revision))).returning({ id: s.agentSessions.id });
        if (!changedSession.length) throw new SessionConflict();
      }
      const conversational = !managed && await navigatorPresent(c)?await c.execute(sql`SELECT 1 FROM navigator_decisions WHERE route IN ('mention','subscription','accepted') AND decision->>'task_id'=${task.id} LIMIT 1`):{rows:[]};
      if (conversational.rows.length && (event.type === 'execution.progress'||event.type==='execution.failed') && !event.payload.response) {
        await c.insert(s.messages).values({ id: randomUUID(), workspace_id: task.workspace_id, channel_id: (await c.select().from(s.threads).where(eq(s.threads.id, task.thread_id)))[0]!.channel_id, thread_id: task.thread_id, task_id: task.id, installation_id: installationId, text: event.payload.text, agent_milestone:true });
      }
      if (next === 'completed') {
        const thread = (await c.select().from(s.threads).where(eq(s.threads.id, task.thread_id)))[0]!;
        if (!managed) await c.insert(s.messages).values({ id: randomUUID(), channel_id: thread.channel_id, workspace_id: task.workspace_id, thread_id: task.thread_id, task_id: task.id, installation_id: installationId, text: event.payload.text, agent_response: event.payload.response });
        await this.append(c, task, 'task.completed', installationId, { result: event.payload.text, ...(event.payload.response ? { response: event.payload.response } : {}) }, event.id);
        const memory = event.payload.response?.memory;
        if (memory) {
          const [definition] = (await c.execute<{ name: string }>(sql`SELECT d.name FROM agent_installations i JOIN agent_definitions d ON d.id=i.definition_id WHERE i.id=${installationId}`)).rows;
          if (memory.notes?.length) {
            const [human] = (await c.execute<{ id: string }>(sql`SELECT id FROM messages WHERE channel_id=${thread.channel_id} AND thread_id=${task.thread_id} AND author_type='human' AND agent_session_id IS NULL AND deleted_at IS NULL AND retained_at IS NULL ORDER BY sequence DESC LIMIT 1`)).rows;
            const notes = await saveTurnNotes(c, { channelId: thread.channel_id, installationId, producer: { id: installationId, name: definition?.name ?? 'Agent' }, notes: memory.notes, fallbackMessageId: human?.id ?? null });
            for (const outcome of notes) traceTurn(c, task.id, 'note', outcome);
          }
        }
      } else if (next === 'failed') await this.append(c, task, 'task.failed', installationId, { error: event.payload.text, ...(event.payload.response ? { response: event.payload.response } : {}) }, event.id);
    });
  }
  async wasSessionStopped(delivery: Delivery, installationId: string, connectionId: string): Promise<boolean> {
    return this.taskTransaction(delivery.task_id, async c => {
      const task = await this.task(c, delivery.task_id);
      if (task.installation_id !== installationId || task.active_execution_id !== delivery.execution_id || task.status !== 'failed') return false;
      const stopped = await c.execute(sql`SELECT 1 FROM agent_sessions a JOIN outbox o ON o.task_id=${task.id}
        WHERE a.id=${task.session_id} AND a.managed AND o.id=${delivery.id} AND o.execution_id=${delivery.execution_id}
        AND o.state='dead' AND o.last_error='session_stopped'
        AND EXISTS (SELECT 1 FROM task_events WHERE correlation_id=${task.id} AND type='task.failed' AND payload->>'code'='session_stopped')`);
      if (!stopped.rows.length) return false;
      // Ended sessions may acknowledge their explicit stop; current authority must still hold.
      await this.eligible(c, task, true, true);
      await this.localConnection(c, installationId, connectionId, await this.managed(c, task.session_id));
      return true;
    });
  }
  async stopTaskIn(c: DbSession, task: Task, actor: string): Promise<void> {
    if (!['awaiting_approval', 'queued', 'running'].includes(task.status)) return;
    const [latest] = await c.select({ payload: s.taskEvents.payload }).from(s.taskEvents)
      .where(and(eq(s.taskEvents.correlation_id, task.id), sql`${s.taskEvents.payload} ? 'response'`)).orderBy(sql`${s.taskEvents.sequence} DESC`).limit(1);
    const response = interruptResponse(c, task.id, latest?.payload.response);
    if (task.active_execution_id) await c.update(s.executions).set({ status: 'failed' }).where(eq(s.executions.id, task.active_execution_id));
    await c.update(s.outbox).set({ state: 'dead', lease_token: randomUUID(), lease_until: null, last_error: 'session_stopped' }).where(eq(s.outbox.task_id, task.id));
    const changedTask = await c.update(s.tasks).set({ status: 'failed', revision: sql`${s.tasks.revision}+1`, updated_at: now }).where(and(eq(s.tasks.id, task.id), eq(s.tasks.revision, task.revision))).returning({ id: s.tasks.id });
    if (!changedTask.length) throw new SessionConflict();
    await this.append(c, task, 'task.failed', actor, { code: 'session_stopped', ...(response ? { response } : {}) });
    traceTurn(c, task.id, 'outcome', 'stopped');
  }
  // Legacy lease columns now hold an attempt fence and an execution deadline, not ownership.
  private attemptFence(delivery: Delivery) {
    return and(eq(s.outbox.id, delivery.id), eq(s.outbox.lease_token, delivery.lease_token), eq(s.outbox.state, 'delivering'));
  }
  private liveAttempt(delivery: Delivery) {
    return and(this.attemptFence(delivery), gt(s.outbox.lease_until, now));
  }
  async renewDelivery(delivery: Delivery, connectionId: string): Promise<boolean> {
    return this.taskTransaction(delivery.task_id, async c => {
      const task = await this.task(c, delivery.task_id);
      if (task.active_execution_id !== delivery.execution_id || !['queued', 'running'].includes(task.status)) throw new AppError(409, 'stale_execution');
      await this.eligible(c, task);
      await this.localConnection(c, task.installation_id, connectionId, await this.managed(c, task.session_id));
      return (await c.update(s.outbox).set({ lease_until: sql`now()+interval '30 seconds'` }).where(this.liveAttempt(delivery)).returning({ id: s.outbox.id })).length > 0;
    });
  }
  async expireDelivery(deliveryId: string, attemptToken: string): Promise<void> {
    const [ref] = await this.db.select({ task_id: s.outbox.task_id }).from(s.outbox).where(eq(s.outbox.id, uuid(deliveryId)));
    if (!ref) return;
    await this.taskTransaction(ref.task_id, async c => {
      // A deadline fences an uncertain execution; it never hands ownership to another worker.
      const expired = await c.execute<Delivery & Record<string, unknown>>(sql`UPDATE outbox
        SET lease_token=${randomUUID()},lease_until=NULL
        WHERE id=${deliveryId} AND lease_token=${uuid(attemptToken)} AND state='delivering' AND lease_until<=now()
        RETURNING *`);
      const delivery = expired.rows[0];
      if (!delivery) return;
      const terminal = await c.select({ status: s.executions.status }).from(s.executions).where(eq(s.executions.id, delivery.execution_id));
      if (terminal.some(row => ['completed','failed'].includes(row.status))) await c.update(s.outbox).set({ state: 'done' }).where(this.attemptFence(delivery));
      else await this.failDeliveryIn(c, delivery, 'execution_interrupted', true);
    });
  }
  async ackDelivery(delivery: Delivery): Promise<boolean> {
    return (await this.db.update(s.outbox).set({ state: 'done', lease_until: null }).where(this.attemptFence(delivery)).returning({ id: s.outbox.id })).length > 0;
  }
  async executionTerminal(id: string): Promise<boolean> {
    return (await this.db.select({ id: s.executions.id }).from(s.executions).where(and(eq(s.executions.id, id), inArray(s.executions.status, ['completed', 'failed'])))).length > 0;
  }
  async failDelivery(delivery: Delivery, code: string, permanent = false): Promise<void> {
    await this.taskTransaction(delivery.task_id, c => this.failDeliveryIn(c, delivery, code, permanent));
  }
  private async failDeliveryIn(c: DbSession, delivery: Delivery, code: string, permanent: boolean): Promise<void> {
      const task = await this.task(c, delivery.task_id);
      const dead = permanent || delivery.attempts >= 3;
      const row = await c.update(s.outbox).set({ state: dead ? 'dead' : 'pending', last_error: code, lease_until: null, available_at: sql`now()+(${2 ** delivery.attempts} * interval '1 second')` }).where(this.attemptFence(delivery)).returning({ id: s.outbox.id });
      if (!row.length || !dead || ['completed', 'failed'].includes(task.status)) return;
      assertTransition(task.status, 'failed');
      await c.update(s.executions).set({ status: 'failed' }).where(eq(s.executions.id, delivery.execution_id));
      const changedTask = await c.update(s.tasks).set({ status: 'failed', revision: sql`${s.tasks.revision}+1`, updated_at: now }).where(and(eq(s.tasks.id, task.id), eq(s.tasks.revision, task.revision))).returning({ id: s.tasks.id });
      if (!changedTask.length) throw new SessionConflict();
      const [latest] = await c.select({ payload: s.taskEvents.payload }).from(s.taskEvents)
        .where(and(eq(s.taskEvents.correlation_id, task.id), sql`${s.taskEvents.payload} ? 'response'`)).orderBy(sql`${s.taskEvents.sequence} DESC`).limit(1);
      const response = interruptResponse(c, task.id, latest?.payload.response);
      const payload = { code, ...(response ? { response } : {}) };
      await this.append(c, task, 'execution.failed', task.installation_id, payload);
      await this.append(c, task, 'task.failed', task.installation_id, payload);
      traceTurn(c, task.id, 'outcome', 'failed');
  }
}
