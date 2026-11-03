import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { and, eq, gt, inArray, sql, getTableColumns } from 'drizzle-orm';
import { AppError, assertTransition, parseAgentEvent, parseTaskInput, text, uuid, type Task, type AgentInstallation, type WorkplaceEvent } from '@space/contracts';
import { assertEligible, assertApprover } from '@space/core/policy';
import type { Delivery, DeliveryStore, PreparedDelivery } from '@space/core/ports';
import { database, type DbSession } from './database.js';
import * as s from './schema.js';
import { tokenHash } from './bootstrap.js';
import { hasThreadAccess } from './access.js';
import { FoundationStore } from './foundation.js';
const notFound = () => new AppError(404, 'not_found');
const now = sql`now()`;
export class PostgresStore implements DeliveryStore {
  readonly db;
  constructor(readonly pool: Pool, public onChange?: () => Promise<void>) { this.db = database(pool); }
  private async changed<T>(work: Promise<T>): Promise<T> {
    const result = await work;
    await this.onChange?.().catch(() => {});
    return result;
  }
  async health(): Promise<void> { await this.db.execute(sql`SELECT 1`); }
  async authenticate(token: string): Promise<string> {
    const [row] = await this.db.select().from(s.humanCredentials).where(eq(s.humanCredentials.token_hash, tokenHash(token)));
    if (!row) throw new AppError(401, 'unauthorized');
    return row.user_id;
  }
  private async task(c: DbSession, id: string): Promise<Task> {
    const [row] = await c.select().from(s.tasks).where(eq(s.tasks.id, uuid(id))).for('update');
    if (!row) throw notFound();
    return row;
  }
  private async visibleTask(c: DbSession, actor: string, id: string): Promise<Task> {
    const task = await this.task(c, id);
    if (!await hasThreadAccess(c, actor, task.thread_id)) throw notFound();
    return task;
  }
  private async installation(c: DbSession, id: string): Promise<AgentInstallation> {
    const [row] = await c.select({ ...getTableColumns(s.agentInstallations), capabilities: s.agentDefinitions.capabilities })
      .from(s.agentInstallations).innerJoin(s.agentDefinitions, eq(s.agentDefinitions.id, s.agentInstallations.definition_id))
      .where(eq(s.agentInstallations.id, id)).for('share', { of: [s.agentInstallations, s.agentDefinitions] });
    if (!row) throw notFound();
    return row;
  }
  private async eligible(c: DbSession, task: Pick<Task, 'thread_id' | 'installation_id' | 'skill' | 'workspace_id' | 'requester_id'>): Promise<AgentInstallation> {
    // Hold the channel against archive until this task transaction commits.
    const [channel] = await c.select({ archived_at: s.channels.archived_at }).from(s.channels)
      .innerJoin(s.threads, eq(s.threads.channel_id, s.channels.id)).where(eq(s.threads.id, task.thread_id)).for('no key update', { of: s.channels });
    if (channel?.archived_at) throw new AppError(409, 'channel_archived');
    const installation = await this.installation(c, task.installation_id);
    if (installation.workspace_id !== task.workspace_id) throw notFound();
    const grants = await c.select({ skill: s.agentGrants.skill }).from(s.agentGrants)
      .innerJoin(s.threads, and(eq(s.threads.channel_id, s.agentGrants.channel_id), eq(s.threads.workspace_id, s.agentGrants.workspace_id)))
      .where(and(eq(s.agentGrants.installation_id, installation.id), eq(s.threads.id, task.thread_id), eq(s.agentGrants.skill, task.skill)))
      .for('share', { of: s.agentGrants });
    assertEligible(installation, task.skill, grants.length > 0, await hasThreadAccess(c, task.requester_id, task.thread_id), await hasThreadAccess(c, installation.owner_id, task.thread_id));
    return installation;
  }
  private async append(c: DbSession, task: Task, type: string, actor: string, payload: Record<string, unknown>, causationId: string | null = null): Promise<void> {
    await c.insert(s.taskEvents).values({
      id: randomUUID(), type, workspace_id: task.workspace_id, actor_id: actor,
      resource_id: type.startsWith('execution.') ? task.active_execution_id! : task.id,
      correlation_id: task.id, causation_id: causationId,
      sequence: sql`(SELECT coalesce(max(sequence),0)+1 FROM task_events WHERE correlation_id=${task.id})`, payload,
    });
  }
  async createTask(actor: string, rawInput: unknown, key: string): Promise<Task> {
    const input = parseTaskInput(rawInput);
    text(key, 128);
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.changed(this.db.transaction(async c => {
      if (!await hasThreadAccess(c, actor, input.thread_id)) throw notFound();
      const [thread] = await c.select().from(s.threads).where(eq(s.threads.id, input.thread_id));
      if (thread?.workspace_id !== input.workspace_id) throw notFound();
      await this.eligible(c, { ...input, requester_id: actor });
      await c.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.workspace_id}:${actor}:${key}`}))`);
      const [existing] = await c.select().from(s.tasks).where(and(eq(s.tasks.workspace_id, input.workspace_id), eq(s.tasks.requester_id, actor), eq(s.tasks.idempotency_key, key)));
      if (existing) {
        if (existing.request_hash !== hash) throw new AppError(409, 'idempotency_conflict');
        return existing;
      }
      const [task] = await c.insert(s.tasks).values({ id: randomUUID(), ...input, requester_id: actor, status: 'awaiting_approval', idempotency_key: key, request_hash: hash }).returning();
      await this.append(c, task!, 'task.proposed', actor, { goal: task!.goal });
      return task!;
    }));
  }
  async approveTask(actor: string, id: string): Promise<Task> {
    return this.changed(this.db.transaction(async c => {
      const task = await this.visibleTask(c, actor, id);
      const installation = await this.eligible(c, task);
      assertApprover(actor, task, installation);
      if (task.status === 'queued') return task;
      assertTransition(task.status, 'queued');
      const sessionId = randomUUID(), executionId = randomUUID();
      await c.insert(s.agentSessions).values({ id: sessionId, workspace_id: task.workspace_id, installation_id: task.installation_id, origin_thread_id: task.thread_id });
      await c.insert(s.executions).values({ id: executionId, workspace_id: task.workspace_id, task_id: task.id, installation_id: task.installation_id, session_id: sessionId, status: 'queued' });
      const [result] = await c.update(s.tasks).set({ status: 'queued', approved_by: actor, session_id: sessionId, active_execution_id: executionId, revision: sql`${s.tasks.revision}+1`, updated_at: now }).where(eq(s.tasks.id, id)).returning();
      await c.insert(s.outbox).values({ id: randomUUID(), task_id: task.id, execution_id: executionId });
      await this.append(c, result!, 'task.approved', actor, { execution_id: executionId });
      return result!;
    }));
  }
  async rejectTask(actor: string, id: string): Promise<Task> {
    return this.changed(this.db.transaction(async c => {
      const task = await this.visibleTask(c, actor, id);
      assertApprover(actor, task, await this.installation(c, task.installation_id));
      assertTransition(task.status, 'rejected');
      const [result] = await c.update(s.tasks).set({ status: 'rejected', revision: sql`${s.tasks.revision}+1`, updated_at: now }).where(eq(s.tasks.id, id)).returning();
      await this.append(c, result!, 'task.rejected', actor, {});
      return result!;
    }));
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
  async claimDelivery(): Promise<Delivery | null> {
    return this.db.transaction(async c => {
      // Keep the claim atomic across workers; ordinary select-then-update would race.
      const result = await c.execute<Delivery & Record<string, unknown>>(sql`WITH candidate AS (
        SELECT id FROM outbox WHERE (state='pending' AND available_at<=now()) OR (state='delivering' AND lease_until<=now())
        ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE outbox SET state='delivering',attempts=attempts+1,lease_until=now()+interval '30 seconds',lease_token=${randomUUID()}
        FROM candidate WHERE outbox.id=candidate.id RETURNING outbox.*`);
      return result.rows[0] ?? null;
    });
  }
  async prepareDelivery(delivery: Delivery): Promise<PreparedDelivery | null> {
    return this.db.transaction(async c => {
      const task = await this.task(c, delivery.task_id);
      if (task.status === 'completed' || task.status === 'failed') return null;
      if (!['queued', 'running'].includes(task.status) || task.active_execution_id !== delivery.execution_id) throw new AppError(409, 'stale_execution');
      const lease = await c.select({ id: s.outbox.id }).from(s.outbox).where(this.liveLease(delivery));
      if (!lease.length) throw new AppError(409, 'stale_lease');
      const installation = await this.eligible(c, task);
      return { installation, request: { schema_version: '1.0', task_id: task.id, session_id: task.session_id!, execution_id: delivery.execution_id, idempotency_key: delivery.execution_id, goal: task.goal, skill: task.skill } };
    });
  }
  async acceptEvent(installationId: string, raw: unknown): Promise<void> {
    const event = parseAgentEvent(raw);
    await this.changed(this.db.transaction(async c => {
      const [ref] = await c.select().from(s.executions).where(and(eq(s.executions.id, event.execution_id), eq(s.executions.installation_id, installationId)));
      if (!ref) throw notFound();
      const task = await this.task(c, ref.task_id);
      const [previous] = await c.select({ same: sql<boolean>`${s.agentEventReceipts.event}=${JSON.stringify(event)}::jsonb` })
        .from(s.agentEventReceipts).where(and(eq(s.agentEventReceipts.installation_id, installationId), eq(s.agentEventReceipts.event_id, event.id)));
      if (previous) {
        if (!previous.same) throw new AppError(409, 'event_id_conflict');
        return;
      }
      if (task.active_execution_id !== event.execution_id || !['queued', 'running'].includes(task.status)) throw new AppError(409, 'stale_execution');
      const execution = (await c.select().from(s.executions).where(eq(s.executions.id, event.execution_id)).for('update'))[0]!;
      if (event.sequence !== execution.last_sequence + 1) throw new AppError(409, 'event_out_of_order');
      if ((event.type === 'execution.started' && execution.status !== 'queued') || (event.type !== 'execution.started' && execution.status !== 'running')) throw new AppError(409, 'invalid_transition');
      const next = event.type === 'execution.completed' ? 'completed' : event.type === 'execution.failed' ? 'failed' : 'running';
      if (task.status !== next) assertTransition(task.status, next);
      await c.insert(s.agentEventReceipts).values({ installation_id: installationId, event_id: event.id, event });
      await c.update(s.executions).set({ status: next, last_sequence: event.sequence }).where(eq(s.executions.id, event.execution_id));
      await c.update(s.tasks).set({ status: next, result: next === 'completed' ? event.payload.text : null, revision: sql`${s.tasks.revision}+1`, updated_at: now }).where(eq(s.tasks.id, task.id));
      await this.append(c, task, event.type, installationId, { ...event.payload, agent_event_id: event.id, agent_sequence: event.sequence, agent_occurred_at: event.occurred_at }, event.id);
      if (next === 'completed') {
        const thread = (await c.select().from(s.threads).where(eq(s.threads.id, task.thread_id)))[0]!;
        await c.insert(s.messages).values({ id: randomUUID(), channel_id: thread.channel_id, workspace_id: task.workspace_id, thread_id: task.thread_id, task_id: task.id, installation_id: installationId, text: event.payload.text });
        await this.append(c, task, 'task.completed', installationId, { result: event.payload.text }, event.id);
      } else if (next === 'failed') await this.append(c, task, 'task.failed', installationId, { error: event.payload.text }, event.id);
    }));
  }
  private liveLease(delivery: Delivery) {
    return and(eq(s.outbox.id, delivery.id), eq(s.outbox.lease_token, delivery.lease_token), eq(s.outbox.state, 'delivering'), gt(s.outbox.lease_until, now));
  }
  async ackDelivery(delivery: Delivery): Promise<boolean> {
    return (await this.db.update(s.outbox).set({ state: 'done', lease_until: null }).where(this.liveLease(delivery)).returning({ id: s.outbox.id })).length > 0;
  }
  async executionTerminal(id: string): Promise<boolean> {
    return (await this.db.select({ id: s.executions.id }).from(s.executions).where(and(eq(s.executions.id, id), inArray(s.executions.status, ['completed', 'failed'])))).length > 0;
  }
  async failDelivery(delivery: Delivery, code: string, permanent = false): Promise<void> {
    await this.changed(this.db.transaction(async c => {
      const task = await this.task(c, delivery.task_id);
      const dead = permanent || delivery.attempts >= 3;
      const row = await c.update(s.outbox).set({ state: dead ? 'dead' : 'pending', last_error: code, lease_until: null, available_at: sql`now()+(${2 ** delivery.attempts} * interval '1 second')` }).where(this.liveLease(delivery)).returning({ id: s.outbox.id });
      if (!row.length || !dead || ['completed', 'failed'].includes(task.status)) return;
      assertTransition(task.status, 'failed');
      await c.update(s.executions).set({ status: 'failed' }).where(eq(s.executions.id, delivery.execution_id));
      await c.update(s.tasks).set({ status: 'failed', revision: sql`${s.tasks.revision}+1`, updated_at: now }).where(eq(s.tasks.id, task.id));
      await this.append(c, task, 'execution.failed', task.installation_id, { code });
      await this.append(c, task, 'task.failed', task.installation_id, { code });
    }));
  }
}
