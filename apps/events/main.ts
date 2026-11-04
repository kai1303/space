import { EventBridge } from './bridge.js';
const databaseUrl = process.env.DATABASE_URL;
const natsUrl = process.env.NATS_URL;
if (!databaseUrl || !natsUrl) throw new Error('DATABASE_URL and NATS_URL are required');
const bridge = new EventBridge({ databaseUrl, natsUrl, schema: process.env.DATABASE_SCHEMA, onError: error => console.error('CDC interrupted; retained WAL will replay', error) });
await bridge.start();
console.info('CDC ready');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void bridge.close(); });
