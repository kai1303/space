import { workflowChatConfig } from './workflow-chat.js';
import { huddleMedia } from './huddle-media.js';
import {outboundOptions} from './outbound.js';
import { typesenseConfig } from './typesense.js';
import { invitationEmailConfig, createInvitationMailer } from './invitation-email.js';
import { createPool } from '@space/postgres/database';
import { PostgresStore } from '@space/postgres/store';
import { createAuthentication } from './auth.js';
import { createApi } from './api.js';
import { RedisSocketAdapter } from '@space/redis';
import { createAssetStorageFromEnv } from './storage.js';
import { configuredAgentConnectors } from './agent-connectors.js';
if (!process.env.BETTER_AUTH_SECRET || !process.env.BETTER_AUTH_URL) throw new Error('BETTER_AUTH_SECRET and BETTER_AUTH_URL are required');
if (process.env.NODE_ENV === 'production' && !process.env.NATS_URL) throw new Error('NATS_URL is required');
const pairedConnectors = configuredAgentConnectors(process.env.SPACE_CLOUD_CONNECTORS);
const storage = createAssetStorageFromEnv();
const adapter = process.env.REDIS_URL ? new RedisSocketAdapter(process.env.REDIS_URL) : undefined;
// Typing is best effort. Chat admission and replay remain available during a Redis outage.
void adapter?.connect().catch(() => console.error('typing_transport_unavailable'));
const pool = createPool(process.env.DATABASE_URL);
const emailConfig = invitationEmailConfig();
const invitationEmail = emailConfig ? {config:emailConfig,mailer:createInvitationMailer(emailConfig)} : undefined;
const auth = createAuthentication(pool, { secret: process.env.BETTER_AUTH_SECRET, baseURL: process.env.BETTER_AUTH_URL, sendVerificationEmail:invitationEmail?.mailer.verification, trustedOrigins: process.env.AUTH_TRUSTED_ORIGINS?.split(',').filter(Boolean) });
const app = createApi(new PostgresStore(pool), { workflowChat: workflowChatConfig(), monitoring: process.env.SPACE_MONITORING_ENABLED === 'true' ? { host: '0.0.0.0', port: 9464 } : undefined, huddles: huddleMedia(), outbound: outboundOptions(), search: typesenseConfig(), logger: true, auth, storage, invitationEmail, pairedConnectors, trustedProxies: process.env.TRUSTED_PROXY_CIDRS?.split(',').filter(Boolean), allowDevelopmentTokens: process.env.ALLOW_DEVELOPMENT_TOKENS === 'true', realtime: { adapter,
  maxConnections: Number(process.env.REALTIME_MAX_CONNECTIONS ?? 1000), maxActorConnections: Number(process.env.REALTIME_MAX_ACTOR_CONNECTIONS ?? 8),
  workConcurrency: Number(process.env.REALTIME_WORK_CONCURRENCY ?? 4), workQueue: Number(process.env.REALTIME_WORK_QUEUE ?? 512) } });
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
