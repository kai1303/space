import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch } from 'undici';
import { AppError, outboundUrl } from '@space/contracts';
type Address = { address: string; family: number };
export function isPublicAddress(address: string) {
  try {
    const parsed = ipaddr.parse(address);
    return parsed.range() === 'unicast';
  } catch {
    return false;
  }
}
export async function resolvePublic(
  raw: string,
  resolve: (host: string) => Promise<Address[]> = (host) => lookup(host, { all: true, verbatim: true }),
): Promise<Address> {
  const url = new URL(outboundUrl(raw)),
    host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
  if (!addresses.length || addresses.length > 32 || addresses.some((a) => !isPublicAddress(a.address)))
    throw new AppError(400, 'mcp_destination_blocked');
  return addresses[0]!;
}
export async function pinnedFetch(
  endpoint: string,
  signal: AbortSignal,
  dependencies: { resolve?: (host: string) => Promise<Address[]>; fetch?: typeof undiciFetch } = {},
) {
  let abort = () => {};
  const destination = await Promise.race([
    resolvePublic(endpoint, dependencies.resolve),
    new Promise<never>((_, reject) => {
      abort = () => reject(new Error('aborted'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }),
  ]).finally(() => signal.removeEventListener('abort', abort));
  signal.throwIfAborted();
  const agent = new Agent({
    connect: {
      lookup: (_host, options, callback) => {
        if (options.all) callback(null, [destination] as any);
        else callback(null, destination.address, destination.family);
      },
      timeout: 5000,
    },
    connections: 2,
    pipelining: 1,
    headersTimeout: 30000,
    bodyTimeout: 30000,
  });
  let bytes = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== endpoint) throw new AppError(400, 'mcp_destination_changed');
    const upstream = await (dependencies.fetch ?? undiciFetch)(endpoint, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text(),
      redirect: 'manual',
      signal: AbortSignal.any([signal, request.signal]),
      dispatcher: agent,
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      throw new AppError(400, 'mcp_redirect_blocked');
    }
    const body = (upstream.body as unknown as ReadableStream<Uint8Array> | null)?.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > 1048576) throw new AppError(413, 'mcp_response_too_large');
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body as ReadableStream<Uint8Array> | undefined, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: Object.fromEntries(upstream.headers),
    });
  };
  return {
    fetch: fetcher,
    close: async () => {
      await agent.destroy();
    },
  };
}
