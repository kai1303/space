import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';

export async function watchOutboundChanges(pool: Pool, changed: (subject: string) => void, setReady: (ready: boolean) => void) {
  const shutdown = new AbortController();
  const { signal } = shutdown;
  let firstAttempt!: () => void;
  const started = new Promise<void>(resolve => { firstAttempt = resolve; });

  async function listen() {
    let backoff = 500;
    while (!signal.aborted) {
      let client: PoolClient | undefined;
      let disconnected = false;
      let wake!: () => void;
      const ended = new Promise<void>(resolve => { wake = resolve; });
      const lost = () => {
        if (disconnected) return;
        disconnected = true;
        setReady(false);
        wake();
      };
      signal.addEventListener('abort', lost, { once: true });
      try {
        client = await pool.connect();
        client.on('error', lost);
        client.once('end', lost);
        if (signal.aborted) return;
        const schema = (await client.query('SELECT current_schema() AS schema')).rows[0].schema;
        client.on('notification', message => {
          if (disconnected || message.channel !== 'space_outbound_changed' || !message.payload) return;
          try {
            const event = JSON.parse(message.payload);
            if (event.schema === schema && typeof event.owner === 'string') changed(event.owner);
          } catch { /* Ignore malformed notifications. */ }
        });
        await client.query('LISTEN space_outbound_changed');
        if (!disconnected) {
          setReady(true);
          backoff = 500;
        }
        firstAttempt();
        await ended;
      } catch {
        lost();
      } finally {
        // The old client's late end/error events cannot invalidate its replacement.
        disconnected = true;
        signal.removeEventListener('abort', lost);
        client?.release(true);
        firstAttempt();
      }
      if (signal.aborted) return;
      await delay(backoff + Math.random() * backoff, undefined, { signal }).catch(() => {});
      backoff = Math.min(15_000, backoff * 2);
    }
  }

  const listening = listen();
  await started;
  return async () => {
    shutdown.abort();
    await listening;
  };
}
