import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { database } from './database.js';

export async function relayChatOutbox(pool: Pool, publish: (channels: (string | null)[]) => Promise<void>): Promise<number> {
  return database(pool).transaction(async tx => {
    const batch = await tx.execute<{ id: string; channel_id: string | null }>(sql`
      SELECT id,channel_id FROM chat_delivery_outbox ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`);
    if (!batch.rows.length) return 0;
    await publish([...new Set(batch.rows.map(row => row.channel_id))]);
    // A failed publish or process crash rolls back the claim. Retrying hints is harmless.
    await tx.execute(sql`DELETE FROM chat_delivery_outbox WHERE id IN (${sql.join(batch.rows.map(row => sql`${row.id}::bigint`), sql`,`)})`);
    return batch.rows.length;
  });
}
