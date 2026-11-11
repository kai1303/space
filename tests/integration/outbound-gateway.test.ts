import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import {AgentConnectionStore} from '@space/postgres/agent-connections';
import { OutboundStore } from '@space/postgres/outbound';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const schema = `outbound_gateway_${randomBytes(6).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
async function fixture() {
  const base=await bootstrap(pool),pairings=new AgentConnectionStore(pool);
  const pairing=await pairings.createPairing(base.owner_id,base.workspace_id,{provider:'codex'});
  const agent=await pairings.claim({code:pairing.code,credential:randomBytes(32).toString('base64url'),provider:'codex'});
  const seed={...base,installation_id:agent.installation_id},
    session = randomUUID(),
    task = randomUUID(),
    execution = randomUUID();
  await pool.query('INSERT INTO agent_sessions(id,workspace_id,installation_id,origin_thread_id) VALUES($1,$2,$3,$4)', [
    session,
    seed.workspace_id,
    seed.installation_id,
    seed.thread_id,
  ]);
  await pool.query(
    "INSERT INTO tasks(id,workspace_id,thread_id,installation_id,goal,skill,requester_id,status,session_id,idempotency_key,request_hash) VALUES($1::uuid,$2,$3,$4,'test','demo.echo',$5,'running',$6,$1::text,'test')",
    [task, seed.workspace_id, seed.thread_id, seed.installation_id, seed.owner_id, session],
  );
  await pool.query(
    "INSERT INTO executions(id,workspace_id,task_id,installation_id,session_id,status) VALUES($1,$2,$3,$4,$5,'running')",
    [execution, seed.workspace_id, task, seed.installation_id, session],
  );
  await pool.query('UPDATE tasks SET active_execution_id=$2 WHERE id=$1', [task, execution]);
  return { ...seed, task, execution };
}
test('gateway enforces personal grants, separates accounts and denies revoked access', async () => {
  assert.ok(existsSync('../apps/mcp-gateway/gateway.ts'), 'separate MCP gateway exists');
  const { createGateway } = await import('../../apps/mcp-gateway/dist/gateway.js');
  const seed = await fixture(),
    store = new OutboundStore(pool, randomBytes(32).toString('hex'));
  const seen: string[] = [];
  const tools = [{ name: 'whoami', inputSchema: { type: 'object' } }];
  const remote = {
    async discover() {
      return tools;
    },
    async call(connection: any) {
      seen.push(connection.token);
      return { content: [{ type: 'text' as const, text: connection.token }] };
    },
  };
  const gateway = createGateway(store, { remote });
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 });
  const connections = [];
  for (const token of ['account-a', 'account-b']) {
    let c = await store.create(seed.owner_id, {
      name: token,
      url: 'https://example.com/mcp',
      auth_type: 'bearer',
      token,
    });
    c = await store.catalog(seed.owner_id, c.id, c.revision, tools);
    c = await store.grant(seed.owner_id, c.id, {
      revision: c.revision,
      installation_id: seed.installation_id,
      tools: ['whoami'],
    });
    connections.push(c);
  }
  const access = (await store.issue(seed.execution, seed.installation_id, `${address}/mcp`))!;
  const client = new Client({ name: 'test-agent', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(access.url), {
      requestInit: { headers: { Authorization: `Bearer ${access.token}` } },
    }),
  );
  try {
    const list = await client.listTools();
    assert.equal(list.tools.length, 2);
    assert.deepEqual(list.tools.map(tool=>tool.description).sort(),['Connection "account-a". whoami','Connection "account-b". whoami']);
    assert.notEqual(list.tools[0]!.name, list.tools[1]!.name);
    for (const tool of list.tools)
      assert.notEqual((await client.callTool({ name: tool.name, arguments: {} })).isError, true);
    assert.deepEqual(seen.sort(), ['account-a', 'account-b']);
    const claims = store.security.verify(access.token, 'outbound');
    assert.equal(claims.workspace, seed.workspace_id);
    assert.equal(claims.requester, seed.owner_id);
    const name = list.tools[0]!.name;
    const reserved = await store.reserve(claims, 'duplicate', name, {});
    await assert.rejects(store.reserve(claims, 'duplicate', name, {}), /call_in_progress/);
    await store.finish(reserved.id, 'uncertain', 1);
    await assert.rejects(store.reserve(claims, 'duplicate', name, {}), /call_already_dispatched/);
    const first = connections[0]!;
    await store.update(seed.owner_id, first.id, { revision: first.revision, enabled: false });
    assert.equal((await client.listTools()).tools.length, 1);
    await pool.query('UPDATE tasks SET requester_id=$2 WHERE id=$1', [seed.task, seed.collaborator_id]);
    assert.equal(await store.issue(seed.execution, seed.installation_id, access.url), undefined);
    await assert.rejects(client.listTools());
    const audit = await store.calls(seed.owner_id);
    assert.equal(audit.items.length, 3);
    assert.ok(!JSON.stringify(audit).includes('Bearer'));
  } finally {
    await client.close();
    await gateway.close();
  }
});

test('revocation cancels an active call and concurrent duplicate requests never redispatch', async () => {
  const { createGateway } = await import('../../apps/mcp-gateway/dist/gateway.js');
  const seed = await fixture(),
    store = new OutboundStore(pool, randomBytes(32).toString('hex'));
  let connection = await store.create(seed.owner_id, {
    name: 'Cancelable',
    url: 'https://example.com/mcp',
    auth_type: 'none',
  });
  connection = await store.catalog(seed.owner_id, connection.id, connection.revision, [
    {
      name: 'write',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
    },
  ]);
  connection = await store.grant(seed.owner_id, connection.id, {
    revision: connection.revision,
    installation_id: seed.installation_id,
    tools: ['write'],
  });
  let signalSeen: AbortSignal | undefined,
    dispatches = 0,
    started!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  const remote = {
    async discover() {
      return [];
    },
    async call(_c: any, _name: string, _args: unknown, signal: AbortSignal) {
      dispatches++;
      signalSeen = signal;
      started();
      return new Promise<any>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('private upstream secret')), { once: true }),
      );
    },
  };
  const gateway = createGateway(store, { remote }),
    address = await gateway.listen({ host: '127.0.0.1', port: 0 });
  const access = (await store.issue(seed.execution, seed.installation_id, `${address}/mcp`))!;
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(access.url), {
      requestInit: { headers: { Authorization: `Bearer ${access.token}` } },
    }),
  );
  try {
    const name = access.tools.find((t) => t.endsWith('_write'))!;
    const invalid = await client.callTool({ name, arguments: { value: 1 } });
    assert.equal(invalid.isError, true);
    assert.equal(dispatches, 0);
    const claims = store.security.verify(access.token, 'outbound');
    const reserves = await Promise.allSettled(
      Array.from({ length: 8 }, () => store.reserve(claims, 'same-id', name, { value: 'once' })),
    );
    assert.equal(reserves.filter((r) => r.status === 'fulfilled').length, 1);
    const reserved = reserves.find((r) => r.status === 'fulfilled')! as PromiseFulfilledResult<any>;
    await store.finish(reserved.value.id, 'uncertain', 1);
    await assert.rejects(store.reserve(claims, 'same-id', name, { value: 'changed' }), /call_identity_conflict/);
    await assert.rejects(
      store.reserve(claims, 'stale-schema', name, { value: 'once' }, connection.revision - 1),
      /connection_changed/,
    );
    const capacity = await Promise.allSettled(Array.from({length:8},(_,index)=>store.reserve(claims,`capacity-${index}`,name,{value:'once'})));
    assert.equal(capacity.filter(result=>result.status==='fulfilled').length,4);
    assert.ok(capacity.filter(result=>result.status==='rejected').every(result=>result.reason.code==='outbound_busy'));
    for(const result of capacity)if(result.status==='fulfilled')await store.finish(result.value.id,'uncertain',1);
    const pending = client.callTool({ name, arguments: { value: 'once' } });
    await dispatched;
    await store.update(seed.owner_id, connection.id, { revision: connection.revision, enabled: false });
    const result = await pending;
    assert.equal(result.isError, true);
    assert.equal(signalSeen?.aborted, true);
    assert.equal(dispatches, 1);
    assert.ok(!JSON.stringify(result).includes('private upstream secret'));
    assert.ok(
      (await store.calls(seed.owner_id)).items.some(
        (call) => call.connection_name === 'Cancelable' && call.status === 'uncertain',
      ),
    );
    await pool.query('UPDATE executions SET status=$2 WHERE id=$1', [seed.execution, 'completed']);
    await assert.rejects(client.listTools());
  } finally {
    await client.close();
    await gateway.close();
  }
});

test('workspace grants dispatch only the shared credential for a member using a paired agent', async () => {
  const { createGateway } = await import('../../apps/mcp-gateway/dist/gateway.js');
  const seed = await fixture();
  const store = new OutboundStore(pool, randomBytes(32).toString('hex'));
  const scope = { actor: seed.owner_id, workspace: seed.workspace_id };
  const upstreamTools = [{ name: 'lookup', inputSchema: { type: 'object' } }];
  async function grant(actor: string | typeof scope, token: string) {
    let connection = await store.create(actor, {
      name: 'Search',
      url: 'https://example.com/mcp',
      auth_type: 'bearer',
      token,
    });
    connection = await store.catalog(actor, connection.id, connection.revision, upstreamTools);
    return store.grant(actor, connection.id, {
      revision: connection.revision,
      installation_id: seed.installation_id,
      tools: ['lookup'],
    });
  }
  const personal = await grant(seed.owner_id, 'personal-token');
  const shared = await grant(scope, 'workspace-token');
  const ownerAccess = (await store.issue(seed.execution, seed.installation_id, 'http://localhost/mcp'))!;
  assert.equal(ownerAccess.tools.length, 2);
  const ownerClaims = store.security.verify(ownerAccess.token, 'outbound');
  const { requester, workspace, ...legacyClaims } = ownerClaims;
  assert.deepEqual((await store.allowed(legacyClaims)).map((tool) => tool.connection_id), [personal.id]);
  await pool.query('UPDATE tasks SET requester_id=$2 WHERE id=$1', [seed.task, seed.collaborator_id]);
  await assert.rejects(store.allowed(ownerClaims), /outbound_access_revoked/);
  await assert.rejects(store.allowed(legacyClaims), /outbound_access_revoked/);

  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  let block = false;
  let remoteSignal: AbortSignal | undefined;
  const seen: (string | undefined)[] = [];
  const gateway = createGateway(store, {
    remote: {
      async discover() {
        return upstreamTools;
      },
      async call(connection, _name, _args, signal) {
        seen.push(connection.token);
        if (block) {
          remoteSignal = signal;
          started();
          await new Promise<void>((_, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          );
        }
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
    },
  });
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'shared-test', version: '1' });
  try {
    const access = await store.issue(seed.execution, seed.installation_id, `${address}/mcp`);
    assert.ok(access);
    const claims = store.security.verify(access.token, 'outbound');
    assert.equal(claims.requester, seed.collaborator_id);
    await assert.rejects(store.allowed({ ...claims, workspace: randomUUID() }), /outbound_access_revoked/);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(access.url), {
        requestInit: { headers: { Authorization: `Bearer ${access.token}` } },
      }),
    );
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.description), ['Workspace connection "Search". lookup']);
    assert.deepEqual(
      listed.tools.map((t) => t.name),
      access.tools,
    );
    assert.equal(access.tools.length, 1);
    const name = access.tools[0]!;
    const personalName = ownerAccess.tools.find((tool) => tool !== name)!;
    assert.equal((await client.callTool({ name: personalName })).isError, true);
    assert.notEqual((await client.callTool({ name })).isError, true);
    assert.deepEqual(seen, ['workspace-token']);
    assert.equal((await store.calls(seed.collaborator_id)).items.length, 1);

    block = true;
    const pending = client.callTool({ name });
    await dispatched;
    await store.grant(scope, shared.id, {
      revision: shared.revision,
      installation_id: seed.installation_id,
      tools: [],
    });
    assert.equal((await pending).isError, true);
    assert.equal(remoteSignal?.reason.name, 'AbortError');
    assert.deepEqual((await client.listTools()).tools, []);
    assert.equal(await store.issue(seed.execution, seed.installation_id, access.url), undefined);

    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2', [
      seed.channel_id,
      seed.collaborator_id,
    ]);
    await assert.rejects(store.authority(claims), /outbound_access_revoked/);
    await pool.query('INSERT INTO channel_members(workspace_id,channel_id,user_id) VALUES($1,$2,$3)', [
      seed.workspace_id,
      seed.channel_id,
      seed.collaborator_id,
    ]);
    await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2', [
      seed.workspace_id,
      seed.collaborator_id,
    ]);
    await assert.rejects(store.authority(claims), /outbound_access_revoked/);
  } finally {
    await client.close();
    await gateway.close();
  }
});

test('editing another paired agent’s workspace grant preserves a selected tool and its in-flight response', async () => {
  const { createGateway } = await import('../../apps/mcp-gateway/dist/gateway.js');
  const seed = await fixture();
  const scope = { actor: seed.owner_id, workspace: seed.workspace_id };
  const pairings = new AgentConnectionStore(pool);
  const pairing = await pairings.createPairing(seed.collaborator_id, seed.workspace_id, { provider: 'codex' });
  const other = await pairings.claim({
    code: pairing.code,
    credential: randomBytes(32).toString('base64url'),
    provider: 'codex',
  });
  const store = new OutboundStore(pool, randomBytes(32).toString('hex'));
  let connection = await store.create(scope, { name: 'Team', url: 'https://example.com/mcp', auth_type: 'none' });
  const tools = [{ name: 'read', inputSchema: { type: 'object' } }];
  const grant = async (installation: string) => {
    connection = await store.grant(scope, connection.id, {
      revision: connection.revision,
      installation_id: installation,
      tools: ['read'],
    });
  };
  connection = await store.catalog(scope, connection.id, connection.revision, tools);
  await grant(seed.installation_id);
  let dispatch!: () => void, complete!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    dispatch = resolve;
  });
  const completed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const gateway = createGateway(store, {
    remote: {
      async discover() {
        return tools;
      },
      async call(_connection, _name, _args, signal) {
        dispatch();
        await completed;
        signal.throwIfAborted();
        return { content: [{ type: 'text' as const, text: 'response for first agent' }] };
      },
    },
  });
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'concurrent-grant-test', version: '1' });
  try {
    const access = (await store.issue(seed.execution, seed.installation_id, `${address}/mcp`))!;
    const claims = store.security.verify(access.token, 'outbound');
    const name = access.tools[0]!;
    const selected = (await store.allowedTool(claims, name))!;
    await client.connect(
      new StreamableHTTPClientTransport(new URL(access.url), {
        requestInit: { headers: { Authorization: `Bearer ${access.token}` } },
      }),
    );
    const pending = client.callTool({ name });
    await dispatched;
    await grant(other.installation_id);
    complete();
    const result = await pending;
    assert.deepEqual(result.content, [{ type: 'text', text: 'response for first agent' }]);
    const reserved = await store.reserve(claims, 'after-other-grant', name, {}, selected.dispatchRevision);
    await store.finish(reserved.id, 'succeeded', 1);

    const revisedTools = [{ ...tools[0]!, description: 'Revised tool' }];
    connection = await store.catalog(scope, connection.id, connection.revision, revisedTools);
    await grant(seed.installation_id);
    await assert.rejects(
      store.reserve(claims, 'old-definition', name, {}, selected.dispatchRevision),
      /connection_changed/,
    );
    const beforeRotation = (await store.allowedTool(claims, name))!;
    connection = await store.update(scope, connection.id, {
      revision: connection.revision,
      auth_type: 'bearer',
      token: 'rotated',
    });
    connection = await store.catalog(scope, connection.id, connection.revision, revisedTools);
    await grant(seed.installation_id);
    await assert.rejects(
      store.reserve(claims, 'old-credential', name, {}, beforeRotation.dispatchRevision),
      /connection_changed/,
    );
  } finally {
    complete();
    await client.close();
    await gateway.close();
  }
});

test('workspace knowledge plugins share discovery, scoped grants, cited search and exact resolution', async () => {
  const { createGateway } = await import('../../apps/mcp-gateway/dist/gateway.js');
  const seed = await fixture(), foreign = await bootstrap(pool);
  const store = new OutboundStore(pool, randomBytes(32).toString('hex'));
  const scope = { actor: seed.owner_id, workspace: seed.workspace_id };
  const people = await store.create(scope, { kind: 'people', name: 'Directory', url: 'space:people', auth_type: 'none' });
  const channels = await store.create(scope, { kind: 'channels', name: 'Channels', url: 'space:channels', auth_type: 'none' });
  const catalog = await store.create(scope, { kind: 'knowledge', name: 'Catalog', url: 'https://example.com/mcp', auth_type: 'none' });
  let malformed = false;
  const remote = {
    async discover() {
      return ['knowledge_manifest','knowledge_search','write_document'].map(name => ({ name, inputSchema: { type: 'object' } }));
    },
    async call(connection: { url: string }, name: string, args: Record<string, unknown>) {
      assert.equal(connection.url, catalog.url);
      if (name === 'knowledge_manifest') return { content: [], structuredContent: {
        apiVersion: 1, name: 'Service catalog', description: 'Find service owners',
        filters: [{ key: 'team', description: 'Team name' }],
      } };
      assert.equal(name, 'knowledge_search');
      assert.deepEqual(args.context, {
        workspaceId: seed.workspace_id, requesterId: seed.owner_id, installationId: seed.installation_id,
        connectionId: catalog.id, audience: { kind: 'channel', channelId: seed.channel_id },
      });
      const ref = { connectionId: catalog.id, recordId: 'billing' };
      return { content: [], structuredContent: { hits: [{
        ref, title: 'Billing', evidence: 'Billing is owned by the demo owner.',
        citation: { label: 'Service catalog', url: malformed ? 'javascript:invalid' : 'https://example.com/billing' },
        facts: [{ subject: ref, predicate: 'catalog:owner', value: { connectionId: people.id, recordId: seed.owner_id } }],
      }] } };
    },
  };
  const gateway = createGateway(store, { remote });
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'knowledge-test', version: '1' });
  try {
    for (const connection of [people, channels, catalog]) {
      const token = store.security.sign({ owner: scope.actor, workspace: scope.workspace, installation: '', execution: '',
        aud: 'outbound-internal', exp: Date.now() + 30000 });
      const discovery = await gateway.inject({ method: 'POST', url: '/internal/discover', headers: { host: 'localhost', authorization: 'Bearer ' + token },
        payload: { connection_id: connection.id, revision: connection.revision } });
      assert.equal(discovery.statusCode, 200, discovery.body);
      const discovered = await store.get(scope, connection.id);
      const names = discovered.tools.map(t => t.name);
      assert.deepEqual(names, connection !== catalog ? ['knowledge_search','knowledge_resolve'] : ['knowledge_search']);
      assert.equal(await store.issue(seed.execution, seed.installation_id, address + '/mcp') === undefined, connection === people);
      await store.grant(scope, connection.id, { revision: discovered.revision, installation_id: seed.installation_id, tools: names });
    }
    const access = (await store.issue(seed.execution, seed.installation_id, address + '/mcp'))!;
    await client.connect(new StreamableHTTPClientTransport(new URL(access.url), {
      requestInit: { headers: { authorization: 'Bearer ' + access.token } },
    }));
    const { tools } = await client.listTools();
    const directory = tools.find(t => t.description?.includes('"Directory"') && t.name.endsWith('knowledge_search'))!;
    const resolve = tools.find(t => t.description?.includes('"Directory"') && t.name.endsWith('knowledge_resolv'))!;
    const search = tools.find(t => t.description?.includes('"Catalog"'))!;
    for (const builtIn of [directory, resolve])
      assert.deepEqual(builtIn.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    assert.equal(search.annotations, undefined);
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const channelSearch = tools.find(t => t.description?.includes('"Channels"') && t.name.endsWith('knowledge_search'))!;
    const channelResolve = tools.find(t => t.description?.includes('"Channels"') && t.name.endsWith('knowledge_resolv'))!;
    assert.equal(channelSearch.annotations?.readOnlyHint, true);
    const page = async (query = '', extra = {}) => (await call(channelSearch.name, { query, ...extra })).structuredContent as import('@space/contracts').KnowledgePage;
    const channelHit = async (id: string) => (await call(channelResolve.name, { ref: { connectionId: channels.id, recordId: id } })).structuredContent;
    const { parseConversationPath } = await import('@space/contracts');
    const listed = (await page()).hits;
    assert.deepEqual(listed.map(hit => hit.citation.label), ['#general']);
    assert.equal(parseConversationPath(listed[0]!.citation.url).channel, seed.channel_id);
    const publicId = randomUUID(), privateId = randomUUID(), archivedId = randomUUID();
    await pool.query(`INSERT INTO channels(id,workspace_id,name,private,archived_at) VALUES
      ($1,$4,'public-roadmap',false,NULL),($2,$4,'private-roadmap',true,NULL),($3,$4,'old-roadmap',false,now())`,
      [publicId, privateId, archivedId, seed.workspace_id]);
    await pool.query('INSERT INTO channel_members(workspace_id,channel_id,user_id) VALUES($1,$2,$3)', [seed.workspace_id,privateId,seed.owner_id]);
    assert.deepEqual((await page('#roadmap')).hits.map(h => h.ref.recordId), [publicId]);
    for (const id of [privateId, archivedId, foreign.channel_id]) assert.deepEqual(await channelHit(id), { hit: null });
    const one = await page('', { limit: 1 });
    const two = await page('', { limit: 1, cursor: one.nextCursor });
    assert.equal(two.nextCursor, undefined);
    assert.deepEqual(new Set([one.hits[0]!.ref.recordId,two.hits[0]!.ref.recordId]), new Set([publicId,seed.channel_id]));
    await pool.query('UPDATE channels SET private=true WHERE id=$1', [seed.channel_id]);
    assert.deepEqual(await channelHit(privateId), { hit: null }); // Another audience member is excluded.
    await pool.query('INSERT INTO channel_members(workspace_id,channel_id,user_id) VALUES($1,$2,$3)', [seed.workspace_id,privateId,seed.collaborator_id]);
    assert.deepEqual((await page('private-roadmap')).hits.map(h => h.ref.recordId), [privateId]);
    await pool.query('UPDATE channels SET private=false WHERE id=$1', [seed.channel_id]);
    assert.deepEqual(await channelHit(privateId), { hit: null }); // A public room can gain new readers.
    const result = await call(search.name, { query: 'billing', filters: { team: 'finance' } });
    const resultPage = result.structuredContent as import('@space/contracts').KnowledgePage;
    const ref = resultPage.hits[0]!.facts![0]!.value;
    const resolved = (await call(resolve.name, { ref })).structuredContent as { hit: import('@space/contracts').KnowledgeHit };
    assert.equal(resolved.hit.ref.recordId, seed.owner_id);
    assert.equal(resolved.hit.citation.label, '@' + resolved.hit.title);
    assert.ok(resolved.hit.citation.url.endsWith('?profile=user:' + seed.owner_id));
    const before = (await call(directory.name, { query: '', filters: { workspace_role: 'admin' } })).structuredContent;
    assert.deepEqual(before, { hits: [] });
    await pool.query("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [seed.workspace_id,seed.collaborator_id]);
    const after = (await call(directory.name, { query: '', filters: { workspace_role: 'admin' } })).structuredContent as import('@space/contracts').KnowledgePage;
    assert.deepEqual(after.hits.map(hit => hit.ref.recordId), [seed.collaborator_id]);
    const first = (await call(directory.name, { query: '', limit: 1 })).structuredContent as import('@space/contracts').KnowledgePage;
    assert.ok(first.nextCursor);
    const second = (await call(directory.name, { query: '', limit: 1, cursor: first.nextCursor })).structuredContent as import('@space/contracts').KnowledgePage;
    assert.equal(second.nextCursor, undefined);
    assert.notEqual(first.hits[0]!.ref.recordId, second.hits[0]!.ref.recordId);
    assert.deepEqual((await call(resolve.name, { ref: { connectionId: people.id, recordId: foreign.owner_id } })).structuredContent, { hit: null });
    assert.equal((await call(directory.name, { query: '', filters: { team: 'x' } })).isError, true);
    assert.equal((await call(search.name, { query: '', context: {} })).isError, true);
    malformed = true;
    assert.equal((await call(search.name, { query: 'billing' })).isError, true);
    const privatePeer = randomUUID();
    await pool.query('INSERT INTO users(id) VALUES($1)', [privatePeer]);
    await pool.query('INSERT INTO workspace_members(workspace_id,user_id) VALUES($1,$2)', [seed.workspace_id,privatePeer]);
    const peerRef = { connectionId: people.id, recordId: privatePeer };
    assert.ok(((await call(resolve.name, { ref: peerRef })).structuredContent as { hit: unknown }).hit);
    await pool.query("UPDATE workspace_members SET role='member',guest_type='multi' WHERE workspace_id=$1 AND user_id=$2", [seed.workspace_id,seed.collaborator_id]);
    assert.deepEqual((await call(resolve.name, { ref: peerRef })).structuredContent, { hit: null });
    assert.deepEqual((await page()).hits.map(hit => hit.ref.recordId), [seed.channel_id]); // Guest audience cannot discover unjoined public channels.
    assert.deepEqual(await channelHit(publicId), { hit: null });
    const current = await store.get(scope, people.id);
    await store.grant(scope, people.id, { installation_id: seed.installation_id, tools: [], revision: current.revision });
    assert.equal((await client.listTools()).tools.length, 3);
    assert.equal((await call(resolve.name, { ref })).isError, true);
  } finally { await client.close(); await gateway.close(); }
});
