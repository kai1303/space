import Fastify from 'fastify';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { AppError, record, uuid } from '@space/contracts';
import type { OutboundStore } from '@space/postgres/outbound';
import type { OutboundClaims } from '@space/postgres/outbound-security';
import { watchOutboundChanges } from '@space/postgres/outbound-changes';
import { RemoteMcp } from './remote.js';
import { validateArguments } from './schema.js';
type Remote = Pick<RemoteMcp, 'discover' | 'call'>;
const token = (value: unknown) => (typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : '');
export function createGateway(
  store: OutboundStore,
  options: { remote?: Remote; publicUrl?: string; trustedProxies?: string[] } = {},
) {
  const remote = options.remote ?? new RemoteMcp(),
    app = Fastify({
      bodyLimit: 262144,
      requestTimeout: 35000,
      trustProxy: options.trustedProxies ?? false,
      logger: false,
    });
  const active = new Map<
      AbortController,
      { changeSubjects: readonly string[]; check?: () => Promise<void>; checking: boolean; dirty: boolean }
    >(),
    owners = new Map<string, number>();
  let requests = 0;
  let healthy = false,
    stopWatching: (() => Promise<void>) | undefined;
  async function recheck(controller: AbortController) {
    const operation = active.get(controller);
    if (!operation?.check) return;
    if (operation.checking) {
      operation.dirty = true;
      return;
    }
    operation.checking = true;
    try {
      do {
        operation.dirty = false;
        await operation.check();
      } while (operation.dirty && active.has(controller));
    } catch {
      controller.abort();
    } finally {
      operation.checking = false;
    }
  }
  app.addHook('onReady', async () => {
    stopWatching = await watchOutboundChanges(
      store.pool,
      (subject) => {
        for (const [controller, operation] of active) if (operation.changeSubjects.includes(subject)) void recheck(controller);
      },
      () => {
        healthy = false;
        for (const controller of active.keys()) controller.abort();
      },
    );
    healthy = true;
  });
  async function bounded<T>(
    owner: string,
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>,
    check?: () => Promise<void>,
    changeSubjects: readonly string[] = [owner],
  ) {
    if (!healthy) throw new AppError(503, 'outbound_unavailable');
    if (active.size >= 32 || (owners.get(owner) ?? 0) >= 4) throw new AppError(429, 'outbound_busy');
    const controller = new AbortController(),
      combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(30000)]);
    active.set(controller, { changeSubjects, check, checking: false, dirty: false });
    owners.set(owner, (owners.get(owner) ?? 0) + 1);
    try {
      return await work(combined);
    } finally {
      active.delete(controller);
      const count = (owners.get(owner) ?? 1) - 1;
      if (count) owners.set(owner, count);
      else owners.delete(owner);
    }
  }
  const verify = (value: unknown, aud = 'outbound') => store.security.verify(token(value), aud);
  app.setErrorHandler((e, _r, reply) =>
    reply
      .code(e instanceof AppError ? e.status : 500)
      .send({ error: e instanceof AppError ? e.code : 'outbound_unavailable' }),
  );
  app.addHook('onRequest', async (r, reply) => {
    if (requests >= 128) throw new AppError(429, 'outbound_busy');
    requests++;
    const release = () => {
      requests--;
      reply.raw.removeListener('finish', release);
      reply.raw.removeListener('close', release);
    };
    reply.raw.once('finish', release);
    reply.raw.once('close', release);
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    if (r.headers.origin) throw new AppError(403, 'mcp_origin_forbidden');
    const host = new URL(`http://${r.headers.host}`).hostname;
    if (options.publicUrl) {
      if (host !== new URL(options.publicUrl).hostname) throw new AppError(403, 'mcp_host_forbidden');
      if (new URL(options.publicUrl).protocol === 'https:' && r.protocol !== 'https')
        throw new AppError(400, 'mcp_https_required');
    } else if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new AppError(403, 'mcp_host_forbidden');
  });
  app.get('/healthz', async (_r, reply) => reply.code(healthy ? 200 : 503).send({ ready: healthy }));
  app.post('/internal/discover', async (r) => {
    const claims = verify(r.headers.authorization, 'outbound-internal'),
      v = record(r.body, ['connection_id', 'revision']),
      id = uuid(v.connection_id),
      scope = claims.workspace === undefined ? claims.owner : { actor: claims.owner, workspace: claims.workspace };
    const recheckRevision = async () => {
      const current = await store.get(scope, id);
      if (current.revision !== v.revision) throw new AppError(409, 'connection_changed');
    };
    return bounded(
      claims.owner,
      new AbortController().signal,
      async (signal) => {
        const connection = await store.credentials(scope, id);
        if (connection.revision !== v.revision) throw new AppError(409, 'connection_changed');
        try {
          const tools = await remote.discover(connection, signal);
          signal.throwIfAborted();
          return await store.catalog(scope, id, connection.revision, tools);
        } catch (e) {
          if (e instanceof AppError && e.code === 'connection_changed') throw e;
          if (signal.aborted) await recheckRevision();
          await store.discoveryFailed(scope, id, connection.revision);
          throw new AppError(502, 'mcp_discovery_failed');
        }
      },
      recheckRevision,
      claims.workspace === undefined ? [claims.owner] : [claims.owner, `workspace:${claims.workspace}`],
    );
  });
  const handler = createMcpHandler(async ({ requestInfo }) => {
    const claims = verify(requestInfo?.headers.get('authorization'));
    await store.authority(claims);
    const server = new McpServer({ name: 'space-outbound', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.server.setRequestHandler('tools/list', async () => ({
      tools: (await store.allowed(claims)).map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema: inputSchema as { type: 'object' },
      })),
    }));
    server.server.setRequestHandler('tools/call', async (request, context) => {
      let revision: number | string | undefined;
      try {
        return await bounded(
          claims.requester ?? claims.owner,
          context.mcpReq.signal,
          async (signal) => {
            const selected = await store.allowedTool(claims, request.params.name);
            if (!selected) throw new AppError(403, 'tool_not_allowed');
            revision = selected.dispatchRevision;
            const args = request.params.arguments ?? {};
            if (Buffer.byteLength(JSON.stringify(args)) > 262144) throw new AppError(413, 'mcp_arguments_too_large');
            await validateArguments(selected.inputSchema, args, signal);
            signal.throwIfAborted();
            const call = await store.reserve(
                claims,
                `${typeof context.mcpReq.id}:${context.mcpReq.id}`,
                request.params.name,
                args,
                selected.dispatchRevision,
              ),
              started = Date.now();
            let status: 'succeeded' | 'failed' | 'uncertain' = 'uncertain';
            try {
              signal.throwIfAborted();
              const result = await remote.call(call.connection, call.tool.upstreamName, args, signal);
              const allowed = await store.allowedTool(claims, request.params.name);
              if (allowed?.dispatchRevision !== call.tool.dispatchRevision) throw new AppError(403, 'outbound_access_revoked');
              signal.throwIfAborted();
              if (Buffer.byteLength(JSON.stringify(result)) > 1048576)
                throw new AppError(413, 'mcp_response_too_large');
              status = result.isError ? 'failed' : 'succeeded';
              if (result.isError)
                return { isError: true, content: [{ type: 'text' as const, text: 'upstream_tool_failed' }] };
              return result;
            } finally {
              await store.finish(call.id, status, Date.now() - started);
            }
          },
          async () => {
            const current = await store.allowedTool(claims, request.params.name);
            if (!current || (revision !== undefined && current.dispatchRevision !== revision))
              throw new AppError(403, 'outbound_access_revoked');
          },
          [claims.owner, claims.requester ?? claims.owner, ...(claims.workspace ? [`workspace:${claims.workspace}`] : [])],
        );
      } catch (e) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: e instanceof AppError ? e.code : 'outbound_call_uncertain' }],
        };
      }
    });
    return server;
  });
  const node = toNodeHandler(handler);
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    async handler(r, reply) {
      if (!healthy) throw new AppError(503, 'outbound_unavailable');
      await store.authority(verify(r.headers.authorization));
      reply.hijack();
      await node(r.raw, reply.raw, r.body);
    },
  });
  app.addHook('preClose', async () => {
    healthy = false;
    for (const controller of active.keys()) controller.abort();
    await stopWatching?.();
    await handler.close();
  });
  return app;
}
