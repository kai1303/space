import { createPool } from '@space/postgres/database';
import { OutboundStore } from '@space/postgres/outbound';
import { createGateway } from './gateway.js';
if (!process.env.OUTBOUND_MCP_KEY || !process.env.OUTBOUND_MCP_URL)
  throw new Error('OUTBOUND_MCP_KEY and OUTBOUND_MCP_URL are required');
const publicUrl = new URL(process.env.OUTBOUND_MCP_URL);
if (
  publicUrl.pathname !== '/mcp' ||
  publicUrl.search ||
  publicUrl.hash ||
  publicUrl.username ||
  publicUrl.password ||
  !(
    publicUrl.protocol === 'https:' ||
    (publicUrl.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(publicUrl.hostname) &&
      process.env.NODE_ENV !== 'production')
  )
)
  throw new Error('OUTBOUND_MCP_URL must be a public HTTPS /mcp endpoint');
const pool = createPool(process.env.DATABASE_URL),
  store = new OutboundStore(pool, process.env.OUTBOUND_MCP_KEY);
const app = createGateway(store, {
  publicUrl: publicUrl.href,
  trustedProxies: process.env.TRUSTED_PROXY_CIDRS?.split(',').filter(Boolean),
});
app.addHook('onClose', () => pool.end());
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app.close();
  });
try {
  await app.listen({ host: process.env.MCP_HOST ?? '127.0.0.1', port: Number(process.env.MCP_PORT ?? 3001) });
} catch {
  await app.close();
  throw new Error('outbound_gateway_start_failed');
}
