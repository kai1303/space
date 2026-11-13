import type {AgentSessionStore} from '@space/postgres/agent-sessions';
import type { FastifyInstance } from 'fastify';
import type { EventBus, EventDelivery } from '@space/events';
import { uuid } from '@space/contracts';
import type { PostgresStore } from '@space/postgres/store';
import type { AssetStore } from '@space/postgres/assets';
import type { AssetStorage } from './storage.js';
import type { ScheduledMessageStore } from '@space/postgres/scheduled-messages';

async function due(message: EventDelivery): Promise<boolean> {
  const timestamp = Date.parse(message.event.available_at ?? '');
  if (Number.isFinite(timestamp) && timestamp > Date.now()) { await message.retry(timestamp-Date.now()); return false; }
  return true;
}

export function registerEventDeadlines(app: FastifyInstance, getEvents: () => Promise<EventBus>, tasks: PostgresStore, assets: AssetStore, storage?: AssetStorage, scheduled?: ScheduledMessageStore, sessions?:AgentSessionStore) {
  const stops: (() => Promise<void>)[] = [];
  app.addHook('onReady', async () => {
    const bus = await getEvents();
    if(sessions) {
      stops.push(await bus.subscribe('task.session_queue.*',{durable:'session-inputs',queue:'session-inputs',maxPending:16},async event=>{
        await sessions.drainQueue(uuid(event.event.aggregate_id));
        await event.ack();
      }));
      stops.push(await bus.subscribe('task.steer_deadline.*',{durable:'session-steer-deadlines',queue:'session-steer-deadlines',maxPending:16},async event=>{
        if(!await due(event)) return;
        await sessions.finishSteer(uuid(event.event.aggregate_id),'uncertain','Delivery could not be confirmed.');
        await event.ack();
      }));
    }
    // Scheduled sends: the broker releases each event at send_at. deliver() is conditional on the schedule
    // version and the send is idempotent, so early, stale and repeated deliveries are safe.
    if (scheduled) stops.push(await bus.subscribe('scheduled.message_due.*', {durable:'scheduled-messages',queue:'scheduled-messages',maxPending:8}, async message => {
      if (!await due(message)) return;
      const {scheduled_id,version} = message.event.data;
      if (typeof scheduled_id !== 'string' || !Number.isSafeInteger(version) || Number(version) < 1) { await message.ack(); return; }
      const remaining = await scheduled.deliver(uuid(scheduled_id), Number(version));
      if (remaining > 0) await message.retry(remaining);
      else await message.ack();
    }));
    stops.push(await bus.subscribe('todo.reminder_due.*', {durable:'todo-reminders',queue:'todo-reminders',maxPending:16}, async message => {
      if (!await due(message)) return;
      const {todo_id,remind_at,reminder_version} = message.event.data;
      const id = uuid(todo_id);
      if (typeof remind_at !== 'string' || !Number.isFinite(Date.parse(remind_at)) || !Number.isSafeInteger(reminder_version) || Number(reminder_version)<1) {
        await message.ack(); return;
      }
      const eligible = `t.id=$1 AND t.remind_at=$2::timestamptz AND t.reminder_version=$3
        AND t.reminder_fired_at IS NULL AND NOT t.completed AND NOT t.archived AND NOT t.deleted
        AND EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=t.workspace_id AND wm.user_id=t.user_id AND wm.active)
        AND (t.message_id IS NULL OR EXISTS(SELECT 1 FROM messages m JOIN channel_members cm
          ON cm.workspace_id=m.workspace_id AND cm.channel_id=m.channel_id AND cm.user_id=t.user_id
          WHERE m.workspace_id=t.workspace_id AND m.channel_id=t.channel_id AND m.id=t.message_id AND m.deleted_at IS NULL AND m.agent_session_id IS NULL))`;
      // The row change and its realtime outbox notification commit together; duplicate deliveries become no-ops.
      const row = (await tasks.pool.query<{remaining:number}>(`WITH fired AS (
        UPDATE hub_todos t SET reminder_fired_at=clock_timestamp(),updated_at=greatest(clock_timestamp(),t.updated_at+interval '1 microsecond') WHERE ${eligible} AND t.remind_at<=now() RETURNING id
      ) SELECT CASE WHEN EXISTS(SELECT 1 FROM fired) THEN 0 ELSE coalesce((
        SELECT greatest(0,extract(epoch FROM (t.remind_at-now()))*1000)::float FROM hub_todos t WHERE ${eligible}
      ),0) END AS remaining`, [id,remind_at,reminder_version])).rows[0]!;
      if (row.remaining>0) await message.retry(row.remaining);
      else await message.ack();
    }));
    stops.push(await bus.subscribe('connection.deadline.*', {durable:'connection-deadlines',queue:'connection-deadlines',maxPending:16}, async message => {
      if (!await due(message)) return;
      const {installation_id,connection_id,last_seen_at} = message.event.data;
      const row = (await tasks.pool.query<{remaining:number}>(`SELECT greatest(0,extract(epoch FROM (last_seen_at+interval '45 seconds'-now()))*1000)::float AS remaining
        FROM agent_connections WHERE installation_id=$1 AND connection_id=$2 AND last_seen_at<=$3::timestamptz`, [uuid(installation_id),uuid(connection_id),last_seen_at])).rows[0];
      if (row?.remaining && row.remaining>0) { await message.retry(row.remaining); return; }
      await tasks.pool.query(`UPDATE agent_connections SET connection_id=NULL
        WHERE installation_id=$1 AND connection_id=$2 AND last_seen_at<=$3::timestamptz
          AND last_seen_at<=now()-interval '45 seconds'`, [uuid(installation_id),uuid(connection_id),last_seen_at]);
      await message.ack();
    }));
    stops.push(await bus.subscribe('delivery.deadline.*', {durable:'delivery-deadlines',queue:'delivery-deadlines',maxPending:16}, async message => {
      if (!await due(message)) return;
      const id = uuid(message.event.data.delivery_id), token = uuid(message.event.data.lease_token);
      const row = (await tasks.pool.query<{remaining:number}>(`SELECT greatest(0,extract(epoch FROM (lease_until-now()))*1000)::float AS remaining
        FROM outbox WHERE id=$1 AND lease_token=$2 AND state='delivering'`,[id,token])).rows[0];
      if (row?.remaining && row.remaining>0) { await message.retry(row.remaining); return; }
      await tasks.expireDelivery(id,token);
      await message.ack();
    }));
    if (storage) stops.push(await bus.subscribe('asset.deadline.*', {durable:'asset-deadlines',queue:'asset-deadlines',maxPending:4}, async message => {
      if (!await due(message)) return;
      const id = uuid(message.event.data.asset_id);
      // Cleanup itself rechecks attachment and processing state for this exact asset.
      await assets.cleanup(key => storage.remove(key),1,id);
      const row = (await tasks.pool.query<{remaining:number}>(`SELECT CASE WHEN deadline IS NULL THEN 0 ELSE
        greatest(0,extract(epoch FROM (greatest(deadline,processing_until)-now()))*1000)::float END AS remaining
        FROM assets CROSS JOIN LATERAL (SELECT least(
          CASE WHEN message_id IS NULL AND task_id IS NULL AND queue_input_id IS NULL THEN expires_at END,
          CASE WHEN status='ready' AND staging_deleted_at IS NULL THEN upload_expires_at END
        ) AS deadline) obligation WHERE id=$1`,[id])).rows[0];
      if (row?.remaining && Number.isFinite(row.remaining) && row.remaining>0) await message.retry(row.remaining);
      else await message.ack();
    }));
  });
  app.addHook('preClose', async () => { for (const stop of stops) await stop(); });
}
