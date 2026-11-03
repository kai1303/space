import { createPool } from '@space/postgres/database';
import { PostgresStore } from '@space/postgres/store';
import { createAuthentication } from './auth.js';
import { createApi } from './api.js';
import { RedisSocketAdapter } from '@space/redis';
import { createAssetStorageFromEnv } from './storage.js';
if (!process.env.BETTER_AUTH_SECRET || !process.env.BETTER_AUTH_URL) throw new Error('BETTER_AUTH_SECRET and BETTER_AUTH_URL are required');
const storage = createAssetStorageFromEnv();
const adapter = new RedisSocketAdapter(process.env.REDIS_URL);
await adapter.connect();
const pool = createPool(process.env.DATABASE_URL);
const auth = createAuthentication(pool, { secret: process.env.BETTER_AUTH_SECRET, baseURL: process.env.BETTER_AUTH_URL, trustedOrigins: process.env.AUTH_TRUSTED_ORIGINS?.split(',').filter(Boolean) });
const app = createApi(new PostgresStore(pool), { logger: true, auth, storage, trustedProxies: process.env.TRUSTED_PROXY_CIDRS?.split(',').filter(Boolean), allowDevelopmentTokens: process.env.ALLOW_DEVELOPMENT_TOKENS === 'true', realtime: { adapter } });
app.addHook('onClose', async () => { await pool.end(); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void app.close().catch(() => { app.log.error('shutdown_failed'); process.exitCode = 1; });
});
try {
  await storage?.initialize();
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '127.0.0.1' });
} catch {
  app.log.error('startup_failed');
  await app.close();
  process.exitCode = 1;
}
