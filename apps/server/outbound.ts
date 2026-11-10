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
  app.get('/v1/me/connection-calls', (r) => configured().calls(r.actorId, record(r.query, ['before']).before));
  type ScopeParams = { workspaceId?: string };
  type ConnectionParams = ScopeParams & { id: string };
  const scope = (r: { actorId: string; params: ScopeParams }) =>
    r.params.workspaceId === undefined ? r.actorId : { actor: r.actorId, workspace: uuid(r.params.workspaceId) };
  const after = (r: { params: ScopeParams; query: unknown }) =>
    r.params.workspaceId === undefined ? undefined : record(r.query, ['after']).after;

  for (const base of ['/v1/me', '/v1/workspaces/:workspaceId']) {
    app.get<{ Params: ScopeParams }>(`${base}/connections`, (r) => configured().list(scope(r), after(r)));
    app.get<{ Params: ScopeParams }>(`${base}/connection-agents`, (r) => configured().agents(scope(r), after(r)));
    app.post<{ Params: ScopeParams }>(`${base}/connections`, async (r, reply) =>
      reply.code(201).send(await configured().create(scope(r), r.body)),
    );
    app.patch<{ Params: ConnectionParams }>(`${base}/connections/:id`, (r) =>
      configured().update(scope(r), uuid(r.params.id), r.body),
    );
    app.delete<{ Params: ConnectionParams }>(`${base}/connections/:id`, (r) =>
      configured().remove(scope(r), uuid(r.params.id), r.body),
    );
    app.put<{ Params: ConnectionParams }>(`${base}/connections/:id/grants`, (r) =>
      configured().grant(scope(r), uuid(r.params.id), r.body),
    );
    app.post<{ Params: ConnectionParams }>(`${base}/connections/:id/discover`, async (r) => {
      const store = configured(),
        body = record(r.body, ['revision']),
        id = uuid(r.params.id),
        management = scope(r),
        connection = await store.get(management, id);
      if (body.revision !== connection.revision) throw new AppError(409, 'connection_changed');
      const token = store.security.sign({
        owner: r.actorId,
        workspace: typeof management === 'string' ? undefined : management.workspace,
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
        await response.body?.cancel();
        if (response.status === 409) throw new AppError(409, 'connection_changed');
        if (response.status === 403 || response.status === 404) await store.get(management, id);
        if (!response.ok) throw new AppError(502, 'mcp_discovery_failed');
        return store.get(management, id);
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw new AppError(502, 'mcp_gateway_unavailable');
      }
    });
  }
}
