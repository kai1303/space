import { Pool } from 'pg';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';
import { createAuthentication } from '@space/server/auth';

process.once('message', async ({ databaseUrl, natsUrl, origin, secret }) => {
  const pool = new Pool({ connectionString: databaseUrl, max: 20 });
  const auth = createAuthentication(pool, { secret, baseURL: origin });
  const app = createApi(new PostgresStore(pool), { auth, trustedProxies: ['127.0.0.1'], realtime: { eventUrl: natsUrl } });
  app.addHook('onSend', async (req, reply) => { reply.header('x-benchmark-route', req.routeOptions.url || ''); });
  process.once('disconnect', async () => { await app.close(); await pool.end(); });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  process.send({ address });
});
