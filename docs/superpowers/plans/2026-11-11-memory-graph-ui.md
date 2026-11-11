# Memory Graph UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show layered short-term memory as a Neo4j-style graph in the channel Memory dialog, and let channel managers edit memories. Spec: `docs/superpowers/specs/2026-11-11-memory-graph-ui-design.md`.

**Architecture:** The server gets 5 routes over the existing `@space/postgres/layered-memory` functions, plus person-facing read/write variants. Migration 087 adds a trigger so every memory insert sends a channel live update. `@space/ui/graph` holds a generic `GraphCanvas`: React draws the SVG and handles zoom and drag, and `d3-force` computes the layout synchronously (300 ticks max, seeded, no timers). `apps/web/src/features/memory` adds `MemoryGraph` (data and expand state) and `MemoryInspector` (details and manager editor), and `ChannelMemory` gets Graph and Notes views.

**Tech Stack:** TypeScript, Fastify, PostgreSQL, React 19, `d3-force` 3 (ISC), Vitest + Testing Library, `node:test` + `tsx`.

**Licensing rule:** do not open, copy or paraphrase Neo4j Browser source while implementing. Only the interaction design from the spec is reused.

**Test commands:**
- Backend: `cd tests && env TEST_DATABASE_URL=postgres://workplace:local_demo_only@127.0.0.1:55438/workplace_test NATS_URL=nats://127.0.0.1:54333 npx tsx --test integration/memory-graph.test.ts` (start NATS 2.12+ first: `docker run -d --rm --name space-test-nats -p 127.0.0.1:54333:4222 nats:2.12-alpine -js`)
- UI package: `cd packages/ui && npx vitest run src/graph`
- Web: `cd apps/web && npx vitest run src/features/memory`

**Spec deviation (recorded in Task 9):** the spec lists `d3-zoom`, `d3-drag` and `d3-selection`. React pointer and wheel handlers do zoom and drag instead, so only `d3-force` is added. This keeps rendering in React, testable in jsdom, with one dependency.

---

## File map

| File | Responsibility |
| --- | --- |
| Create `adapters/postgres/migrations/087_memory_updates.sql` | Trigger: memory insert → `chat_delivery_outbox` row (`metadata`) |
| Modify `adapters/postgres/migrate.ts` | Register 087 |
| Modify `adapters/postgres/layered-memory.ts` | `readSessionMemoryForPerson`, `writeThreadMemoryForPerson`, `writeSessionMemoryForPerson` |
| Modify `apps/server/memory.ts` | 5 routes |
| Modify `apps/server/api.ts` | Pass a session locator into `registerMemoryRoutes` |
| Create `tests/integration/memory-graph.test.ts` | Route and trigger tests |
| Modify `packages/ui/package.json` | `./graph` export, `d3-force`, `@types/d3-force` |
| Create `packages/ui/src/graph/layout.ts` | Pure layout and link geometry |
| Create `packages/ui/src/graph/GraphCanvas.tsx` | SVG view, zoom, drag, selection, keyboard, ring menu |
| Create `packages/ui/src/graph/index.ts` | Exports |
| Modify `packages/ui/src/styles/workplace.css` | `.sp-graph*` styles |
| Create `packages/ui/src/graph/layout.test.ts`, `GraphCanvas.test.tsx` | Unit tests |
| Create `apps/web/src/gallery/examples/GraphCanvas.stories.tsx` | Storybook |
| Create `apps/web/src/features/memory/memory-api.ts` | Typed route calls |
| Create `apps/web/src/features/memory/MemoryGraph.tsx` | Graph data, paging, expand, live refresh |
| Create `apps/web/src/features/memory/MemoryInspector.tsx` | Details panel and editor |
| Create `apps/web/src/features/memory/memory-graph.css` | Layout of graph plus panel |
| Create `apps/web/src/features/memory/MemoryGraph.test.tsx`, `MemoryInspector.test.tsx` | Feature tests |
| Modify `apps/web/src/features/memory/ChannelMemory.tsx` | Graph and Notes views, open-thread callbacks |
| Modify `apps/web/src/features/chat/ChannelRoom.tsx` | Wire `onOpenThread` and `onOpenSession` |

---

### Task 1: Live update trigger (migration 087)

**Files:**
- Create: `adapters/postgres/migrations/087_memory_updates.sql`
- Modify: `adapters/postgres/migrate.ts`
- Test: `tests/integration/memory-graph.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/memory-graph.test.ts`:

```typescript
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';
import { saveTurnMemory } from '@space/postgres/layered-memory';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
const schema = `memory_graph_${randomBytes(6).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const directory = await mkdtemp(join(tmpdir(), 'space-memory-graph-'));
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, memory: { directory } });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); await app.ready(); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(directory, { recursive: true, force: true }); });

async function api(token: string, method: 'GET' | 'POST', path: string, payload?: object, expected = 200) {
  const response = await app.inject({ method, url: `/v1${path}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  assert.equal(response.statusCode, expected, response.body); return response.json();
}
async function post(token: string, channel: string, text: string, thread?: string) {
  return api(token, 'POST', `/channels/${channel}/messages`, { client_message_id: randomUUID(), text, ...(thread ? { thread_id: thread } : {}) }, 201);
}
async function addSession(a: { workspace_id: string; installation_id: string }, thread: string) {
  const id = randomUUID();
  await pool.query(`INSERT INTO agent_sessions(id,workspace_id,installation_id,origin_thread_id,title) VALUES($1,$2,$3,$4,'Fix fixture')`, [id, a.workspace_id, a.installation_id, thread]);
  return id;
}
const db = () => new PostgresStore(pool).db;
async function agentSave(a: { channel_id: string; installation_id: string }, thread: string, session: string | null, part: 'thread' | 'session', revision: number, summary: string) {
  return saveTurnMemory(db(), { channelId: a.channel_id, threadId: thread, sessionId: session, installationId: a.installation_id, producer: { id: a.installation_id, name: 'Codex' },
    memory: { [part]: { base_revision: revision, summary, content: `# ${summary}` } } });
}

test('a memory insert enqueues one channel metadata delivery', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Start');
  const before = (await pool.query(`SELECT count(*)::int AS n FROM chat_delivery_outbox WHERE channel_id=$1 AND resource_scope='metadata'`, [a.channel_id])).rows[0].n;
  await agentSave(a, root.thread_id, null, 'thread', 0, 'First');
  const afterCount = (await pool.query(`SELECT count(*)::int AS n FROM chat_delivery_outbox WHERE channel_id=$1 AND resource_scope='metadata'`, [a.channel_id])).rows[0].n;
  assert.equal(afterCount - before, 1);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run the backend command from the header.
Expected: FAIL. `afterCount - before` is `0`.

- [ ] **Step 3: Write the migration**

Create `adapters/postgres/migrations/087_memory_updates.sql`:

```sql
-- Every saved memory tells open memory views in the channel to re-read. One row per insert.
CREATE FUNCTION enqueue_memory_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO chat_delivery_outbox(channel_id, workspace_id, resource_scope)
    SELECT NEW.channel_id, c.workspace_id, 'metadata' FROM channels c WHERE c.id = NEW.channel_id;
  RETURN NULL;
END; $$;
CREATE TRIGGER memory_revisions_memory_update AFTER INSERT ON memory_revisions
  FOR EACH ROW EXECUTE FUNCTION enqueue_memory_update();
```

In `adapters/postgres/migrate.ts`, change `'085_layered_memory.sql', '086_memory_pending.sql',` to `'085_layered_memory.sql', '086_memory_pending.sql', '087_memory_updates.sql',`.

Migration 049's `enqueue_stream_chat` turns a `metadata` row into the `workspace:<id>` and `channel:<id>` keys, which `subscribeUpdates('channel', id, …)` listens on (`apps/server/resource-updates.ts:35`).

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm --filter @space/postgres build`, then the backend command.
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add adapters/postgres/migrations/087_memory_updates.sql adapters/postgres/migrate.ts tests/integration/memory-graph.test.ts
git commit -m "Send a channel update when a memory is saved"
```

---

### Task 2: Person read and write variants

**Files:**
- Modify: `adapters/postgres/layered-memory.ts`
- Test: `tests/integration/memory-graph.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/memory-graph.test.ts`:

```typescript
import { readSessionMemoryForPerson, writeThreadMemoryForPerson, writeSessionMemoryForPerson } from '@space/postgres/layered-memory';

test('person variants read any session and write with the person as producer', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Start');
  const session = await addSession(a, root.thread_id);
  const person = { id: a.owner_id, name: 'Demo owner' };
  const thread = await writeThreadMemoryForPerson(db(), a.channel_id, root.thread_id, { revision: 0, summary: 'Edited', content: '# Fixed by a person' }, person);
  assert.equal(thread.revision, 1);
  assert.equal(thread.producer_name, 'Demo owner');
  const own = await writeSessionMemoryForPerson(db(), a.channel_id, session, { revision: 0, summary: 'Session edit', content: 'x' }, person);
  assert.equal(own.revision, 1);
  const read = await readSessionMemoryForPerson(db(), a.channel_id, session);
  assert.equal(read.memory?.summary, 'Session edit');
  await assert.rejects(writeThreadMemoryForPerson(db(), a.channel_id, root.thread_id, { revision: 0, summary: 'Stale', content: 'y' }, person), (e: any) => e.code === 'thread_memory_conflict');
  await pool.query(`UPDATE agent_sessions SET state='ended' WHERE id=$1`, [session]);
  assert.equal((await readSessionMemoryForPerson(db(), a.channel_id, session)).node.state, 'ended');
  await assert.rejects(writeSessionMemoryForPerson(db(), a.channel_id, session, { revision: 1, summary: 'Late', content: 'z' }, person), (e: any) => e.code === 'session_ended');
});
```

- [ ] **Step 2: Run it and confirm it fails**

Expected: FAIL with an import error for `readSessionMemoryForPerson`.

- [ ] **Step 3: Implement**

In `adapters/postgres/layered-memory.ts`:

1. Split `readSessionMemory` so the body after the access check is reusable. Replace the existing function with:

```typescript
async function sessionMemoryFor(c: DbSession, channelId: string, session: Awaited<ReturnType<typeof sessionRow>>): Promise<SessionMemory> {
  const memory = await sessionMemoryRow(c, session.id);
  const recent = await rows<{ id: string; sequence: string; text: string; text_length: number; author_id: string; attachments: ThreadContextMessage['attachments'] }>(c, sql`
    SELECT id, sequence::text, left(text, 1000) AS text, length(text) AS text_length, installation_id AS author_id, attachments
    FROM messages WHERE channel_id = ${channelId} AND thread_id = ${session.thread_id} AND agent_session_id = ${session.id}
    ORDER BY sequence DESC LIMIT 16`);
  const messages: ThreadContextMessage[] = recent.reverse().map(row => {
    const text = row.text.replace(/[\uD800-\uDBFF]$/, '');
    return { id: row.id, sequence: row.sequence, text, text_truncated: row.text_length > 1000 || text !== row.text, author: { id: row.author_id, kind: 'agent' }, attachments: row.attachments };
  });
  return {
    node: { ref: { kind: 'session', id: session.id }, parent: { kind: 'thread', id: session.thread_id }, summary: memory?.summary ?? session.title, updated_at: memory?.created_at ?? session.created_at, children: null, title: session.title, agent: session.agent, state: session.state },
    memory, messages, memory_chars: memory?.content.length ?? 0, limit: MEMORY_LIMIT,
  };
}

// installationId is the caller's bound installation; null means an unbound key.
export async function readSessionMemory(c: DbSession, channelId: string, sessionId: string, installationId: string | null): Promise<SessionMemory> {
  const session = await sessionRow(c, channelId, sessionId);
  ownSession(session, installationId);
  return sessionMemoryFor(c, channelId, session);
}
// People: the route authorizes thread access first. Ended sessions stay readable as history.
export async function readSessionMemoryForPerson(c: DbSession, channelId: string, sessionId: string): Promise<SessionMemory> {
  return sessionMemoryFor(c, channelId, await sessionRow(c, channelId, sessionId));
}
```

2. Split `writeSessionMemory` the same way. Replace it with:

```typescript
async function insertSessionMemory(c: DbSession, channelId: string, session: Awaited<ReturnType<typeof sessionRow>>, input: MemoryInput, producer: { id: string; name: string }): Promise<MemoryRecord> {
  if (session.state === 'ended') throw new AppError(409, 'session_ended');
  await assertContextThread(c, channelId, session.thread_id);
  const current = await sessionMemoryRow(c, session.id);
  if ((current?.revision ?? 0) !== input.revision) throw new AppError(409, 'session_memory_conflict');
  if (current && BigInt(chatCursor(input.through_sequence)) < BigInt(current.through_sequence)) throw new AppError(409, 'session_memory_watermark_conflict');
  await assertMemorySources(c, channelId, session.thread_id, input, 'session');
  const [saved] = await rows<MemoryRecord>(c, sql`INSERT INTO memory_revisions(thread_id,session_id,channel_id,revision,through_sequence,content,summary,source_message_ids,producer_id,producer_name)
    VALUES(${session.thread_id},${session.id},${channelId},${input.revision + 1},${input.through_sequence}::bigint,${input.content},${input.summary},${sql.param(input.source_message_ids)}::uuid[],${producer.id},${producer.name})
    ON CONFLICT (session_id, revision) WHERE session_id IS NOT NULL DO NOTHING
    RETURNING ${memoryColumns}`);
  if (!saved) throw new AppError(409, 'session_memory_conflict');
  return saved;
}

// Optimistic concurrency: the partial unique index on (session_id, revision) rejects a competing insert.
export async function writeSessionMemory(c: DbSession, channelId: string, sessionId: string, installationId: string | null, input: MemoryInput, producer: { id: string; name: string }): Promise<MemoryRecord> {
  const session = await sessionRow(c, channelId, sessionId);
  ownSession(session, installationId);
  return insertSessionMemory(c, channelId, session, input, producer);
}
```

3. Add the person write helpers at the end of the file:

```typescript
export interface PersonMemoryInput { revision: number; summary: string; content: string }

// Person edits anchor to the thread's latest message, like turn-end saves.
async function personInput(c: DbSession, channelId: string, threadId: string, input: PersonMemoryInput): Promise<MemoryInput> {
  const [last] = await rows<{ id: string; sequence: string }>(c, sql`SELECT id, sequence::text FROM messages WHERE channel_id=${channelId} AND thread_id=${threadId} ORDER BY sequence DESC LIMIT 1`);
  if (!last) throw new AppError(409, 'thread_empty');
  return parseMemoryInput({ revision: input.revision, through_sequence: last.sequence, summary: input.summary, content: input.content, source_message_ids: [last.id] });
}
export async function writeThreadMemoryForPerson(c: DbSession, channelId: string, threadId: string, input: PersonMemoryInput, person: { id: string; name: string }): Promise<MemoryRecord> {
  await assertContextThread(c, channelId, threadId);
  return writeThreadMemory(c, channelId, threadId, await personInput(c, channelId, threadId, input), person);
}
export async function writeSessionMemoryForPerson(c: DbSession, channelId: string, sessionId: string, input: PersonMemoryInput, person: { id: string; name: string }): Promise<MemoryRecord> {
  const session = await sessionRow(c, channelId, sessionId);
  return insertSessionMemory(c, channelId, session, await personInput(c, channelId, session.thread_id, input), person);
}
```

Add `parseMemoryInput` to the `@space/contracts` import at the top of the file.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @space/postgres build`, then the backend command for `integration/memory-graph.test.ts integration/layered-memory.test.ts`.
Expected: PASS for all tests.

- [ ] **Step 5: Commit**

```bash
git add adapters/postgres/layered-memory.ts tests/integration/memory-graph.test.ts
git commit -m "Add person read and write variants for layered memory"
```

---

### Task 3: HTTP routes

**Files:**
- Modify: `apps/server/memory.ts`
- Modify: `apps/server/api.ts:161-163`
- Test: `tests/integration/memory-graph.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/memory-graph.test.ts`:

```typescript
test('routes: members read, managers edit, conflicts and access are enforced', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Dedupe fix');
  const session = await addSession(a, root.thread_id);
  await agentSave(a, root.thread_id, session, 'thread', 0, 'Dedupe fix · in progress');
  const base = `/channels/${a.channel_id}`;

  const page = await api(a.collaborator_token, 'GET', `${base}/memory/layers`);
  assert.equal(page.nodes[0].summary, 'Dedupe fix · in progress');
  const thread = await api(a.collaborator_token, 'GET', `${base}/threads/${root.thread_id}/memory`);
  assert.equal(thread.sessions.length, 1);
  const read = await api(a.collaborator_token, 'GET', `${base}/agent-sessions/${session}/memory`);
  assert.equal(read.node.ref.id, session);

  await api(a.collaborator_token, 'POST', `${base}/threads/${root.thread_id}/memory`, { revision: 1, summary: 'Nope', content: 'x' }, 403);
  const saved = await api(a.owner_token, 'POST', `${base}/threads/${root.thread_id}/memory`, { revision: 1, summary: 'Edited by owner', content: '# Edited' });
  assert.equal(saved.revision, 2);
  assert.equal(saved.producer_name, 'Demo owner');
  const stale = await app.inject({ method: 'POST', url: `/v1${base}/threads/${root.thread_id}/memory`, headers: { authorization: `Bearer ${a.owner_token}` }, payload: { revision: 1, summary: 'Old', content: 'y' } });
  assert.equal(stale.statusCode, 409);
  assert.match(stale.body, /thread_memory_conflict/);
  await api(a.owner_token, 'POST', `${base}/threads/${root.thread_id}/memory`, { revision: 2, summary: 'x'.repeat(281), content: 'y' }, 400);
  await api(a.owner_token, 'POST', `${base}/agent-sessions/${session}/memory`, { revision: 0, summary: 'Session fixed', content: 'ok' });

  const outcome = await agentSave(a, root.thread_id, session, 'thread', 1, 'Agent on old revision');
  assert.deepEqual(outcome, [{ scope: 'thread', outcome: 'pending' }]);

  await api(b.owner_token, 'GET', `${base}/memory/layers`, undefined, 404);
  await api(a.owner_token, 'GET', `/channels/${b.channel_id}/agent-sessions/${session}/memory`, undefined, 404);
  await api(a.owner_token, 'GET', `${base}/memory/layers?after=bad!`, undefined, 400);
});
```

`bootstrap` makes `owner` a workspace owner and channel creator, so `can_manage` is true. `collaborator` is a plain member, so `can_manage` is false (`adapters/postgres/memory.ts` `authorize`).

- [ ] **Step 2: Run it and confirm it fails**

Expected: FAIL with `404` on `/memory/layers` (route missing).

- [ ] **Step 3: Add the routes**

In `apps/server/memory.ts`:

Add imports:

```typescript
import { readChannelMemory, readThreadMemory, readSessionMemoryForPerson, writeThreadMemoryForPerson, writeSessionMemoryForPerson } from '@space/postgres/layered-memory';
import { sql } from 'drizzle-orm';
```

Change the signature to accept a session locator:

```typescript
export type SessionLocator = { location(actor: string, id: string): Promise<{ channel_id: string }> };
export function registerMemoryRoutes(app: FastifyInstance, store: MemoryStore, providers = createMemoryProviders(), sessions?: SessionLocator) {
```

Inside the function, after the existing `threadPath` routes, add:

```typescript
  const layerBody = (body: unknown) => {
    const v = record(body, ['revision', 'summary', 'content']);
    if (!Number.isSafeInteger(v.revision) || (v.revision as number) < 0 || typeof v.summary !== 'string' || typeof v.content !== 'string') throw new AppError(400, 'invalid_memory_edit');
    return { revision: v.revision as number, summary: v.summary, content: v.content };
  };
  const person = async (c: Parameters<Parameters<MemoryStore['channel']>[2]>[1], actor: string) => {
    const { rows: [user] } = await c.execute<{ display_name: string }>(sql`SELECT display_name FROM users WHERE id=${actor}`);
    return { id: actor, name: user?.display_name ?? 'Member' };
  };
  const manager = (channel: MemoryChannel) => { if (!channel.can_manage) throw new AppError(403, 'channel_management_forbidden'); };
  const visibleSession = async (actor: string, channelId: string, sessionId: string) => {
    if (!sessions) throw new AppError(503, 'sessions_unavailable');
    const location = await sessions.location(actor, sessionId);
    if (location.channel_id !== channelId) throw new AppError(404, 'not_found');
  };

  app.get<{ Params: { channelId: string } }>(`${path}/layers`, r => {
    const q = record(r.query, ['after', 'limit']);
    const after = q.after === undefined ? undefined : text(q.after, 512);
    const limit = q.limit === undefined ? undefined : Number(q.limit);
    return store.channel(r.actorId, r.params.channelId, (channel, c) => readChannelMemory(c, channel.channel_id, after, limit));
  });
  app.get<{ Params: { channelId: string; threadId: string } }>('/v1/channels/:channelId/threads/:threadId/memory', r => {
    record(r.query, []);
    return store.channel(r.actorId, r.params.channelId, (channel, c) => readThreadMemory(c, channel.channel_id, uuid(r.params.threadId)));
  });
  app.post<{ Params: { channelId: string; threadId: string } }>('/v1/channels/:channelId/threads/:threadId/memory', r => {
    const input = layerBody(r.body);
    return store.channel(r.actorId, r.params.channelId, async (channel, c) => {
      manager(channel);
      return writeThreadMemoryForPerson(c, channel.channel_id, uuid(r.params.threadId), input, await person(c, r.actorId));
    });
  });
  app.get<{ Params: { channelId: string; sessionId: string } }>('/v1/channels/:channelId/agent-sessions/:sessionId/memory', async r => {
    record(r.query, []);
    const channelId = uuid(r.params.channelId), sessionId = uuid(r.params.sessionId);
    await visibleSession(r.actorId, channelId, sessionId);
    return store.channel(r.actorId, channelId, (channel, c) => readSessionMemoryForPerson(c, channel.channel_id, sessionId));
  });
  app.post<{ Params: { channelId: string; sessionId: string } }>('/v1/channels/:channelId/agent-sessions/:sessionId/memory', async r => {
    const input = layerBody(r.body), channelId = uuid(r.params.channelId), sessionId = uuid(r.params.sessionId);
    await visibleSession(r.actorId, channelId, sessionId);
    return store.channel(r.actorId, channelId, async (channel, c) => {
      manager(channel);
      return writeSessionMemoryForPerson(c, channel.channel_id, sessionId, input, await person(c, r.actorId));
    });
  });
```

`path` is the existing `/v1/channels/:channelId/memory` constant in this function. Check its name with `grep -n "const path" apps/server/memory.ts`. If it differs, use `/v1/channels/:channelId/memory/layers` directly.

In `apps/server/api.ts`, line 163, change `registerMemoryRoutes(app, memory, memoryProviders);` to:

```typescript
  registerMemoryRoutes(app, memory, memoryProviders, new AgentSessionStore(store.pool, store));
```

`AgentSessionStore` is already imported in `api.ts` (line 26).

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @space/postgres --filter @space/server build`, then the backend command for `integration/memory-graph.test.ts integration/memory-mcp.test.ts integration/layered-memory.test.ts`.
Expected: PASS for all tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/memory.ts apps/server/api.ts tests/integration/memory-graph.test.ts
git commit -m "Add memory graph read and manager edit routes"
```

---

### Task 4: Graph layout (pure)

**Files:**
- Modify: `packages/ui/package.json`
- Create: `packages/ui/src/graph/layout.ts`
- Test: `packages/ui/src/graph/layout.test.ts`

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @space/ui add d3-force@^3.0.0 && pnpm --filter @space/ui add -D @types/d3-force@^3.0.10`
Then add the export next to `./motion` in `packages/ui/package.json`:

```json
    "./graph": {
      "types": "./dist/graph/index.d.ts",
      "import": "./dist/graph/index.js"
    },
```

- [ ] **Step 2: Write the failing test**

Create `packages/ui/src/graph/layout.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { layoutGraph, linkPath, NODE_RADIUS } from './layout.js';

const nodes = [{ id: 'c' }, { id: 't1' }, { id: 't2' }, { id: 's1' }];
const links = [{ id: 'a', source: 'c', target: 't1' }, { id: 'b', source: 'c', target: 't2' }, { id: 'd', source: 't1', target: 's1' }];

describe('layoutGraph', () => {
  it('is deterministic, finite and keeps nodes apart', () => {
    const one = layoutGraph(nodes, links), two = layoutGraph(nodes, links);
    expect([...one.entries()]).toEqual([...two.entries()]);
    const points = [...one.values()];
    expect(points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    for (const p of points) for (const q of points) if (p !== q) expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(NODE_RADIUS * 1.5);
  });
  it('keeps pinned nodes in place and starts new nodes near their parent', () => {
    const first = layoutGraph(nodes, links);
    const pinned = new Map([['c', { x: 500, y: 500, pinned: true }]]);
    const second = layoutGraph([...nodes, { id: 's2' }], [...links, { id: 'e', source: 't2', target: 's2' }], new Map([...first, ...pinned]));
    expect(second.get('c')).toEqual({ x: 500, y: 500, pinned: true });
    expect(second.get('s2')).toBeDefined();
  });
  it('returns an empty map for no nodes', () => {
    expect(layoutGraph([], []).size).toBe(0);
  });
});

describe('linkPath', () => {
  it('draws a straight line edge to edge, and curves parallel links apart', () => {
    const a = { x: 0, y: 0 }, b = { x: 100, y: 0 };
    expect(linkPath(a, b, 0, 1)).toBe(`M${NODE_RADIUS},0L${100 - NODE_RADIUS},0`);
    expect(linkPath(a, b, 0, 2)).toMatch(/^M.+Q.+$/);
    expect(linkPath(a, b, 0, 2)).not.toBe(linkPath(a, b, 1, 2));
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd packages/ui && npx vitest run src/graph`
Expected: FAIL, module `./layout.js` not found.

- [ ] **Step 4: Implement `packages/ui/src/graph/layout.ts`**

```typescript
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';

export const NODE_RADIUS = 28;
export const MAX_TICKS = 300;
export type Point = { x: number; y: number; pinned?: boolean };
type SimNode = SimulationNodeDatum & { id: string };
type SimLink = SimulationLinkDatum<SimNode> & { id: string };

// Seeded so the same graph always settles the same way (stable tests, no jumping on refresh).
function seeded(seed = 1) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}

export function layoutGraph(nodes: { id: string }[], links: { id: string; source: string; target: string }[], previous: ReadonlyMap<string, Point> = new Map()): Map<string, Point> {
  if (!nodes.length) return new Map();
  const ids = new Set(nodes.map(n => n.id));
  const parent = new Map(links.filter(l => ids.has(l.source) && ids.has(l.target)).map(l => [l.target, l.source]));
  const sim: SimNode[] = [];
  const byId = new Map<string, SimNode>();
  const place = (id: string, index: number): SimNode => {
    const known = previous.get(id);
    if (known) return { id, x: known.x, y: known.y, ...(known.pinned ? { fx: known.x, fy: known.y } : {}) };
    const anchor = parent.get(id), base = anchor ? byId.get(anchor) ?? (previous.get(anchor) ? { x: previous.get(anchor)!.x, y: previous.get(anchor)!.y } : undefined) : undefined;
    const angle = index * 2.399963; // golden angle spreads siblings
    const distance = base ? NODE_RADIUS * 4 : NODE_RADIUS * 3 * Math.sqrt(index);
    return { id, x: (base?.x ?? 0) + Math.cos(angle) * distance, y: (base?.y ?? 0) + Math.sin(angle) * distance };
  };
  // Parents before children so a new child can start next to its parent.
  const depth = (id: string, seen = new Set<string>()): number => { const p = parent.get(id); return p && !seen.has(p) ? 1 + depth(p, seen.add(id)) : 0; };
  [...nodes].sort((a, b) => depth(a.id) - depth(b.id)).forEach((n, index) => { const s = place(n.id, index); sim.push(s); byId.set(n.id, s); });
  const simLinks: SimLink[] = links.filter(l => ids.has(l.source) && ids.has(l.target)).map(l => ({ id: l.id, source: l.source, target: l.target }));
  const simulation = forceSimulation<SimNode, SimLink>(sim)
    .randomSource(seeded())
    .velocityDecay(0.4)
    .alphaMin(0.05)
    .force('charge', forceManyBody<SimNode>().strength(-420))
    .force('link', forceLink<SimNode, SimLink>(simLinks).id(n => n.id).distance(NODE_RADIUS * 2 + 90))
    .force('collide', forceCollide<SimNode>(NODE_RADIUS * 1.6))
    .force('x', forceX<SimNode>(0).strength(0.03))
    .force('y', forceY<SimNode>(0).strength(0.03))
    .stop();
  for (let tick = 0; tick < MAX_TICKS && simulation.alpha() >= simulation.alphaMin(); tick++) simulation.tick();
  return new Map(sim.map(n => [n.id, { x: Math.round(n.x! * 10) / 10, y: Math.round(n.y! * 10) / 10, ...(n.fx != null ? { pinned: true } : {}) }]));
}

// Edge to edge, so arrowheads sit on the circle. Parallel links between one pair bend apart.
export function linkPath(from: { x: number; y: number }, to: { x: number; y: number }, index: number, count: number): string {
  const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy) || 1;
  const ux = dx / length, uy = dy / length;
  const sx = from.x + ux * NODE_RADIUS, sy = from.y + uy * NODE_RADIUS, ex = to.x - ux * NODE_RADIUS, ey = to.y - uy * NODE_RADIUS;
  const round = (v: number) => Math.round(v * 10) / 10;
  if (count <= 1) return `M${round(sx)},${round(sy)}L${round(ex)},${round(ey)}`;
  const bend = (index - (count - 1) / 2) * 36 || 18;
  const mx = (sx + ex) / 2 - uy * bend, my = (sy + ey) / 2 + ux * bend;
  return `M${round(sx)},${round(sy)}Q${round(mx)},${round(my)} ${round(ex)},${round(ey)}`;
}
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/ui && npx vitest run src/graph`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/ui/package.json pnpm-lock.yaml packages/ui/src/graph/layout.ts packages/ui/src/graph/layout.test.ts
git commit -m "Add deterministic force layout for graph views"
```

---

### Task 5: `GraphCanvas`

**Files:**
- Create: `packages/ui/src/graph/GraphCanvas.tsx`, `packages/ui/src/graph/index.ts`
- Modify: `packages/ui/src/styles/workplace.css`
- Test: `packages/ui/src/graph/GraphCanvas.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `packages/ui/src/graph/GraphCanvas.test.tsx`:

```tsx
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GraphCanvas, type GraphNode, type GraphLink } from './index.js';

afterEach(cleanup);
const nodes: GraphNode[] = [
  { id: 'c', kind: 'channel', caption: '#payments' },
  { id: 't', kind: 'thread', caption: 'Dedupe fix · in progress with a very long caption here' },
  { id: 's', kind: 'session', caption: 'Codex', muted: true },
];
const links: GraphLink[] = [{ id: 'ct', source: 'c', target: 't', label: 'HAS' }, { id: 'ts', source: 't', target: 's', label: 'HAS_SESSION' }];
const palette = { channel: 'var(--sp-accent)', thread: 'var(--sp-success)', session: 'var(--sp-warning)' };
function setup(extra: Partial<Parameters<typeof GraphCanvas>[0]> = {}) {
  const onSelect = vi.fn(), onToggleExpand = vi.fn();
  render(<GraphCanvas label="Channel memory graph" nodes={nodes} links={links} palette={palette} expandedIds={new Set()} onSelect={onSelect} onToggleExpand={onToggleExpand} {...extra} />);
  return { onSelect, onToggleExpand };
}

it('renders accessible nodes, cut captions and named links', () => {
  setup();
  expect(screen.getByRole('application', { name: 'Channel memory graph' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '#payments, channel' })).toBeTruthy();
  expect(screen.getByText('Dedupe fix · in progress…')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Codex, session, ended' })).toBeTruthy();
  expect(screen.getByText('HAS_SESSION')).toBeTruthy();
});

it('click selects, double-click and Enter toggle expand, background click clears', () => {
  const { onSelect, onToggleExpand } = setup();
  const thread = screen.getByRole('button', { name: /^Dedupe fix/ });
  fireEvent.click(thread);
  expect(onSelect).toHaveBeenLastCalledWith('t');
  fireEvent.doubleClick(thread);
  fireEvent.keyDown(thread, { key: 'Enter' });
  expect(onToggleExpand).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByTestId('sp-graph-background'));
  expect(onSelect).toHaveBeenLastCalledWith(undefined);
});

it('arrow keys move focus along links, and the ring menu runs actions', () => {
  const open = vi.fn();
  setup({ selectedId: 't', menu: id => [{ label: 'Open thread', onClick: () => open(id) }] });
  const channel = screen.getByRole('button', { name: '#payments, channel' });
  channel.focus();
  fireEvent.keyDown(channel, { key: 'ArrowRight' });
  expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Dedupe fix/);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open thread' }));
  expect(open).toHaveBeenCalledWith('t');
});

it('zoom buttons change the scale and fit resets it', () => {
  setup();
  const scene = screen.getByTestId('sp-graph-scene');
  const before = scene.getAttribute('transform');
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
  expect(scene.getAttribute('transform')).not.toBe(before);
  fireEvent.click(screen.getByRole('button', { name: 'Fit graph' }));
  expect(scene.getAttribute('transform')).toBe(before);
});

it('refuses more than 500 nodes', () => {
  const many = Array.from({ length: 501 }, (_, i) => ({ id: `n${i}`, kind: 'thread', caption: `n${i}` }));
  render(<GraphCanvas label="Big" nodes={many} links={[]} palette={palette} expandedIds={new Set()} onSelect={() => {}} onToggleExpand={() => {}} />);
  expect(screen.getByRole('status').textContent).toMatch(/too many items/i);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/ui && npx vitest run src/graph`
Expected: FAIL, `./index.js` not found.

- [ ] **Step 3: Implement `packages/ui/src/graph/GraphCanvas.tsx`**

```tsx
import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { layoutGraph, linkPath, NODE_RADIUS, type Point } from './layout.js';

export type GraphNode = { id: string; kind: string; caption: string; muted?: boolean };
export type GraphLink = { id: string; source: string; target: string; label: string };
export type GraphMenuItem = { label: string; onClick: () => void };
export type GraphCanvasProps = {
  nodes: GraphNode[]; links: GraphLink[];
  palette: Record<string, string>;
  selectedId?: string; expandedIds: ReadonlySet<string>;
  onSelect(id: string | undefined): void;
  onToggleExpand(id: string): void;
  menu?(id: string): GraphMenuItem[];
  label: string;
};
export const MAX_GRAPH_NODES = 500;
const MIN_SCALE = 0.2, MAX_SCALE = 4;
const cut = (text: string) => text.length > 24 ? `${text.slice(0, 24).trimEnd()}…` : text;
const clamp = (v: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, v));

export function GraphCanvas({ nodes, links, palette, selectedId, expandedIds, onSelect, onToggleExpand, menu, label }: GraphCanvasProps) {
  const positions = useRef(new Map<string, Point>());
  const [pins, setPins] = useState(new Map<string, Point>());
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ id?: string; startX: number; startY: number; origin: Point; moved: boolean } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const tooMany = nodes.length > MAX_GRAPH_NODES;

  const layout = useMemo(() => {
    if (tooMany) return new Map<string, Point>();
    const next = layoutGraph(nodes, links, new Map([...positions.current, ...pins]));
    positions.current = next;
    return next;
  }, [nodes, links, pins, tooMany]);

  const neighbours = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const l of links) { map.set(l.source, [...(map.get(l.source) ?? []), l.target]); map.set(l.target, [...(map.get(l.target) ?? []), l.source]); }
    return map;
  }, [links]);
  const pairs = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const l of links) { const key = [l.source, l.target].sort().join('|'); groups.set(key, [...(groups.get(key) ?? []), l.id]); }
    return groups;
  }, [links]);

  if (tooMany) return <p role="status" className="sp-graph-status">Too many items to draw ({nodes.length}). Hide some threads first.</p>;

  const focusNode = (id: string) => svg.current?.querySelector<SVGGElement>(`[data-node-id="${CSS.escape(id)}"]`)?.focus();
  const onNodeKey = (event: KeyboardEvent<SVGGElement>, id: string) => {
    if (event.key === 'Enter') { event.preventDefault(); onToggleExpand(id); }
    else if (event.key === ' ') { event.preventDefault(); onSelect(id); }
    else if (event.key.startsWith('Arrow')) {
      const list = neighbours.get(id) ?? [];
      if (!list.length) return;
      event.preventDefault();
      focusNode(event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? list.at(-1)! : list[0]!);
    }
  };
  const startDrag = (event: PointerEvent, id?: string) => {
    const origin = id ? layout.get(id)! : { x: view.x, y: view.y };
    drag.current = { id, startX: event.clientX, startY: event.clientY, origin, moved: false };
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };
  const moveDrag = (event: PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = event.clientX - d.startX, dy = event.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    if (d.id) setPins(old => new Map(old).set(d.id!, { x: d.origin.x + dx / view.k, y: d.origin.y + dy / view.k, pinned: true }));
    else setView(v => ({ ...v, x: d.origin.x + dx, y: d.origin.y + dy }));
  };
  const endDrag = () => { const moved = drag.current?.moved; drag.current = null; return moved; };
  const onWheel = (event: WheelEvent) => { event.preventDefault(); setView(v => ({ ...v, k: clamp(v.k * (event.deltaY < 0 ? 1.1 : 1 / 1.1)) })); };
  const selected = selectedId ? layout.get(selectedId) : undefined;
  const items = selectedId && menu ? menu(selectedId) : [];
  const transform = `translate(${view.x},${view.y}) scale(${view.k})`;

  return <div className="sp-graph">
    <div className="sp-graph-toolbar">
      <button type="button" aria-label="Zoom in" onClick={() => setView(v => ({ ...v, k: clamp(v.k * 1.25) }))}>+</button>
      <button type="button" aria-label="Zoom out" onClick={() => setView(v => ({ ...v, k: clamp(v.k / 1.25) }))}>−</button>
      <button type="button" aria-label="Fit graph" onClick={() => setView({ x: 0, y: 0, k: 1 })}>⤢</button>
      <ul className="sp-graph-legend" aria-label="Legend">{Object.entries(palette).map(([kind, color]) =>
        <li key={kind}><span style={{ background: color }} />{kind}</li>)}</ul>
    </div>
    <svg ref={svg} role="application" aria-label={label} className="sp-graph-svg" viewBox="-400 -300 800 600" onWheel={onWheel}
      onPointerMove={moveDrag} onPointerUp={endDrag} onDoubleClick={event => { if (event.target === event.currentTarget || (event.target as Element).dataset.testid === 'sp-graph-background') setPins(new Map()); }}>
      <defs><marker id="sp-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" /></marker></defs>
      <rect data-testid="sp-graph-background" x="-5000" y="-5000" width="10000" height="10000" className="sp-graph-background"
        onPointerDown={event => startDrag(event)} onClick={() => { if (!endDrag()) onSelect(undefined); }} />
      <g data-testid="sp-graph-scene" transform={transform}>
        {links.map(l => {
          const from = layout.get(l.source), to = layout.get(l.target);
          if (!from || !to) return null;
          const group = pairs.get([l.source, l.target].sort().join('|'))!;
          const d = linkPath(from, to, group.indexOf(l.id), group.length);
          return <g key={l.id} className="sp-graph-link">
            <path id={`sp-link-${l.id}`} d={d} markerEnd="url(#sp-graph-arrow)" />
            <text><textPath href={`#sp-link-${l.id}`} startOffset="50%" textAnchor="middle">{l.label}</textPath></text>
          </g>;
        })}
        {nodes.map(n => {
          const p = layout.get(n.id); if (!p) return null;
          const name = `${n.caption}, ${n.kind}${n.muted ? ', ended' : ''}`;
          return <g key={n.id} data-node-id={n.id} role="button" tabIndex={0} aria-label={name} aria-pressed={selectedId === n.id}
            aria-expanded={expandedIds.has(n.id)} transform={`translate(${p.x},${p.y})`}
            className={`sp-graph-node${selectedId === n.id ? ' is-selected' : ''}${n.muted ? ' is-muted' : ''}`}
            onPointerDown={event => { event.stopPropagation(); startDrag(event, n.id); }}
            onClick={event => { event.stopPropagation(); if (!endDrag()) onSelect(n.id); }}
            onDoubleClick={event => { event.stopPropagation(); onToggleExpand(n.id); }}
            onKeyDown={event => onNodeKey(event, n.id)}>
            <circle r={NODE_RADIUS} style={{ fill: n.muted ? 'var(--sp-text-muted)' : palette[n.kind] }} />
            <text y={NODE_RADIUS + 14} textAnchor="middle">{cut(n.caption)}</text>
          </g>;
        })}
      </g>
    </svg>
    {selected && items.length > 0 && <div role="menu" aria-label="Node actions" className="sp-graph-menu"
      style={{ left: `calc(50% + ${(selected.x * view.k + view.x) / 8}%)`, top: `calc(50% + ${(selected.y * view.k + view.y) / 6}%)` }}>
      {items.map(item => <button key={item.label} type="button" role="menuitem" onClick={item.onClick}>{item.label}</button>)}
    </div>}
    <ul className="sp-visually-hidden" aria-label={`${label} items`}>{nodes.map(n => <li key={n.id}>{n.caption} ({n.kind})</li>)}</ul>
  </div>;
}
```

The ring menu uses percentages of the 800 × 600 view box (`/ 8` ≈ `100 / 800`, `/ 6` ≈ `100 / 600`), so it follows the node at any container size.

Before relying on `.sp-visually-hidden`, check it exists: `grep -n "visually-hidden" packages/ui/src/styles/*.css`. If the existing class has another name, use that name.

Create `packages/ui/src/graph/index.ts`:

```typescript
export { GraphCanvas, MAX_GRAPH_NODES } from './GraphCanvas.js';
export type { GraphCanvasProps, GraphLink, GraphMenuItem, GraphNode } from './GraphCanvas.js';
export { layoutGraph, linkPath, NODE_RADIUS } from './layout.js';
```

- [ ] **Step 4: Add styles to `packages/ui/src/styles/workplace.css`**

Append:

```css
.sp-graph { position: relative; display: grid; grid-template-rows: auto 1fr; min-height: 420px; border: 1px solid var(--sp-border); border-radius: var(--sp-radius-md, 8px); background: var(--sp-surface); overflow: hidden; }
.sp-graph-toolbar { display: flex; gap: 6px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--sp-border); }
.sp-graph-toolbar > button { width: 28px; height: 28px; border-radius: 6px; border: 1px solid var(--sp-border); background: transparent; color: inherit; cursor: pointer; }
.sp-graph-legend { display: flex; gap: 10px; margin: 0 0 0 auto; padding: 0; list-style: none; font-size: 12px; color: var(--sp-text-muted); }
.sp-graph-legend span { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 4px; vertical-align: -1px; }
.sp-graph-svg { width: 100%; height: 100%; touch-action: none; user-select: none; }
.sp-graph-background { fill: transparent; cursor: grab; }
.sp-graph-link path { fill: none; stroke: var(--sp-text-muted); stroke-width: 1.5; }
.sp-graph-link text { font-size: 9px; fill: var(--sp-text-muted); letter-spacing: 0.04em; }
#sp-graph-arrow path { fill: var(--sp-text-muted); }
.sp-graph-node { cursor: pointer; outline: none; }
.sp-graph-node circle { stroke: var(--sp-surface); stroke-width: 3; }
.sp-graph-node text { font-size: 11px; fill: var(--sp-text); pointer-events: none; }
.sp-graph-node.is-selected circle, .sp-graph-node:focus-visible circle { stroke: var(--sp-focus, var(--sp-accent)); stroke-width: 4; }
.sp-graph-node.is-muted text { fill: var(--sp-text-muted); }
.sp-graph-menu { position: absolute; transform: translate(-50%, -140%); display: flex; gap: 4px; padding: 4px; border-radius: 999px; background: var(--sp-surface-raised, var(--sp-surface)); box-shadow: 0 4px 16px rgb(0 0 0 / 0.24); }
.sp-graph-menu button { border: 0; border-radius: 999px; padding: 4px 10px; background: transparent; color: inherit; font-size: 12px; cursor: pointer; }
.sp-graph-menu button:hover, .sp-graph-menu button:focus-visible { background: var(--sp-hover, rgb(127 127 127 / 0.16)); }
.sp-graph-status { padding: 16px; color: var(--sp-text-muted); }
@media (prefers-reduced-motion: no-preference) { .sp-graph-node { transition: transform 180ms ease-out; } }
```

Before saving, check each token exists: `grep -oE "\-\-sp-(border|surface|surface-raised|text|text-muted|accent|success|warning|focus|hover|radius-md)\b" packages/ui/src/styles/tokens.css | sort -u`. Replace any missing token with the closest existing one. Animation runs only when the user allows motion. The layout is pre-computed, so with reduced motion nodes appear in place.

- [ ] **Step 5: Run the tests**

Run: `cd packages/ui && npx vitest run src/graph && cd ../.. && pnpm --filter @space/ui build`
Expected: PASS (9 tests) and a clean build.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/graph packages/ui/src/styles/workplace.css
git commit -m "Add GraphCanvas with zoom, drag, keyboard and ring menu"
```

---

### Task 6: Storybook story

**Files:**
- Create: `apps/web/src/gallery/examples/GraphCanvas.stories.tsx`

- [ ] **Step 1: Write the story**

```tsx
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { GraphCanvas, type GraphLink, type GraphNode } from '@space/ui/graph';

const palette = { channel: 'var(--sp-accent)', thread: 'var(--sp-success)', session: 'var(--sp-warning)' };
function Demo({ threads, parallel }: { threads: number; parallel?: boolean }) {
  const [selected, setSelected] = useState<string>();
  const [expanded, setExpanded] = useState(new Set<string>());
  const nodes: GraphNode[] = [{ id: 'c', kind: 'channel', caption: '#payments' }];
  const links: GraphLink[] = [];
  for (let i = 0; i < threads; i++) {
    nodes.push({ id: `t${i}`, kind: 'thread', caption: `Thread ${i} · in progress` });
    links.push({ id: `ct${i}`, source: 'c', target: `t${i}`, label: 'HAS' });
    if (expanded.has(`t${i}`)) for (const agent of ['Codex', 'Claude']) {
      nodes.push({ id: `s${i}${agent}`, kind: 'session', caption: agent, muted: agent === 'Claude' });
      links.push({ id: `ts${i}${agent}`, source: `t${i}`, target: `s${i}${agent}`, label: 'HAS_SESSION' });
    }
  }
  if (parallel) links.push({ id: 'extra', source: 'c', target: 't0', label: 'MENTIONS' });
  return <div style={{ height: 520 }}><GraphCanvas label="Demo graph" nodes={nodes} links={links} palette={palette} selectedId={selected} expandedIds={expanded}
    onSelect={setSelected} onToggleExpand={id => setExpanded(old => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; })}
    menu={id => [{ label: 'Expand', onClick: () => setExpanded(old => new Set(old).add(id)) }, { label: 'Hide', onClick: () => setSelected(undefined) }]} /></div>;
}
const meta = { title: 'Graph/GraphCanvas', component: Demo } satisfies Meta<typeof Demo>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Small: Story = { args: { threads: 3 } };
export const Crowded: Story = { args: { threads: 40 } };
export const ParallelLinks: Story = { args: { threads: 3, parallel: true } };
```

Reduced motion is checked by turning on the OS setting. The CSS transition then stops, and no separate story is needed.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @space/web typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/gallery/examples/GraphCanvas.stories.tsx
git commit -m "Add GraphCanvas stories"
```

---

### Task 7: `MemoryGraph`

**Files:**
- Create: `apps/web/src/features/memory/memory-api.ts`, `MemoryGraph.tsx`, `memory-graph.css`
- Test: `apps/web/src/features/memory/MemoryGraph.test.tsx`

- [ ] **Step 1: Write the API module `memory-api.ts`**

```typescript
import type { ChannelMemoryPage, SessionMemory, MemoryRecord, ThreadMemory } from '@space/contracts';
import { request } from '../../shared/api/request.js';

export type MemoryEdit = { revision: number; summary: string; content: string };
export const memoryApi = {
  layers: (channel: string, after?: string, signal?: AbortSignal) =>
    request<ChannelMemoryPage>(`/channels/${channel}/memory/layers${after ? `?after=${encodeURIComponent(after)}&limit=50` : ''}`, undefined, undefined, 'POST', signal),
  thread: (channel: string, thread: string, signal?: AbortSignal) =>
    request<ThreadMemory>(`/channels/${channel}/threads/${thread}/memory`, undefined, undefined, 'POST', signal),
  session: (channel: string, session: string, signal?: AbortSignal) =>
    request<SessionMemory>(`/channels/${channel}/agent-sessions/${session}/memory`, undefined, undefined, 'POST', signal),
  saveThread: (channel: string, thread: string, edit: MemoryEdit) =>
    request<MemoryRecord>(`/channels/${channel}/threads/${thread}/memory`, edit),
  saveSession: (channel: string, session: string, edit: MemoryEdit) =>
    request<MemoryRecord>(`/channels/${channel}/agent-sessions/${session}/memory`, edit),
};
```

`request` sends `GET` when `body` is undefined (`apps/web/src/shared/api/request.ts:6`), so the `'POST'` argument on reads is only there to reach the `signal` parameter.

- [ ] **Step 2: Write the failing test**

Create `apps/web/src/features/memory/MemoryGraph.test.tsx`:

```tsx
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryGraph } from './MemoryGraph.js';

const updates = new Map<string, { read: () => unknown; revoke?: (code: string) => void }>();
vi.mock('../../shared/realtime/live-updates.js', () => ({
  subscribeUpdates: (scope: string, id: string, read: () => unknown, revoke?: (code: string) => void) => { updates.set(`${scope}:${id}`, { read, revoke }); return () => updates.delete(`${scope}:${id}`); },
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); updates.clear(); });

const ch = '00000000-0000-4000-8000-0000000000c1';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const thread = (n: number, summary = `Thread ${n}`) => ({ ref: { kind: 'thread', id: uuid(n) }, parent: { kind: 'channel', id: ch }, summary, updated_at: '2026-11-11 10:00:00+00', children: { kind: 'session', count: 1 } });
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
function stub(pages: { nodes: unknown[]; next_cursor: string | null }[]) {
  let summary = 'Thread 1';
  const fetch = vi.fn(async (path: string) => {
    if (path.includes('/memory/layers')) return response({ channel_id: ch, ...(path.includes('after=') ? pages[1] : { ...pages[0], nodes: pages[0]!.nodes.map((n: any, i) => i === 0 ? { ...n, summary } : n) }) });
    if (path.includes('/threads/')) return response({ node: thread(1), context: { thread_id: uuid(1), through_sequence: '1', root: null, messages: [], memory: null, has_earlier_messages: false },
      sessions: [{ ref: { kind: 'session', id: uuid(900) }, parent: { kind: 'thread', id: uuid(1) }, summary: 'Run', updated_at: 'x', children: null, title: 'Run', agent: 'Codex', state: 'ended' }], memory_chars: 0, limit: 6000 });
    return response({}, 404);
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, rename: (s: string) => { summary = s; } };
}

it('shows the channel and first page, loads more without duplicates', async () => {
  stub([{ nodes: [thread(1), thread(2)], next_cursor: 'c1' }, { nodes: [thread(3)], next_cursor: null }]);
  render(<MemoryGraph channel={ch} name="payments" onSelect={() => {}} onAccessLost={() => {}} />);
  await screen.findByRole('button', { name: '#payments, channel' });
  expect(screen.getAllByRole('button', { name: /, thread$/ })).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Load more threads' }));
  await waitFor(() => expect(screen.getAllByRole('button', { name: /, thread$/ })).toHaveLength(3));
  expect(screen.queryByRole('button', { name: 'Load more threads' })).toBeNull();
});

it('expands a thread into sessions, collapses it, and keeps expansion across live refresh', async () => {
  const { rename } = stub([{ nodes: [thread(1)], next_cursor: null }, { nodes: [], next_cursor: null }]);
  render(<MemoryGraph channel={ch} name="payments" onSelect={() => {}} onAccessLost={() => {}} />);
  const node = await screen.findByRole('button', { name: 'Thread 1, thread' });
  fireEvent.doubleClick(node);
  await screen.findByRole('button', { name: 'Codex, session, ended' });
  rename('Renamed');
  await act(async () => { await updates.get(`channel:${ch}`)!.read(); });
  await screen.findByRole('button', { name: 'Renamed, thread' });
  expect(screen.getByRole('button', { name: 'Codex, session, ended' })).toBeTruthy();
  fireEvent.doubleClick(screen.getByRole('button', { name: 'Renamed, thread' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Codex, session, ended' })).toBeNull());
});

it('reports lost access when the live subscription is revoked', async () => {
  stub([{ nodes: [], next_cursor: null }, { nodes: [], next_cursor: null }]);
  const lost = vi.fn();
  render(<MemoryGraph channel={ch} name="payments" onSelect={() => {}} onAccessLost={lost} />);
  await screen.findByRole('button', { name: '#payments, channel' });
  act(() => updates.get(`channel:${ch}`)!.revoke!('not_found'));
  expect(lost).toHaveBeenCalled();
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd apps/web && npx vitest run src/features/memory/MemoryGraph.test.tsx`
Expected: FAIL, `./MemoryGraph.js` not found.

- [ ] **Step 4: Implement `MemoryGraph.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@space/ui/primitives';
import { GraphCanvas, type GraphLink, type GraphNode } from '@space/ui/graph';
import type { MemoryNode, ThreadMemory } from '@space/contracts';
import { subscribeUpdates } from '../../shared/realtime/live-updates.js';
import { memoryApi } from './memory-api.js';

export type MemorySelection = { kind: 'channel' } | { kind: 'thread'; node: MemoryNode } | { kind: 'session'; node: MemoryNode; threadId: string };
type Props = {
  channel: string; name: string;
  onSelect(selection: MemorySelection | undefined): void;
  onAccessLost(): void;
  onOpenThread?(threadId: string): void;
  onOpenSession?(threadId: string, sessionId: string): void;
};
const palette = { channel: 'var(--sp-accent)', thread: 'var(--sp-success)', session: 'var(--sp-warning)' };
const key = (kind: string, id: string) => `${kind}:${id}`;

export function MemoryGraph({ channel, name, onSelect, onAccessLost, onOpenThread, onOpenSession }: Props) {
  const [threads, setThreads] = useState<MemoryNode[]>([]);
  const [pages, setPages] = useState(1), [cursor, setCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(new Map<string, ThreadMemory>());
  const [hidden, setHidden] = useState(new Set<string>());
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState(''), [loaded, setLoaded] = useState(false), [more, setMore] = useState(false);
  const generation = useRef(0), state = useRef({ pages, expanded });
  state.current = { pages, expanded };
  const lost = useRef(onAccessLost); lost.current = onAccessLost;

  // A refresh re-reads from the start (cursors are snapshots), the same number of pages, and every expanded thread.
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    try {
      let after: string | undefined, next: string | null = null;
      const all: MemoryNode[] = [];
      for (let page = 0; page < state.current.pages; page++) {
        const result = await memoryApi.layers(channel, after);
        all.push(...result.nodes); next = result.next_cursor;
        if (!next) break;
        after = next;
      }
      const reloaded = new Map<string, ThreadMemory>();
      for (const id of state.current.expanded.keys()) reloaded.set(id, await memoryApi.thread(channel, id));
      if (version !== generation.current) return;
      setThreads(all); setCursor(next); setExpanded(reloaded); setError(''); setLoaded(true);
    } catch (reason) {
      if (version !== generation.current) return;
      const code = reason instanceof Error ? reason.message : 'memory_unavailable';
      if (code === 'not_found' || code === 'unauthorized') lost.current();
      else setError(code.replaceAll('_', ' '));
      setLoaded(true);
    }
  }, [channel]);

  useEffect(() => {
    void refresh();
    const stop = subscribeUpdates('channel', channel, refresh, () => lost.current());
    return () => { generation.current++; stop(); };
  }, [channel, refresh]);

  async function loadMore() {
    if (!cursor || more) return;
    setMore(true);
    try {
      const result = await memoryApi.layers(channel, cursor);
      setThreads(old => { const seen = new Set(old.map(n => n.ref.id)); return [...old, ...result.nodes.filter(n => !seen.has(n.ref.id))]; });
      setCursor(result.next_cursor); setPages(p => p + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message.replaceAll('_', ' ') : 'Could not load more'); }
    finally { setMore(false); }
  }
  async function toggle(id: string) {
    const [kind, ref] = id.split(':') as [string, string];
    if (kind !== 'thread') return;
    if (expanded.has(ref)) { setExpanded(old => { const next = new Map(old); next.delete(ref); return next; }); return; }
    try {
      const detail = await memoryApi.thread(channel, ref);
      setExpanded(old => new Map(old).set(ref, detail));
    } catch (reason) { setError(reason instanceof Error ? reason.message.replaceAll('_', ' ') : 'Could not expand'); }
  }

  const { nodes, links, lookup } = useMemo(() => {
    const nodes: GraphNode[] = [{ id: key('channel', channel), kind: 'channel', caption: `#${name}` }];
    const links: GraphLink[] = [];
    const lookup = new Map<string, MemorySelection>([[key('channel', channel), { kind: 'channel' }]]);
    for (const t of threads) {
      const id = key('thread', t.ref.id);
      if (hidden.has(id)) continue;
      nodes.push({ id, kind: 'thread', caption: t.summary || 'Untitled thread' });
      links.push({ id: `has:${t.ref.id}`, source: key('channel', channel), target: id, label: 'HAS' });
      lookup.set(id, { kind: 'thread', node: t });
      for (const s of expanded.get(t.ref.id)?.sessions ?? []) {
        const sid = key('session', s.ref.id);
        if (hidden.has(sid)) continue;
        nodes.push({ id: sid, kind: 'session', caption: s.agent ?? s.title ?? 'Agent', muted: s.state === 'ended' });
        links.push({ id: `session:${s.ref.id}`, source: id, target: sid, label: 'HAS_SESSION' });
        lookup.set(sid, { kind: 'session', node: s, threadId: t.ref.id });
      }
    }
    return { nodes, links, lookup };
  }, [channel, name, threads, expanded, hidden]);

  const select = (id: string | undefined) => { setSelected(id); onSelect(id ? lookup.get(id) : undefined); };
  const menu = (id: string) => {
    const item = lookup.get(id);
    if (!item || item.kind === 'channel') return [];
    const hide = { label: 'Hide', onClick: () => { setHidden(old => new Set(old).add(id)); select(undefined); } };
    if (item.kind === 'thread') return [
      { label: expanded.has(item.node.ref.id) ? 'Collapse' : 'Expand', onClick: () => void toggle(id) },
      ...(onOpenThread ? [{ label: 'Open thread', onClick: () => onOpenThread(item.node.ref.id) }] : []), hide];
    return [...(onOpenSession ? [{ label: 'Open session', onClick: () => onOpenSession(item.threadId, item.node.ref.id) }] : []), hide];
  };

  return <div className="memory-graph">
    {error && <p role="alert">{error} <Button size="sm" onClick={() => void refresh()}>Retry</Button></p>}
    {!loaded && <p role="status">Loading memory graph…</p>}
    {loaded && <GraphCanvas label={`Memory graph for #${name}`} nodes={nodes} links={links} palette={palette}
      selectedId={selected} expandedIds={new Set([...expanded.keys()].map(id => key('thread', id)))}
      onSelect={select} onToggleExpand={id => void toggle(id)} menu={menu} />}
    {loaded && !threads.length && !error && <p className="memory-graph-empty">No thread has a memory in the last 7 days.</p>}
    {cursor && <Button size="sm" loading={more} onClick={() => void loadMore()}>Load more threads</Button>}
    {hidden.size > 0 && <Button size="sm" variant="ghost" onClick={() => setHidden(new Set())}>Show hidden ({hidden.size})</Button>}
  </div>;
}
```

Check `Button` accepts `loading` and `variant="ghost"`: `grep -n "loading\|variant" packages/ui/src/primitives/primitives.tsx | head`. Both are used elsewhere in the app (`apps/web/src/features/workspace/collections/WorkspaceDestinations.tsx`), so they should exist.

Create `apps/web/src/features/memory/memory-graph.css`:

```css
.memory-graph-view { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 12px; min-height: 480px; }
.memory-graph { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.memory-graph .sp-graph { flex: 1; }
.memory-graph-empty { color: var(--sp-text-muted); font-size: 13px; }
.memory-inspector { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--sp-border); border-radius: 8px; overflow: auto; }
.memory-inspector h3 { margin: 0; font-size: 15px; }
.memory-inspector pre { white-space: pre-wrap; word-break: break-word; margin: 0; padding: 8px; max-height: 260px; overflow: auto; font-size: 12px; border-radius: 6px; background: var(--sp-surface-sunken, rgb(127 127 127 / 0.08)); }
.memory-inspector meter { width: 100%; }
.memory-inspector form { display: flex; flex-direction: column; gap: 8px; }
.memory-inspector textarea { min-height: 160px; font: inherit; font-size: 12px; }
@media (max-width: 900px) { .memory-graph-view { grid-template-columns: 1fr; } }
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @space/ui build && cd apps/web && npx vitest run src/features/memory/MemoryGraph.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/memory/memory-api.ts apps/web/src/features/memory/MemoryGraph.tsx apps/web/src/features/memory/memory-graph.css apps/web/src/features/memory/MemoryGraph.test.tsx
git commit -m "Add memory graph with paging, expand and live refresh"
```

---

### Task 8: `MemoryInspector` and the dialog views

**Files:**
- Create: `apps/web/src/features/memory/MemoryInspector.tsx`
- Test: `apps/web/src/features/memory/MemoryInspector.test.tsx`
- Modify: `apps/web/src/features/memory/ChannelMemory.tsx`, `apps/web/src/features/chat/ChannelRoom.tsx:455`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/features/memory/MemoryInspector.test.tsx`:

```tsx
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryInspector } from './MemoryInspector.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const ch = '00000000-0000-4000-8000-0000000000c1', th = '00000000-0000-4000-8000-000000000001';
const node = { ref: { kind: 'thread' as const, id: th }, parent: { kind: 'channel' as const, id: ch }, summary: 'Dedupe fix', updated_at: '2026-11-11 10:00:00+00', children: { kind: 'session' as const, count: 0 } };
const memory = (revision: number, content: string) => ({ revision, through_sequence: '3', content, summary: `Rev ${revision}`, source_message_ids: ['00000000-0000-4000-8000-000000000009'], producer_id: 'x', producer_name: 'Codex', created_at: '2026-11-11 10:00:00+00' });
const detail = (revision: number, content: string) => ({ node: { ...node, summary: `Rev ${revision}` }, context: { thread_id: th, through_sequence: '3', root: null, messages: [], memory: memory(revision, content), has_earlier_messages: false }, sessions: [], memory_chars: content.length, limit: 6000 });
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

it('members see the memory but no Edit', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(detail(3, '# Decisions\nDedupe'))));
  render(<MemoryInspector channel={ch} selection={{ kind: 'thread', node }} canManage={false} onDirtyChange={() => {}} />);
  expect(await screen.findByText(/Dedupe$/)).toBeTruthy();
  expect(screen.getByText(/rev 3 · Codex/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
});

it('a manager saves, and on 409 keeps the draft and shows the newer text', async () => {
  let reads = 0, saves = 0;
  vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method === 'POST') return ++saves === 1 ? response({ error: 'thread_memory_conflict' }, 409) : response(memory(5, 'mine'));
    return response(++reads === 1 ? detail(3, 'old') : detail(4, 'someone else'));
  }));
  const dirty = vi.fn();
  render(<MemoryInspector channel={ch} selection={{ kind: 'thread', node }} canManage onDirtyChange={dirty} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Memory' }), { target: { value: 'mine' } });
  expect(dirty).toHaveBeenLastCalledWith(true);
  await userEvent.click(screen.getByRole('button', { name: 'Save memory' }));
  expect(await screen.findByText(/changed while you were editing/i)).toBeTruthy();
  expect((screen.getByRole('textbox', { name: 'Memory' }) as HTMLTextAreaElement).value).toBe('mine');
  expect(screen.getByText('someone else')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Save memory' }));
  const body = JSON.parse((vi.mocked(fetch).mock.calls.filter(([, i]) => i?.method === 'POST').at(-1)![1]!.body) as string);
  expect(body.revision).toBe(4);
  expect(await screen.findByRole('status')).toBeTruthy();
  expect(dirty).toHaveBeenLastCalledWith(false);
});

it('ended sessions show no Edit', async () => {
  const session = { ref: { kind: 'session' as const, id: '00000000-0000-4000-8000-000000000900' }, parent: { kind: 'thread' as const, id: th }, summary: 'Run', updated_at: 'x', children: null, title: 'Run', agent: 'Codex', state: 'ended' as const };
  vi.stubGlobal('fetch', vi.fn(async () => response({ node: session, memory: null, messages: [], memory_chars: 0, limit: 6000 })));
  render(<MemoryInspector channel={ch} selection={{ kind: 'session', node: session, threadId: th }} canManage onDirtyChange={() => {}} />);
  await screen.findByText(/ended/);
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
});
```

Before running, check what `request` throws on a JSON error body: `sed -n 1,30p apps/web/src/shared/api/request.ts`. The tests assume it throws `Error(body.error)` for `{ error: '…' }` responses. If it reads another field, change the stubbed body to match.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/web && npx vitest run src/features/memory/MemoryInspector.test.tsx`
Expected: FAIL, `./MemoryInspector.js` not found.

- [ ] **Step 3: Implement `MemoryInspector.tsx`**

```tsx
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@space/ui/primitives';
import type { SessionMemory, MemoryRecord, ThreadMemory } from '@space/contracts';
import { memoryApi } from './memory-api.js';
import type { MemorySelection } from './MemoryGraph.js';

type Props = {
  channel: string; selection: MemorySelection | undefined; canManage: boolean;
  onDirtyChange(dirty: boolean): void;
  onOpenThread?(threadId: string): void;
  onOpenSession?(threadId: string, sessionId: string): void;
};
type Detail = { memory: MemoryRecord | null; chars: number; ended: boolean };
const toDetail = (data: ThreadMemory | SessionMemory): Detail => 'context' in data
  ? { memory: data.context.memory, chars: data.memory_chars, ended: false }
  : { memory: data.memory, chars: data.memory_chars, ended: data.node.state === 'ended' };

export function MemoryInspector(props: Props) {
  const { selection } = props;
  if (!selection) return <aside className="memory-inspector" aria-label="Memory details"><p>Select a node to see its memory.</p></aside>;
  if (selection.kind === 'channel') return <aside className="memory-inspector" aria-label="Memory details"><h3>Channel</h3><p>Double-click a thread to see its agent sessions.</p></aside>;
  return <NodeInspector key={`${selection.kind}:${selection.node.ref.id}`} {...props} selection={selection} />;
}

function NodeInspector({ channel, selection, canManage, onDirtyChange, onOpenThread, onOpenSession }: Props & { selection: Exclude<MemorySelection, { kind: 'channel' }> }) {
  const [detail, setDetail] = useState<Detail>(), [error, setError] = useState('');
  const [editing, setEditing] = useState(false), [summary, setSummary] = useState(''), [content, setContent] = useState('');
  const [base, setBase] = useState(0), [newer, setNewer] = useState<MemoryRecord | null>(), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const dirtyChange = useRef(onDirtyChange); dirtyChange.current = onDirtyChange;
  const id = selection.node.ref.id;
  const read = (signal?: AbortSignal) => selection.kind === 'thread' ? memoryApi.thread(channel, id, signal) : memoryApi.session(channel, id, signal);

  useEffect(() => {
    const controller = new AbortController();
    read(controller.signal).then(data => { if (!controller.signal.aborted) setDetail(toDetail(data)); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message.replaceAll('_', ' ') : 'Could not load memory'); });
    return () => { controller.abort(); dirtyChange.current(false); };
  }, [channel, id, selection.kind]);

  const dirty = editing && (summary !== (detail?.memory?.summary ?? '') || content !== (detail?.memory?.content ?? ''));
  useEffect(() => { dirtyChange.current(dirty); }, [dirty]);

  function startEdit() {
    setSummary(detail?.memory?.summary ?? selection.node.summary); setContent(detail?.memory?.content ?? '');
    setBase(detail?.memory?.revision ?? 0); setNewer(undefined); setNotice(''); setEditing(true);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    const edit = { revision: base, summary, content };
    try {
      const saved = selection.kind === 'thread' ? await memoryApi.saveThread(channel, id, edit) : await memoryApi.saveSession(channel, id, edit);
      setDetail(old => ({ memory: saved, chars: saved.content.length, ended: old?.ended ?? false }));
      setEditing(false); setNewer(undefined); setNotice(`Saved as revision ${saved.revision}.`);
    } catch (reason) {
      const code = reason instanceof Error ? reason.message : '';
      if (code.endsWith('_memory_conflict')) {
        const latest = toDetail(await read());
        setNewer(latest.memory); setBase(latest.memory?.revision ?? 0); setDetail(old => ({ ...latest, ended: old?.ended ?? latest.ended }));
        setError('This memory changed while you were editing. Your draft is kept. Compare with the newer text, then save again.');
      } else setError(code.replaceAll('_', ' ') || 'Could not save');
    } finally { setBusy(false); }
  }

  const cp = detail?.memory;
  const title = selection.kind === 'thread' ? selection.node.summary : `${selection.node.agent ?? 'Agent'} · ${selection.node.title ?? ''}`;
  return <aside className="memory-inspector" aria-label="Memory details">
    <h3>{title}</h3>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!detail && !error && <p role="status">Loading…</p>}
    {detail && <>
      <small>{selection.kind}{detail.ended ? ' · ended' : ''}{cp ? ` · rev ${cp.revision} · ${cp.producer_name} · ${cp.created_at}` : ' · no memory yet'}</small>
      <label>Size <meter min={0} max={6000} value={detail.chars} /> {detail.chars} / 6000</label>
      {!editing && cp && <details open><summary>Memory</summary><pre>{cp.content}</pre></details>}
      {!editing && cp && <details><summary>Sources ({cp.source_message_ids.length})</summary><ul>{cp.source_message_ids.map(m => <li key={m}><code>{m}</code></li>)}</ul></details>}
      {canManage && !detail.ended && !editing && <Button size="sm" onClick={startEdit}>Edit</Button>}
      {editing && <form onSubmit={event => void save(event)}>
        <label>Summary<input aria-label="Summary" value={summary} maxLength={280} required onChange={e => setSummary(e.target.value)} /> <small>{summary.length} / 280</small></label>
        <label>Memory<textarea aria-label="Memory" value={content} maxLength={6000} required onChange={e => setContent(e.target.value)} /> <small>{content.length} / 6000</small></label>
        {newer && <details open><summary>Newer version (rev {newer.revision})</summary><pre>{newer.content}</pre></details>}
        <div><Button type="submit" size="sm" loading={busy} disabled={!summary.trim() || !content.trim()}>Save memory</Button>{' '}
          <Button type="button" size="sm" variant="ghost" onClick={() => { if (!dirty || window.confirm('Discard your memory edits?')) { setEditing(false); setError(''); setNewer(undefined); } }}>Cancel</Button></div>
      </form>}
      {selection.kind === 'thread' && onOpenThread && <Button size="sm" variant="ghost" onClick={() => onOpenThread(id)}>Open thread →</Button>}
      {selection.kind === 'session' && onOpenSession && <Button size="sm" variant="ghost" onClick={() => onOpenSession(selection.threadId, id)}>Open session →</Button>}
    </>}
  </aside>;
}
```

Sources are listed as IDs. The panel shows memory text in `<pre>` as plain text, which follows the spec's no-HTML rule.

- [ ] **Step 4: Run the inspector tests**

Run: `cd apps/web && npx vitest run src/features/memory/MemoryInspector.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Add Graph and Notes views to `ChannelMemory.tsx`**

1. Extend `Props` and the imports:

```tsx
import { Select, Badge, Button, Dialog, Tabs, toast } from '@space/ui/primitives';
import { MemoryGraph, type MemorySelection } from './MemoryGraph.js';
import { MemoryInspector } from './MemoryInspector.js';
import './memory-graph.css';

type Props = { channel: string; name: string; open: boolean; message?: { id: string; text: string }; onClose: () => void;
  onOpenThread?: (threadId: string) => void; onOpenSession?: (threadId: string, sessionId: string) => void };
```

2. In `MemoryDialog`, destructure the new props, and add state next to the existing `useState` lines:

```tsx
  const [view, setView] = useState<'graph' | 'notes'>(message ? 'notes' : 'graph');
  const [selection, setSelection] = useState<MemorySelection>(), [graphDirty, setGraphDirty] = useState(false);
```

A dialog opened to save a message starts on Notes, because saving a message is a Notes action.

3. Combine dirty states. In the `Dialog` props, change `if (dirty)` to `if (dirty || graphDirty)`, and `onBeforeClose={() => !dirty || …}` to `onBeforeClose={() => !(dirty || graphDirty) || window.confirm('Discard your unsaved memory edits?')}`.

4. Directly inside `<Dialog …>`, before `<div className="channel-memory">`, add:

```tsx
    <Tabs label="Memory views" value={view} onChange={id => setView(id as 'graph' | 'notes')} items={[
      { id: 'graph', label: 'Graph', panelId: `memory-${channel}-graph` },
      { id: 'notes', label: 'Notes', panelId: `memory-${channel}-notes` },
    ]} />
    {view === 'graph' && <div id={`memory-${channel}-graph`} role="tabpanel" aria-label="Graph" className="memory-graph-view">
      <MemoryGraph channel={channel} name={name} onSelect={setSelection} onAccessLost={onClose}
        onOpenThread={onOpenThread && (id => { onClose(); onOpenThread(id); })}
        onOpenSession={onOpenSession && ((thread, session) => { onClose(); onOpenSession(thread, session); })} />
      <MemoryInspector channel={channel} selection={selection} canManage={!!data?.can_manage} onDirtyChange={setGraphDirty}
        onOpenThread={onOpenThread && (id => { onClose(); onOpenThread(id); })}
        onOpenSession={onOpenSession && ((thread, session) => { onClose(); onOpenSession(thread, session); })} />
    </div>}
```

5. Wrap the existing `<div className="channel-memory">…</div>` so it only shows on Notes:

```tsx
    {view === 'notes' && <div id={`memory-${channel}-notes`} role="tabpanel" aria-label="Notes">
      <div className="channel-memory">
        {/* existing content unchanged */}
      </div>
    </div>}
```

`data?.can_manage` comes from the existing `GET /channels/:id/memory` that the dialog already loads, which works while notes are off. Check the `TabItem` shape with `grep -n "type TabItem" -A3 packages/ui/src/primitives/primitives.tsx` and match `panelId`.

6. In `apps/web/src/features/chat/ChannelRoom.tsx` line 455, add the callbacks:

```tsx
<ChannelMemory channel={channel.id} name={channel.name} open={memoryOpen} message={memoryMessage}
  onClose={() => { setMemoryOpen(false); setMemoryMessage(undefined); }}
  onOpenThread={id => openThread(id)} onOpenSession={(thread, session) => openSessions(thread, session)} />
```

- [ ] **Step 6: Keep the existing notes tests working**

The existing `ChannelMemory.test.tsx` tests drive the Notes view. At the top of that file, add:

```tsx
vi.mock('./MemoryGraph.js', () => ({ MemoryGraph: () => null }));
vi.mock('./MemoryInspector.js', () => ({ MemoryInspector: () => null }));
```

Then, in each test that renders `ChannelMemory` without `message`, add this line after `render(...)`:

```tsx
  await userEvent.click(await screen.findByRole('tab', { name: 'Notes' }));
```

Find them with `grep -n "render(<ChannelMemory" apps/web/src/features/memory/ChannelMemory.test.tsx`. Tests that pass `message` already open on Notes.

Add one test to `ChannelMemory.test.tsx`:

```tsx
it('opens on the graph view by default and switches to notes', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(state(true))));
  render(<ChannelMemory channel="first" name="general" open onClose={() => {}} />);
  expect(await screen.findByRole('tab', { name: 'Graph' })).toHaveProperty('ariaSelected', 'true');
  await userEvent.click(screen.getByRole('tab', { name: 'Notes' }));
  expect(await screen.findByRole('tabpanel', { name: 'Notes' })).toBeTruthy();
});
```

If `Tabs` renders `aria-selected` on another element than `role="tab"`, check it with `grep -n "aria-selected" packages/ui/src/primitives/primitives.tsx` and assert with `getAttribute('aria-selected')` instead.

- [ ] **Step 7: Run all memory and chat tests**

Run: `pnpm --filter @space/ui build && cd apps/web && npx vitest run src/features/memory src/app/Chat.test.tsx`
Expected: PASS for all tests.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/features/memory apps/web/src/features/chat/ChannelRoom.tsx
git commit -m "Show the memory graph with details and manager edits in the Memory dialog"
```

---

### Task 9: Docs and full verification

**Files:**
- Modify: `docs/superpowers/specs/2026-11-11-memory-graph-ui-design.md`
- Modify: `docs/architecture/thread-working-memory.md`

- [ ] **Step 1: Record the dependency change in the spec**

In the Goal section, replace "The layout uses `d3-force`, `d3-zoom`, `d3-drag` and `d3-selection` (ISC)." with:

```markdown
The layout uses `d3-force` (ISC), computed synchronously before paint. React draws the SVG and handles zoom and drag, so no other d3 module is needed.
```

- [ ] **Step 2: Add a short section to `docs/architecture/thread-working-memory.md`** after "Layered memory":

```markdown
### Memory graph

The channel Memory dialog opens on a **Graph** view: channel → `HAS` → thread → `HAS_SESSION` → session. Click a node for details. Double-click a thread to show or hide its sessions. Channel managers can edit a thread or session memory. A save is a normal revision, so a stale save returns `409` and keeps the draft. Routes: `GET /v1/channels/:channelId/memory/layers`, `GET|POST /v1/channels/:channelId/threads/:threadId/memory`, `GET|POST /v1/channels/:channelId/agent-sessions/:sessionId/memory`. Migration `087_memory_updates.sql` sends a channel live update on every memory insert.
```

- [ ] **Step 3: Typecheck and build**

Run: `pnpm typecheck && pnpm build`
Expected: both exit 0.

- [ ] **Step 4: Run the affected suites**

Run:
```bash
cd packages/ui && npx vitest run && cd ../../apps/web && npx vitest run && cd ../../tests && env TEST_DATABASE_URL=postgres://workplace:local_demo_only@127.0.0.1:55438/workplace_test NATS_URL=nats://127.0.0.1:54333 npx tsx --test --test-concurrency=2 integration/memory-graph.test.ts integration/layered-memory.test.ts integration/memory-mcp.test.ts integration/agent-memory.test.ts
```
Expected: all pass. If the web suite fails only in files you didn't touch, run it in a clean worktree of `HEAD` (as in the previous memory build) to rule out unrelated local changes.

- [ ] **Step 5: Confirm no new locks or timers**

Run: `git diff --stat b0b7c4f..HEAD -- adapters apps packages | tail -1; git diff b0b7c4f..HEAD -- adapters apps packages | grep -nE "^\+.*(FOR UPDATE|FOR SHARE|SKIP LOCKED|pg_advisory|setInterval)"`
Expected: the second command prints nothing.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-11-11-memory-graph-ui-design.md docs/architecture/thread-working-memory.md
git commit -m "Document the memory graph"
```

---

## Spec coverage

| Spec requirement | Task |
| --- | --- |
| Graph and Notes views in the Memory dialog, Graph default | 8 |
| Neo4j-style look with our own code, d3-force only | 4, 5, 9 |
| `GraphCanvas` contract: nodes, links, palette, select, expand, menu, label | 5 |
| Layout: forces, velocity decay 0.4, alpha min 0.05, 300 ticks, new nodes by parent, drag pins, double-click background unpins | 4, 5 |
| Curved parallel links, 24-character captions | 4, 5 |
| Zoom 0.2–4, buttons, fit | 5 |
| Ring menu: Expand/Collapse, Open, Hide | 5, 7 |
| Accessibility: application role, focusable nodes, arrow keys, Enter, Space, mirrored list | 5 |
| Reduced motion | 5 (CSS transition only when motion is allowed) |
| 500-node limit | 5 |
| 4 node kinds and colours, `HAS` / `HAS_SESSION` | 7 |
| 20 first, 50 per load more, 50 sessions | 3 (server limits), 7 |
| Details panel: meta, memory, sources, size bar, open actions | 8 |
| Manager-only edit, `409` keeps draft and shows newer text, dirty close asks, ended sessions not editable | 2, 3, 8 |
| 5 routes with membership, manager and session access rules and error codes | 3 |
| Migration 087 trigger and channel live refresh that keeps expansion | 1, 7 |
| Tests and Storybook | 1–8, 6 |
