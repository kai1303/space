import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
test('real upstream MCP discovery and calls use the selected account and close clients', async () => {
  assert.ok(existsSync('remote.ts'), 'remote MCP client exists');
  const { RemoteMcp } = await import('./remote.js');
  const app = Fastify();
  let calls = 0,
    terminated = 0;
  const handler = createMcpHandler(({ requestInfo }) => {
    const server = new McpServer({ name: 'fixture', version: '1' });
    server.registerTool('whoami', {}, async () => {
      calls++;
      return { content: [{ type: 'text', text: requestInfo?.headers.get('authorization') ?? 'anonymous' }] };
    });
    return server;
  });
  const node = toNodeHandler(handler);
  app.all('/mcp', async (r, reply) => {
    if (r.method === 'DELETE') {
      terminated++;
      return reply.code(204).send();
    }
    reply.hijack();
    await node(r.raw, reply.raw, r.body);
  });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const remote = new RemoteMcp(async (_url, signal) => ({
    fetch: async (input, init) => {
      const response = await fetch(input, { ...init, signal });
      if (typeof init?.body === 'string' && JSON.parse(init.body).method === 'initialize') {
        const headers = new Headers(response.headers);
        headers.set('mcp-session-id', 'test-session');
        return new Response(response.body, { status: response.status, headers });
      }
      return response;
    },
    close: async () => {},
  }));
  try {
    const tools = await remote.discover({ url: `${address}/mcp`, token: 'first' });
    assert.equal(tools[0]?.name, 'whoami');
    for (const token of ['first', 'second']) {
      const result = await remote.call({ url: `${address}/mcp`, token }, 'whoami', {}, new AbortController().signal);
      assert.deepEqual(result.content, [{ type: 'text', text: `Bearer ${token}` }]);
    }
    assert.equal(calls, 2);
    assert.equal(terminated, 3);
  } finally {
    await handler.close();
    await app.close();
  }
});

test('discovery follows pagination and rejects oversized and malformed catalogs', async () => {
  const { RemoteMcp } = await import('./remote.js');
  let mode: 'normal' | 'oversized' | 'malformed' = 'normal',
    pages = 0;
  const app = Fastify();
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'pages', version: '1' }, { capabilities: { tools: {} } });
    server.server.setRequestHandler('tools/list', async (request) => {
      pages++;
      if (mode === 'malformed') return { tools: [{ name: 'bad', inputSchema: { type: 'array' as any } }] };
      if (mode === 'oversized')
        return {
          tools: Array.from({ length: 100 }, (_, i) => ({
            name: `tool${request.params?.cursor ?? 'first'}_${i}`,
            inputSchema: { type: 'object' as const },
          })),
          ...(request.params?.cursor ? {} : { nextCursor: 'next' }),
        };
      return {
        tools: [{ name: request.params?.cursor ? 'second' : 'first', inputSchema: { type: 'object' as const } }],
        ...(request.params?.cursor ? {} : { nextCursor: 'next' }),
      };
    });
    return server;
  });
  const node = toNodeHandler(handler);
  app.all('/mcp', async (r, reply) => {
    reply.hijack();
    await node(r.raw, reply.raw, r.body);
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const remote = new RemoteMcp(async (_url, signal) => ({
    fetch: (input, init) => fetch(input, { ...init, signal }),
    close: async () => {},
  }));
  try {
    assert.deepEqual(
      (await remote.discover({ url: `${address}/mcp` })).map((t) => t.name),
      ['first', 'second'],
    );
    assert.equal(pages, 2);
    mode = 'oversized';
    await assert.rejects(remote.discover({ url: `${address}/mcp` }), /invalid_mcp_catalog/);
    mode = 'malformed';
    await assert.rejects(remote.discover({ url: `${address}/mcp` }));
  } finally {
    await handler.close();
    await app.close();
  }
});
test('a nonresponsive upstream is canceled during initialization', async () => {
  const { RemoteMcp } = await import('./remote.js');
  let closed = 0;
  const remote = new RemoteMcp(async (_url, signal) => ({
    fetch: async () =>
      new Promise((_resolve, reject) => {
        if (signal.aborted) reject(new Error('aborted'));
        else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    close: async () => {
      closed++;
    },
  }));
  await assert.rejects(remote.discover({ url: 'https://example.com/mcp' }, AbortSignal.timeout(50)));
  assert.ok(closed > 0);
});
