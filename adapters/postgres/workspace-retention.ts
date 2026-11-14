import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { uuid } from '@space/contracts';
import { database, type DbSession } from './database.js';
import { syncSavedMemory } from './memory-sources.js';
import { sessionTransaction } from './session-concurrency.js';

const tombstone = 'Message removed by workspace retention.';
const versionOf = (value: unknown): string => {
  if (typeof value !== 'string' || !/^\d{1,18}$/.test(value)) throw new Error('invalid retention version');
  return value;
};
export async function eraseMessageReferences(c: DbSession, workspace: string, channel: string, message: string) {
  await syncSavedMemory(c, channel);
  const assets=await c.execute<{id:string;staging_key:string;object_key:string}>(sql`DELETE FROM assets WHERE workspace_id=${workspace} AND channel_id=${channel} AND message_id=${message} RETURNING id,staging_key,object_key`);
  for (const asset of assets.rows) {
    const keys=JSON.stringify([asset.staging_key,asset.object_key,`previews/${asset.id}/display.webp`,`previews/${asset.id}/thumbnail.webp`]);
    await c.execute(sql`INSERT INTO retention_asset_deletions(id,object_keys) VALUES(${asset.id},${keys}::jsonb) ON CONFLICT DO NOTHING`);
    await c.execute(sql`INSERT INTO event_outbox(kind,aggregate_id,payload) VALUES('retention.asset_delete',${asset.id},jsonb_build_object('asset_id',${asset.id}::text))`);
  }
  await c.execute(sql`DELETE FROM message_reactions WHERE channel_id=${channel} AND message_id=${message}`);
  await c.execute(sql`DELETE FROM notifications WHERE workspace_id=${workspace} AND channel_id=${channel} AND message_id=${message}`);
  await c.execute(sql`DELETE FROM mention_notifications WHERE workspace_id=${workspace} AND channel_id=${channel} AND message_id=${message}`);
  await c.execute(sql`DELETE FROM hub_saved_messages WHERE workspace_id=${workspace} AND channel_id=${channel} AND message_id=${message}`);
}

export class WorkspaceRetentionStore {
  readonly db;
  constructor(readonly pool: Pool) { this.db = database(pool); }

  async backfill(workspace: string, version: string, after: string): Promise<number> {
    workspace=uuid(workspace); version=versionOf(version); after=after==='00000000-0000-0000-0000-000000000000'?after:uuid(after);
    return sessionTransaction(this.db, async c => {
      const policy = (await c.execute(sql`SELECT 1 FROM workspace_preferences WHERE workspace_id=${workspace} AND retention_version=${version}::bigint AND retention_days IS NOT NULL`)).rows[0];
      if (!policy) return 0;
      const claim = await c.execute(sql`INSERT INTO workspace_retention_batches(workspace_id,version,after_id) VALUES(${workspace},${version}::bigint,${after}) ON CONFLICT DO NOTHING RETURNING after_id`);
      if (!claim.rows.length) return 0;
      const page = await c.execute<{id:string}>(sql`SELECT id FROM messages WHERE workspace_id=${workspace} AND retained_at IS NULL AND deleted_at IS NULL AND id>${after}::uuid ORDER BY id LIMIT 100`);
      if (!page.rows.length) return 0;
      const last=page.rows.at(-1)!.id;
      await c.execute(sql`INSERT INTO event_outbox(kind,aggregate_id,payload,available_at)
        SELECT 'retention.message_due',m.id::text,jsonb_build_object('workspace_id',m.workspace_id,'channel_id',m.channel_id,'message_id',m.id,'version',p.retention_version::text),m.created_at+make_interval(days=>p.retention_days)
        FROM messages m JOIN workspace_preferences p ON p.workspace_id=m.workspace_id WHERE m.workspace_id=${workspace} AND m.retained_at IS NULL AND m.deleted_at IS NULL AND m.id>${after}::uuid AND m.id<=${last}::uuid`);
      if (page.rows.length===100) await c.execute(sql`INSERT INTO event_outbox(kind,aggregate_id,payload) VALUES('retention.backfill',${workspace},jsonb_build_object('workspace_id',${workspace}::text,'version',${version}::text,'after_id',${last}::text))`);
      return page.rows.length;
    });
  }

  async expire(workspace: string, channel: string, message: string, version: string): Promise<number> {
    workspace=uuid(workspace); channel=uuid(channel); message=uuid(message); version=versionOf(version);
    return sessionTransaction(this.db, async c => {
      const row=(await c.execute<{remaining:number}>(sql`SELECT greatest(0,extract(epoch FROM (m.created_at+make_interval(days=>p.retention_days)-now()))*1000)::float AS remaining
        FROM messages m JOIN workspace_preferences p ON p.workspace_id=m.workspace_id
        WHERE m.workspace_id=${workspace} AND m.channel_id=${channel} AND m.id=${message} AND m.retained_at IS NULL AND m.deleted_at IS NULL AND p.retention_days IS NOT NULL`)).rows[0];
      if (!row) return 0;
      if (row.remaining>0) return row.remaining;
      const busy=(await c.execute<{remaining:number}>(sql`SELECT greatest(0,extract(epoch FROM (max(processing_until)-now()))*1000)::float AS remaining FROM assets WHERE workspace_id=${workspace} AND channel_id=${channel} AND message_id=${message}`)).rows[0];
      if (busy?.remaining && busy.remaining>0) return busy.remaining;
      const updated=await c.execute(sql`UPDATE messages SET text=${tombstone},document=NULL,attachments='[]'::jsonb,agent_response=NULL,retained_at=now(),reaction_sequence=reaction_sequence+1 WHERE workspace_id=${workspace} AND channel_id=${channel} AND id=${message} AND retained_at IS NULL AND deleted_at IS NULL RETURNING id`);
      if (!updated.rows.length) return 0;
      await eraseMessageReferences(c, workspace, channel, message);
      await c.execute(sql`UPDATE channel_events SET payload=retained_message_payload(payload) WHERE workspace_id=${workspace} AND channel_id=${channel} AND type IN ('message.created','message.updated') AND payload->>'id'=${message}`);
      await c.execute(sql`UPDATE hub_todos SET title=${tombstone},document=NULL,deleted=true,remind_at=NULL,updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond') WHERE workspace_id=${workspace} AND channel_id=${channel} AND message_id=${message}`);
      await c.execute(sql`WITH revision AS (UPDATE channels SET event_sequence=event_sequence+1 WHERE workspace_id=${workspace} AND id=${channel} RETURNING event_sequence)
        INSERT INTO channel_events(workspace_id,channel_id,thread_id,sequence,type,payload)
        SELECT m.workspace_id,m.channel_id,m.thread_id,r.event_sequence,'message.updated',retained_message_payload(chat_message_payload(m)) FROM messages m CROSS JOIN revision r WHERE m.workspace_id=${workspace} AND m.channel_id=${channel} AND m.id=${message}`);
      await c.execute(sql`INSERT INTO chat_delivery_outbox(workspace_id,channel_id,resource_scope) VALUES(${workspace},${channel},'message'),(${workspace},${channel},'metadata')`);
      return 0;
    });
  }

  async deleteAsset(id: string, remove: (key:string)=>Promise<void>): Promise<void> {
    id=uuid(id);
    const row=(await this.pool.query<{object_keys:string[]}>('SELECT object_keys FROM retention_asset_deletions WHERE id=$1',[id])).rows[0];
    if (!row) return;
    // Keep the durable obligation until every idempotent object deletion succeeds.
    for (const key of row.object_keys) await remove(key);
    await this.pool.query('DELETE FROM retention_asset_deletions WHERE id=$1',[id]);
  }
}
