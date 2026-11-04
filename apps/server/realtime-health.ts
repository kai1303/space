import type { Pool } from 'pg';
import { streamName } from '@space/events';

// Demand-driven probe: no background scans and no event traffic solely to keep health green.
export async function deliveryHealth(pool: Pick<Pool,'query'>, schema: string) {
  const slots = [`${streamName('*').toLowerCase()}_cdc`, `${streamName(schema).toLowerCase()}_cdc`];
  const [replication, backlog] = await Promise.all([
    pool.query<{active:boolean;retained_bytes:string;wal_status:string}>(
      `SELECT active,coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(),confirmed_flush_lsn),0)::text AS retained_bytes,wal_status
       FROM pg_replication_slots WHERE database=current_database() AND slot_name=ANY($1::text[])`,[slots]),
    pool.query<{age_seconds:number}>(`SELECT GREATEST(0,extract(epoch FROM clock_timestamp()-created_at))::float AS age_seconds
      FROM event_outbox ORDER BY created_at,id LIMIT 1`),
  ]);
  const slot = replication.rows.find(row => row.active && row.wal_status !== 'lost');
  const oldestSeconds = backlog.rows[0]?.age_seconds ?? 0;
  return { ready: !!slot && oldestSeconds < 15, active: !!slot, oldestSeconds,
    retainedBytes: Number(slot?.retained_bytes ?? replication.rows[0]?.retained_bytes ?? 0) };
}
