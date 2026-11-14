// Only the desktop connector can mint a per-turn handle. The provider sees one
// local MCP server. The main process resolves the tab and requests consent.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';

export async function browserMcpTurn(invoke, signal) {
  const token = randomBytes(32).toString('base64url');
  let filled = false, catalog = null, pending = false, calls = 0;
  async function perform(action, input = {}) {
    if (pending || signal.aborted || calls >= 16) return { isError: true, content: [{ type: 'text', text: 'unavailable' }] };
    pending = true; calls++;
    try {
      const result = await invoke(action, input);
      if (action === 'list-api' && result?.status === 'ready') {
        catalog = new Set(result.tools.map(tool => tool.name));
        return { content: [{ type: 'text', text: JSON.stringify(result.tools) }] };
      }
      if (action === 'call-api' && result?.status === 'completed') return result.result;
      const status = typeof result === 'string' ? result : 'unavailable';
      return { isError: status !== 'filled', content: [{ type: 'text', text: status }] };
    } catch { return { isError: true, content: [{ type: 'text', text: 'unavailable' }] }; }
    finally { pending = false; }
  }
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: 'browser', version: '1.0.0' });
    mcp.registerTool('fill_from_vault', {
      description: 'Ask the user to approve filling a saved login on this Space browser tab. The user submits the form, completes MFA, and resumes control. Only request this when the user asks to sign in.',
      inputSchema: z.strictObject({}),
    }, async () => {
      if (filled) return { isError: true, content: [{ type: 'text', text: 'Already requested this turn.' }] };
      filled = true;
      return perform('fill');
    });
    mcp.registerTool('list_saved_tools', {
      description: 'Ask the user to choose a personal Vault API credential for the current application and discover its MCP tools.',
      inputSchema: z.strictObject({}),
    }, () => perform('list-api'));
    mcp.registerTool('call_saved_tool', {
      description: 'Ask the user to approve one discovered MCP tool call using the selected local Vault item.',
      inputSchema: z.strictObject({ tool: z.string().max(64), arguments: z.record(z.string(), z.unknown()) }),
    }, input => {
      if (!catalog?.has(input.tool)) return { isError: true, content: [{ type: 'text', text: 'Discover the tool first.' }] };
      return perform('call-api', input);
    });
    return mcp;
  });
  let address;
  const dispatch = toNodeHandler(handler);
  const http = createServer({ maxHeaderSize: 8192, requestTimeout: 10000 }, async (req, res) => {
    if (signal.aborted || req.url !== '/mcp' || req.headers.host !== address || req.headers.origin ||
        req.headers.authorization !== 'Bearer ' + token) return res.writeHead(403).end();
    if (req.method !== 'POST') return res.writeHead(405).end();
    const chunks = [];
    let bytes = 0;
    try {
      for await (const chunk of req) {
        if ((bytes += chunk.length) > 8192) return res.writeHead(413).end();
        chunks.push(chunk);
      }
      await dispatch(req, res, JSON.parse(Buffer.concat(chunks)));
    } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
  });
  http.maxConnections = 8;
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  address = '127.0.0.1:' + http.address().port;
  const close = () => { http.close(); http.closeAllConnections(); void handler.close().catch(() => {}); };
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) { close(); signal.throwIfAborted(); }
  return { name: 'browser', tools: ['fill_from_vault', 'list_saved_tools', 'call_saved_tool'], url: 'http://' + address + '/mcp', tokenEnv: 'SPACE_BROWSER_TURN', token };
}
