import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { AppError, parseOutboundTools } from '@space/contracts';
import { pinnedFetch } from './network.js';
export type RemoteConnection = { url: string; token?: string };
export class RemoteMcp {
  constructor(private network: typeof pinnedFetch = pinnedFetch) {}
  private async connected<T>(
    connection: RemoteConnection,
    signal: AbortSignal,
    work: (client: Client) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    const network = await this.network(connection.url, signal);
    const client = new Client({ name: 'space-outbound', version: '1.0.0' }, { listMaxPages: 10, capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
      fetch: network.fetch,
      requestInit: { headers: connection.token ? { Authorization: `Bearer ${connection.token}` } : {}, signal },
      reconnectionOptions: {
        maxRetries: 0,
        maxReconnectionDelay: 1000,
        initialReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    });
    const stop = () => {
      void client.close().catch(() => {});
      void network.close();
    };
    signal.addEventListener('abort', stop, { once: true });
    try {
      await client.connect(transport);
      signal.throwIfAborted();
      return await work(client);
    } finally {
      if (!signal.aborted) {
        const timeout = setTimeout(stop, 1000);
        try {
          await transport.terminateSession().catch(() => {});
        } finally {
          clearTimeout(timeout);
        }
      }
      signal.removeEventListener('abort', stop);
      await client.close().catch(() => {});
      await network.close();
    }
  }
  async discover(connection: RemoteConnection, signal = AbortSignal.timeout(30000)) {
    return this.connected(connection, signal, async (client) =>
      parseOutboundTools((await client.listTools(undefined, { signal, timeout: 30000 })).tools),
    );
  }
  async call(
    connection: RemoteConnection,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    return this.connected(connection, signal, async (client) => {
      const result = await client.callTool({ name, arguments: args }, { signal, timeout: 30000 });
      if (Buffer.byteLength(JSON.stringify(result)) > 1048576) throw new AppError(413, 'mcp_response_too_large');
      return result;
    });
  }
}
