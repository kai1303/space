import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import { io, type Socket } from 'socket.io-client';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { ChatStore } from '@space/postgres/chat';
import { OutboundStore } from '@space/postgres/outbound';
import { AgentConnectionStore } from '@space/postgres/agent-connections';
import { createApi } from '@space/server/api';
import { createGateway } from '../../apps/mcp-gateway/dist/gateway.js';
import { RemoteMcp } from '../../apps/mcp-gateway/dist/remote.js';
import { parseResourceSubscription, resourceRevision } from '../../apps/server/dist/resource-updates.js';
const schema = `outbound_api_${randomBytes(6).toString('hex')}`,
  key = randomBytes(32).toString('hex');
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
let app: ReturnType<typeof createApi>, gateway: ReturnType<typeof createGateway>, address: string;
const upstreamRequests: { method: string; authorization: string | undefined }[] = [];
let holdToolList: ((resume: () => void) => void) | undefined;
const tools = [
  {
    name: 'search',
    description: 'Search this account',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  },
  { name: 'write', inputSchema: { type: 'object', properties: {} } },
];
const upstream = createServer(async (request, response) => {
  if (request.method !== 'POST') {
    response.writeHead(405);
    response.end();
    return;
  }
  let body = '';
  for await (const chunk of request) body += chunk;
  const message = JSON.parse(body);
  upstreamRequests.push({ method: message.method, authorization: request.headers.authorization });
  if (message.id === undefined) {
    response.writeHead(202);
    response.end();
    return;
  }
  const result =
    message.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : message.method === 'tools/list'
        ? { tools }
        : {};
  const send = () => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  };
  if (message.method === 'tools/list' && holdToolList) holdToolList(send);
  else send();
});
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL required');
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamAddress = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/mcp`;
  // Keep real HTTP and MCP negotiation while replacing only public DNS/TLS pinning for the local fixture.
  const remote = new RemoteMcp(async (endpoint, signal) => ({
    fetch: async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.url, endpoint);
      return fetch(upstreamAddress, {
        method: request.method,
        headers: request.headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text(),
        signal: AbortSignal.any([signal, request.signal]),
      });
    },
    close: async () => {},
  }));
  gateway = createGateway(new OutboundStore(pool, key), { remote });
  const gatewayAddress = await gateway.listen({ host: '127.0.0.1', port: 0 });
  app = createApi(new PostgresStore(pool), {
    allowDevelopmentTokens: true,
    outbound: { key, url: `${gatewayAddress}/mcp` },
    realtime: { eventUrl: process.env.TEST_NATS_URL ?? process.env.NATS_URL },
  });
  address = await app.listen({ host: '127.0.0.1', port: 0 });
});
after(async () => {
  await app?.close();
  await gateway?.close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
const call = (token: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, payload?: object) =>
  app.inject({ method, url: `/v1${path}`, headers: { authorization: `Bearer ${token}` }, payload });
async function pairLocalAgent(seed: Awaited<ReturnType<typeof bootstrap>>) {
  const agents = new AgentConnectionStore(pool);
  const pairing = await agents.createPairing(seed.owner_id, seed.workspace_id, { connector_id: 'codex.local' });
  return agents.claim({ code: pairing.code, credential: randomBytes(32).toString('base64url'), provider: 'codex' });
}
test('personal connection API derives the owner and never returns credentials', async () => {
  const a = await bootstrap(pool);
  const paired = await pairLocalAgent(a);
  const created = await call(a.owner_token, 'POST', '/me/connections', {
    name: 'Work',
    url: 'https://example.com/mcp',
    auth_type: 'bearer',
    token: 'private-secret',
  });
  assert.equal(created.statusCode, 201, created.body);
  const connection = created.json();
  assert.ok(!created.body.includes('private-secret'));
  const list = await call(a.owner_token, 'GET', '/me/connections');
  assert.equal(list.json().items[0].id, connection.id);
  assert.equal((await call(a.collaborator_token, 'GET', '/me/connections')).json().items.length, 0);
  assert.equal(
    (await call(a.collaborator_token, 'PATCH', `/me/connections/${connection.id}`, { revision: 1, name: 'stolen' }))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await call(a.owner_token, 'POST', '/me/connections', {
        owner_id: a.collaborator_id,
        name: 'forged',
        url: 'https://example.com',
        auth_type: 'none',
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call(a.owner_token, 'PUT', `/me/connections/${connection.id}/grants`, {
        revision: 1,
        installation_id: paired.installation_id,
        tools: ['unknown'],
      })
    ).statusCode,
    400,
  );
  const agents = (await call(a.owner_token, 'GET', '/me/connection-agents')).json();
  assert.ok(agents.items.some((agent: any) => agent.id === paired.installation_id));
  assert.equal(agents.items.some((agent: any) => agent.id === a.installation_id), false, 'unpaired mock agents cannot use outbound tools');
  assert.equal(
    (await call(a.owner_token, 'DELETE', `/me/connections/${connection.id}`, { revision: 1 })).statusCode,
    200,
  );
});

test(
  'API discovers through the gateway and real HTTP MCP transport, grants exact tools, and deletes access',
  { timeout: 15000 },
  async () => {
    const a = await bootstrap(pool),
      secret = 'fixture-account-credential';
    const paired = await pairLocalAgent(a);
    const created = await call(a.owner_token, 'POST', '/me/connections', {
      name: 'Personal search',
      url: 'https://fixture.example/mcp',
      auth_type: 'bearer',
      token: secret,
    });
    assert.equal(created.statusCode, 201, created.body);
    let connection = created.json();
    assert.deepEqual(connection.tools, []);
    assert.deepEqual(connection.grants, []);
    const before = upstreamRequests.length;
    const unauthorized = await call(a.collaborator_token, 'POST', `/me/connections/${connection.id}/discover`, {
      revision: connection.revision,
    });
    assert.equal(unauthorized.statusCode, 404, unauthorized.body);
    assert.equal(upstreamRequests.length, before, 'another owner cannot dispatch discovery');
    const discovered = await call(a.owner_token, 'POST', `/me/connections/${connection.id}/discover`, {
      revision: connection.revision,
    });
    assert.equal(discovered.statusCode, 200, discovered.body);
    connection = discovered.json();
    assert.equal(connection.status, 'ready');
    assert.equal(connection.revision, 2);
    assert.deepEqual(connection.tools, tools);
    assert.deepEqual(connection.grants, []);
    const requests = upstreamRequests.slice(before);
    assert.ok(requests.some((request) => request.method === 'initialize'));
    assert.ok(requests.some((request) => request.method === 'tools/list'));
    assert.ok(requests.every((request) => request.authorization === `Bearer ${secret}`));
    assert.ok(!discovered.body.includes(secret));
    const stale = await call(a.owner_token, 'POST', `/me/connections/${connection.id}/discover`, { revision: 1 });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(
      upstreamRequests.length,
      before + requests.length,
      'stale discovery is rejected before upstream dispatch',
    );
    assert.equal(
      (
        await call(a.collaborator_token, 'PUT', `/me/connections/${connection.id}/grants`, {
          revision: connection.revision,
          installation_id: paired.installation_id,
          tools: ['search'],
        })
      ).statusCode,
      404,
    );
    const unsupported = await call(a.owner_token, 'PUT', `/me/connections/${connection.id}/grants`, {
      revision: connection.revision,
      installation_id: a.installation_id,
      tools: ['search'],
    });
    assert.equal(unsupported.statusCode, 404, unsupported.body);
    assert.equal(unsupported.json().error, 'agent_not_owned');
    const granted = await call(a.owner_token, 'PUT', `/me/connections/${connection.id}/grants`, {
      revision: connection.revision,
      installation_id: paired.installation_id,
      tools: ['search'],
    });
    assert.equal(granted.statusCode, 200, granted.body);
    connection = granted.json();
    assert.equal(connection.revision, 3);
    assert.deepEqual(connection.grants, [{ installation_id: paired.installation_id, tools: ['search'] }]);
    assert.equal(
      (
        await call(a.owner_token, 'PUT', `/me/connections/${connection.id}/grants`, {
          revision: 2,
          installation_id: paired.installation_id,
          tools: ['write'],
        })
      ).statusCode,
      409,
    );
    const listed = (await call(a.owner_token, 'GET', '/me/connections'))
      .json()
      .items.find((item: any) => item.id === connection.id);
    assert.deepEqual(listed.grants, connection.grants);
    assert.ok(!JSON.stringify(listed).includes(secret));
    assert.equal(
      (
        await call(a.collaborator_token, 'DELETE', `/me/connections/${connection.id}`, {
          revision: connection.revision,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (await call(a.owner_token, 'DELETE', `/me/connections/${connection.id}`, { revision: connection.revision }))
        .statusCode,
      200,
    );
    assert.equal(
      (await call(a.owner_token, 'GET', '/me/connections')).json().items.some((item: any) => item.id === connection.id),
      false,
    );
    assert.equal(
      (
        await call(a.owner_token, 'POST', `/me/connections/${connection.id}/discover`, {
          revision: connection.revision,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (await pool.query('SELECT count(*)::int n FROM outbound_grants WHERE connection_id=$1', [connection.id])).rows[0]
        .n,
      0,
    );
  },
);

test(
  'workspace admins share connection management and discover with the workspace credential',
  { timeout: 15000 },
  async () => {
    const a = await bootstrap(pool),
      b = await bootstrap(pool);
    const base = `/workspaces/${a.workspace_id}`;
    const local = await pairLocalAgent(a),
      foreign = await pairLocalAgent(b);
    const secret = 'shared-account-credential';
    const input = { name: 'Shared search', url: 'https://workspace.example/mcp', auth_type: 'bearer', token: secret };
    const created = await call(a.owner_token, 'POST', `${base}/connections`, input);
    assert.equal(created.statusCode, 201, created.body);
    assert.ok(!created.body.includes(secret));
    const id = created.json().id,
      path = `${base}/connections/${id}`;
    const before = upstreamRequests.length;
    for (const [token, expected] of [
      [a.collaborator_token, 403],
      [b.owner_token, 404],
    ] as const) {
      const requests = [
        await call(token, 'GET', `${base}/connections`),
        await call(token, 'GET', `${base}/connection-agents`),
        await call(token, 'POST', `${base}/connections`, input),
        await call(token, 'POST', `${path}/discover`, { revision: 1 }),
        await call(token, 'PATCH', path, { revision: 1, name: 'renamed' }),
        await call(token, 'PUT', `${path}/grants`, { revision: 1, installation_id: local.installation_id, tools: [] }),
        await call(token, 'DELETE', path, { revision: 1 }),
      ];
      for (const response of requests) assert.equal(response.statusCode, expected, response.body);
    }
    assert.equal(upstreamRequests.length, before);
    assert.deepEqual((await call(a.owner_token, 'GET', '/me/connections')).json().items, []);
    assert.equal(
      (await call(a.owner_token, 'PATCH', `/me/connections/${id}`, { revision: 1, name: 'mine' })).statusCode,
      404,
    );
    assert.equal(
      (
        await call(b.owner_token, 'PATCH', `/workspaces/${b.workspace_id}/connections/${id}`, {
          revision: 1,
          name: 'mine',
        })
      ).statusCode,
      404,
    );
    await pool.query("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [
      a.workspace_id,
      a.collaborator_id,
    ]);
    const agents = await call(a.collaborator_token, 'GET', `${base}/connection-agents`);
    assert.deepEqual(
      agents.json().items.map((item: { id: string }) => item.id),
      [local.installation_id],
    );
    const remaining = await call(
      a.collaborator_token,
      'GET',
      `${base}/connection-agents?after=${local.installation_id}`,
    );
    assert.deepEqual(remaining.json().items, []);
    const changed = await call(a.collaborator_token, 'PATCH', path, { revision: 1, name: 'Team search' });
    assert.equal(changed.statusCode, 200, changed.body);
    const discovered = await call(a.collaborator_token, 'POST', `${path}/discover`, {
      revision: changed.json().revision,
    });
    assert.equal(discovered.statusCode, 200, discovered.body);
    assert.deepEqual(discovered.json().tools, tools);
    const requests = upstreamRequests.slice(before);
    assert.ok(requests.some((request) => request.method === 'tools/list'));
    assert.ok(requests.every((request) => request.authorization === `Bearer ${secret}`));
    assert.ok(!discovered.body.includes(secret));
    const grant = { revision: discovered.json().revision, installation_id: local.installation_id, tools: ['search'] };
    assert.equal(
      (
        await call(a.collaborator_token, 'PUT', `${path}/grants`, {
          ...grant,
          installation_id: foreign.installation_id,
        })
      ).statusCode,
      404,
    );
    const granted = await call(a.collaborator_token, 'PUT', `${path}/grants`, grant);
    assert.equal(granted.statusCode, 200, granted.body);
    assert.deepEqual(granted.json().grants, [{ installation_id: local.installation_id, tools: ['search'] }]);
    const page = (await call(a.owner_token, 'GET', `${base}/connections`)).json();
    const [listed] = page.items;
    assert.deepEqual(listed, granted.json());
    assert.deepEqual(page.agents, agents.json());
    const grantPage = await call(a.owner_token, 'GET', `${base}/connections?after=${local.installation_id}`);
    assert.deepEqual(grantPage.json().items, [{ ...listed, grants: [] }]);
    assert.deepEqual(grantPage.json().agents, remaining.json());
    const signed = new OutboundStore(pool, key).security.sign({
      aud: 'outbound-internal',
      owner: a.collaborator_id,
      workspace: a.workspace_id,
      installation: '',
      execution: '',
      exp: Date.now() + 35000,
    });
    const upstreamStarted = new Promise<() => void>((resolve) => {
      holdToolList = resolve;
    });
    const inFlight = Promise.resolve(
      call(a.collaborator_token, 'POST', `${path}/discover`, { revision: listed.revision }),
    );
    const resume = await upstreamStarted;
    const deadline = AbortSignal.timeout(5000);
    try {
      await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2", [
        a.workspace_id,
        a.collaborator_id,
      ]);
      const interrupted = await Promise.race([
        inFlight,
        new Promise<never>((_, reject) =>
          deadline.addEventListener('abort', () => reject(new Error('discovery still active after demotion')), {
            once: true,
          }),
        ),
      ]);
      assert.equal(interrupted.statusCode, 403, interrupted.body);
    } finally {
      holdToolList = undefined;
      resume();
    }
    const afterInterruption = upstreamRequests.length;
    const revoked = await gateway.inject({
      method: 'POST',
      url: '/internal/discover',
      headers: { authorization: `Bearer ${signed}` },
      payload: { connection_id: id, revision: listed.revision },
    });
    assert.equal(revoked.statusCode, 403, revoked.body);
    assert.equal(upstreamRequests.length, afterInterruption);
    assert.equal((await call(a.owner_token, 'DELETE', path, { revision: listed.revision })).statusCode, 200);
  },
);

test(
  'actor subscriptions authorize only their owner and connection mutations advance only that actor revision',
  { timeout: 15000 },
  async (t) => {
    const a = await bootstrap(pool),
      chat = new ChatStore(pool),
      owner = parseResourceSubscription({ scope: 'actor', id: a.owner_id });
    const other = parseResourceSubscription({ scope: 'actor', id: a.collaborator_id });
    const initial = await resourceRevision(chat, a.owner_id, owner),
      otherInitial = await resourceRevision(chat, a.collaborator_id, other);
    assert.deepEqual(owner.keys, [`actor:${a.owner_id}`]);
    await assert.rejects(resourceRevision(chat, a.collaborator_id, { scope: 'actor', id: a.owner_id }), /not_found/);
    const sockets: Socket[] = [];
    t.after(() => sockets.forEach((socket) => socket.disconnect()));
    async function connect(token: string) {
      const socket = io(address, {
        transports: ['websocket'],
        auth: { token },
        autoConnect: false,
        reconnection: false,
      });
      sockets.push(socket);
      socket.on('updates.changed', (_value, ack) => ack?.({ ok: true }));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Socket connect deadline')), 5000);
        socket.once('connect', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once('connect_error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        socket.connect();
      });
      return socket;
    }
    const ownerSocket = await connect(a.owner_token),
      otherSocket = await connect(a.collaborator_token);
    assert.deepEqual(
      await ownerSocket.timeout(5000).emitWithAck('updates.subscribe', { scope: 'actor', id: a.owner_id }),
      { data: { scope: 'actor', id: a.owner_id } },
    );
    assert.deepEqual(
      await otherSocket.timeout(5000).emitWithAck('updates.subscribe', { scope: 'actor', id: a.owner_id }),
      { error: 'not_found' },
    );
    assert.deepEqual(
      await otherSocket.timeout(5000).emitWithAck('updates.subscribe', { scope: 'actor', id: a.collaborator_id }),
      { data: { scope: 'actor', id: a.collaborator_id } },
    );
    const response = await call(a.owner_token, 'POST', '/me/connections', {
      name: 'Revision test',
      url: 'https://fixture.example/mcp',
      auth_type: 'none',
    });
    assert.equal(response.statusCode, 201, response.body);
    const connection = response.json();
    const createdRevision = await resourceRevision(chat, a.owner_id, owner);
    assert.ok(BigInt(createdRevision) > BigInt(initial));
    assert.equal(await resourceRevision(chat, a.collaborator_id, other), otherInitial);
    const changed = await call(a.owner_token, 'PATCH', `/me/connections/${connection.id}`, {
      revision: connection.revision,
      enabled: false,
    });
    assert.equal(changed.statusCode, 200, changed.body);
    const changedRevision = await resourceRevision(chat, a.owner_id, owner);
    assert.ok(BigInt(changedRevision) > BigInt(createdRevision));
    assert.equal(
      (await call(a.owner_token, 'DELETE', `/me/connections/${connection.id}`, { revision: changed.json().revision }))
        .statusCode,
      200,
    );
    assert.ok(BigInt(await resourceRevision(chat, a.owner_id, owner)) > BigInt(changedRevision));
    assert.equal(await resourceRevision(chat, a.collaborator_id, other), otherInitial);
    assert.deepEqual(
      await ownerSocket.timeout(5000).emitWithAck('updates.unsubscribe', { scope: 'actor', id: a.owner_id }),
      { data: { scope: 'actor', id: a.owner_id } },
    );
  },
);
