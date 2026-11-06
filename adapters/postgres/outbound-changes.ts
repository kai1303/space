import type { Pool } from 'pg';

// A lost notification channel fails closed. The service must restart before
// dispatching again; live database checks remain authoritative on every request.
export async function watchOutboundChanges(pool: Pool, changed: (owner: string) => void, lost: () => void) {
  const client = await pool.connect();
  let closed = false;
  try {
    const schema = (await client.query('SELECT current_schema() AS schema')).rows[0].schema;
    client.on('notification', (message) => {
      if (message.channel !== 'space_outbound_changed' || !message.payload) return;
      try {
        const event = JSON.parse(message.payload);
        if (event.schema === schema && typeof event.owner === 'string') changed(event.owner);
      } catch {
        /* Ignore malformed notifications. */
      }
    });
    client.on('error', () => {
      if (!closed) lost();
    });
    client.on('end', () => {
      if (!closed) lost();
    });
    await client.query('LISTEN space_outbound_changed');
    return async () => {
      if (closed) return;
      closed = true;
      client.release(true);
    };
  } catch (error) {
    closed = true;
    client.release(true);
    throw error;
  }
}
