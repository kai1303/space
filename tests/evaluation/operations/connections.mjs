import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { OutboundStore } from '@space/postgres/outbound';
import { createGateway } from '../../../apps/mcp-gateway/dist/gateway.js';
import { RemoteMcp } from '../../../apps/mcp-gateway/dist/remote.js';

const endpoint = 'https://bench.example.test/mcp';

export async function startConnections(pool) {
  const upstream = Fastify();
  upstream.post('/mcp', async (req, reply) => {
    const {method, id} = req.body;
    if (id === undefined) return reply.code(202).send();
    const result = method === 'initialize'
      ? {protocolVersion: '2025-03-26', capabilities: {tools: {}}, serverInfo: {name: 'benchmark', version: '1'}}
      : {tools: [{name: 'search', inputSchema: {type: 'object', properties: {}}}]};
    assert.ok(method === 'initialize' || method === 'tools/list');
    return {jsonrpc: '2.0', id, result};
  });
  const address = await upstream.listen({host: '127.0.0.1', port: 0});
  const key = randomBytes(32).toString('hex');
  // The benchmark owns this one loopback upstream. Exercise the real gateway
  // and protocol while keeping discovery independent of external DNS and TLS.
  const remote = new RemoteMcp(async (url, signal) => {
    assert.equal(url, endpoint);
    return {fetch: async (input, init) => {
      const req = new Request(input, init);
      assert.equal(req.url, endpoint);
      return fetch(address + '/mcp', {method: req.method, headers: req.headers,
        body: req.method === 'POST' ? await req.text() : undefined, signal: AbortSignal.any([signal, req.signal])});
    }, close: async () => {}};
  });
  const gateway = createGateway(new OutboundStore(pool, key), {remote});
  try {
    const local = await gateway.listen({host: '127.0.0.1', port: 0});
    return {options: {url: local + '/mcp', key}, async close() {
      try { await gateway.close(); } finally { await upstream.close(); }
    }};
  } catch (error) { await upstream.close(); throw error; }
}

export async function connections(call, ws, installation) {
  await call('Connections')('Call history', 'GET', '/me/connection-calls');
  for (const [label, base] of [['Personal', '/me'], ['Workspace', '/workspaces/' + ws]]) {
    const op = call(label + ' connections'), paths = base + '/connections';
    const created = await op('Create', 'POST', paths, {name: 'Search', url: endpoint, auth_type: 'none'}, 201);
    const path = paths + '/' + created.id;
    assert.ok((await op('List', 'GET', paths)).items.some(c => c.id === created.id));
    await op('List agents', 'GET', base + '/connection-agents');
    const edited = await op('Edit', 'PATCH', path, {name: 'Benchmark search', revision: created.revision});
    const ready = await op('Discover tools', 'POST', path + '/discover', {revision: edited.revision});
    assert.ok(ready.tools.some(tool => tool.name === 'search'));
    const granted = await op('Grant tool', 'PUT', path + '/grants', {installation_id: installation, revision: ready.revision, tools: ['search']});
    assert.equal((await op('Delete', 'DELETE', path, {revision: granted.revision})).deleted, true);
  }
}
