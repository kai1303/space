const test = require('node:test');
const assert = require('node:assert/strict');

test('browser Vault MCP requires its turn token and only dispatches confirmed tool names', async () => {
  const { browserMcpTurn } = await import('../runner/browser-mcp.mjs');
  const lifetime = new AbortController();
  const calls = [];
  const server = await browserMcpTurn(async (action, input) => {
    calls.push([action, input]);
    if (action === 'list-api') return { status: 'ready', tools: [{ name: 'issue_read', inputSchema: { type: 'object' } }] };
    if (action === 'call-api') return { status: 'completed', result: { content: [{ type: 'text', text: 'issue title' }] } };
    return 'filled';
  }, lifetime.signal);
  const send = async (method, params, headers = {}) => fetch(server.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + server.token, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  async function rpc(method, params) {
    const response = await send(method, params);
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const data = body.startsWith('{') ? body : body.split('\n').find(line => line.startsWith('data:')).slice(5);
    const message = JSON.parse(data);
    assert.ok(message.result, JSON.stringify(message));
    return message.result;
  }
  try {
    assert.equal((await send('tools/list', {}, { Authorization: '' })).status, 403);
    assert.equal((await send('tools/list', {}, { Origin: 'https://linear.app' })).status, 403);
    assert.deepEqual((await rpc('tools/list', {})).tools.map(t => t.name).sort(), [...server.tools].sort());
    const call = (name, args = {}) => rpc('tools/call', { name, arguments: args });
    const input = { tool: 'issue_read', arguments: { id: 'ENG-10' } };
    assert.equal((await call('call_saved_tool', input)).isError, true);
    assert.deepEqual((await call('fill_from_vault')).content, [{ type: 'text', text: 'filled' }]);
    assert.equal((await call('fill_from_vault')).isError, true);
    await call('list_saved_tools');
    assert.equal((await call('call_saved_tool', input)).content[0].text, 'issue title');
    assert.deepEqual(calls.map(([action]) => action), ['fill', 'list-api', 'call-api']);
  } finally { lifetime.abort(); }
  await assert.rejects(send('tools/list', {}));
});
