import { RemoteMcp, type RemoteConnection } from './remote.js';

type Client = Pick<RemoteMcp, 'call' | 'discover'>;
const alias = 'https://pg-knowledge.invalid/mcp';
// Only the development knowledge adapter can use the operator-configured loopback service.
// Workspace URLs, DNS and redirects cannot select a local destination.
export function isLocalPgKnowledge(connection: { kind?: string; url: string }) {
  return process.env.NODE_ENV === 'development' && process.env.SPACE_LOCAL_PG_KNOWLEDGE === '1'
    && connection.kind === 'knowledge' && connection.url === alias;
}
export function knowledgeClient(remote: Client, connection: RemoteConnection & { kind?: string }): Client {
  if (!isLocalPgKnowledge(connection)) return remote;
  const port = Number(process.env.SPACE_LOCAL_PG_KNOWLEDGE_PORT ?? 58439);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_local_knowledge_port');
  return new RemoteMcp(async (_url, signal) => ({
    async fetch(input, init) {
      const request = new Request(input, init);
      if (request.url !== alias) throw new Error('invalid_local_knowledge_endpoint');
      return fetch(`http://127.0.0.1:${port}/mcp`, {
        method: request.method, headers: request.headers, redirect: 'error',
        signal: AbortSignal.any([signal, request.signal]),
        body: request.body ? await request.text() : undefined,
      });
    },
    close: async () => {},
  }));
}
