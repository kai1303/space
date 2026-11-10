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
  await grant(seed.owner_id, 'personal-token');
  const shared = await grant(scope, 'workspace-token');
  const ownerAccess = (await store.issue(seed.execution, seed.installation_id, 'http://localhost/mcp'))!;
  assert.equal(ownerAccess.tools.length, 2);
  const ownerClaims = store.security.verify(ownerAccess.token, 'outbound');
  const { requester, workspace, ...legacyClaims } = ownerClaims;
  assert.equal((await store.allowed(legacyClaims)).length, 1);
  await pool.query('UPDATE tasks SET requester_id=$2 WHERE id=$1', [seed.task, seed.collaborator_id]);
  await assert.rejects(store.allowed(ownerClaims), /outbound_access_revoked/);
  await assert.rejects(store.allowed(legacyClaims), /outbound_access_revoked/);

  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  let block = false;
  const seen: (string | undefined)[] = [];
  const gateway = createGateway(store, {
    remote: {
      async discover() {
        return upstreamTools;
      },
      async call(connection, _name, _args, signal) {
        seen.push(connection.token);
        if (block) {
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
