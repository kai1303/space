import type { FastifyInstance } from 'fastify';
import type { PostgresStore } from '@space/postgres/store';
import { OutboundStore } from '@space/postgres/outbound';
import { AppError, record, uuid } from '@space/contracts';
export interface OutboundOptions {
  key: string;
  url: string;
}
export function outboundOptions(): OutboundOptions | undefined {
  const key = process.env.OUTBOUND_MCP_KEY,
    url = process.env.OUTBOUND_MCP_URL;
  if (!key && !url) return undefined;
  if (!key || !url) throw new Error('OUTBOUND_MCP_KEY and OUTBOUND_MCP_URL must be configured together');
  return { key, url };
}
export function registerOutbound(app: FastifyInstance, tasks: PostgresStore, options?: OutboundOptions) {
  let store: OutboundStore | undefined;
  if (options) {
    const url = new URL(options.url),
      loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (
      url.pathname !== '/mcp' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback && process.env.NODE_ENV !== 'production'))
    )
      throw new Error('Invalid OUTBOUND_MCP_URL');
    store = new OutboundStore(tasks.pool, options.key);
    tasks.outboundAccess = (execution, installation) => store!.issue(execution, installation, url.href);
  }
  const configured = () => {
    if (!store) throw new AppError(503, 'outbound_not_configured');
    return store;
  };
  app.get('/v1/me/connections', (r) => configured().list(r.actorId));
  app.get('/v1/me/connection-agents', (r) => configured().agents(r.actorId));
  app.get('/v1/me/connection-calls', (r) => configured().calls(r.actorId, record(r.query, ['before']).before));
  app.post('/v1/me/connections', async (r, reply) =>
    reply.code(201).send(await configured().create(r.actorId, r.body)),
  );
  app.patch<{ Params: { id: string } }>('/v1/me/connections/:id', (r) =>
    configured().update(r.actorId, uuid(r.params.id), r.body),
  );
  app.delete<{ Params: { id: string } }>('/v1/me/connections/:id', (r) =>
    configured().remove(r.actorId, uuid(r.params.id), r.body),
  );
  app.put<{ Params: { id: string } }>('/v1/me/connections/:id/grants', (r) =>
    configured().grant(r.actorId, uuid(r.params.id), r.body),
  );
  app.post<{ Params: { id: string } }>('/v1/me/connections/:id/discover', async (r) => {
    const store = configured(),
      body = record(r.body, ['revision']),
      id = uuid(r.params.id),
      connection = await store.get(r.actorId, id);
    if (body.revision !== connection.revision) throw new AppError(409, 'connection_changed');
    const token = store.security.sign({
      owner: r.actorId,
      installation: '',
      execution: '',
      aud: 'outbound-internal',
      exp: Date.now() + 35000,
    });
    try {
      const response = await fetch(new URL('/internal/discover', options!.url), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ connection_id: id, revision: body.revision }),
        signal: AbortSignal.timeout(35000),
        redirect: 'error',
      });
      if (!response.ok)
        throw new AppError(
          response.status === 409 ? 409 : 502,
          response.status === 409 ? 'connection_changed' : 'mcp_discovery_failed',
        );
      await response.body?.cancel();
      return store.get(r.actorId, id);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(502, 'mcp_gateway_unavailable');
    }
  });
}
