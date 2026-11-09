import { EventBridge } from './bridge.js';
import { startMessageMetrics } from './message-metrics.js';
const databaseUrl = process.env.DATABASE_URL;
const natsUrl = process.env.NATS_URL;
if (!databaseUrl || !natsUrl) throw new Error('DATABASE_URL and NATS_URL are required');
const bridge = new EventBridge({ databaseUrl, natsUrl, schema: process.env.DATABASE_SCHEMA,
  monitorMessages: process.env.SPACE_MONITORING_ENABLED === 'true', onError: error => console.error('CDC interrupted; retained WAL will replay', error) });
const metrics = startMessageMetrics(bridge);
try { await bridge.start(); } catch (error) { metrics?.close(); throw error; }
console.info('CDC ready');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { metrics?.close(); void bridge.close(); });
