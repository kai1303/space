import type { FastifyInstance } from 'fastify';
import type { EventBus, EventDelivery } from '@space/events';
import { uuid } from '@space/contracts';
import type { PostgresStore } from '@space/postgres/store';
import type { AssetStore } from '@space/postgres/assets';
import type { AssetStorage } from './storage.js';

async function due(message: EventDelivery): Promise<boolean> {
  const timestamp = Date.parse(message.event.available_at ?? '');
  if (Number.isFinite(timestamp) && timestamp > Date.now()) { await message.retry(timestamp-Date.now()); return false; }
  return true;
}

export function registerEventDeadlines(app: FastifyInstance, getEvents: () => Promise<EventBus>, tasks: PostgresStore, assets: AssetStore, storage?: AssetStorage) {
  const stops: (() => Promise<void>)[] = [];
  app.addHook('onReady', async () => {
    const bus = await getEvents();
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
          CASE WHEN message_id IS NULL THEN expires_at END,
          CASE WHEN status='ready' AND staging_deleted_at IS NULL THEN upload_expires_at END
        ) AS deadline) obligation WHERE id=$1`,[id])).rows[0];
      if (row?.remaining && Number.isFinite(row.remaining) && row.remaining>0) await message.retry(row.remaining);
      else await message.ack();
    }));
  });
  app.addHook('preClose', async () => { for (const stop of stops) await stop(); });
}
