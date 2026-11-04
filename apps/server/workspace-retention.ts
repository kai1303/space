import type { FastifyInstance } from 'fastify';
import type { EventBus } from '@space/events';
import type { WorkspaceRetentionStore } from '@space/postgres/workspace-retention';
import type { AssetStorage } from './storage.js';

export function registerWorkspaceRetention(app: FastifyInstance, getEvents:()=>Promise<EventBus>, store:WorkspaceRetentionStore, storage?:AssetStorage) {
  const stops:(()=>Promise<void>)[]=[];
  app.addHook('onReady',async()=>{
    const bus=await getEvents();
    stops.push(await bus.subscribe('retention.backfill.*',{durable:'workspace-retention-backfill',queue:'workspace-retention-backfill',maxPending:2},async message=>{
      const data=message.event.data;
      await store.backfill(String(data.workspace_id),String(data.version),String(data.after_id));
      await message.ack();
    }));
    stops.push(await bus.subscribe('retention.message_due.*',{durable:'workspace-retention-messages',queue:'workspace-retention-messages',maxPending:4},async message=>{
      const data=message.event.data;
      const remaining=await store.expire(String(data.workspace_id),String(data.channel_id),String(data.message_id),String(data.version));
      if(remaining>0) await message.retry(remaining); else await message.ack();
    }));
    if(storage) stops.push(await bus.subscribe('retention.asset_delete.*',{durable:'workspace-retention-assets',queue:'workspace-retention-assets',maxPending:4},async message=>{
      await store.deleteAsset(String(message.event.data.asset_id),key=>storage.remove(key));
      await message.ack();
    }));
  });
  app.addHook('preClose',async()=>{for(const stop of stops)await stop();});
}
