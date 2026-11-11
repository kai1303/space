# Layered Short-Term Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agents three walkable short-term memory layers (channel → thread → session) as specified in `docs/superpowers/specs/2026-11-11-short-term-memory-design.md`.

**Architecture:** One checkpoint table (`thread_checkpoints`) stores thread and session checkpoints with a required `summary`. Writes use an optimistic insert protected by partial unique indexes, replacing the existing `SELECT … FOR UPDATE`. The channel layer is a bounded keyset query over thread summaries and has no table of its own. New MCP tools on channel keys, plus new task-context fields, expose the layers.

**Tech Stack:** TypeScript, PostgreSQL, drizzle `sql` templates, Fastify, `@modelcontextprotocol/server` 2.4, zod v4, `node:test` with `tsx`.

**Run tests with:** `TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:5432/workplace_test` (the CI value from `.github/workflows/ci.yaml`). Build the workspace packages that tests import first: `pnpm --filter @space/contracts --filter @space/postgres --filter @space/server build`.

---

## File map

| File | Responsibility |
| --- | --- |
| Create `adapters/postgres/migrations/085_layered_memory.sql` | Schema: `session_id`, `channel_id`, `summary`, partial unique indexes |
| Modify `adapters/postgres/migrate.ts` | Register migration 085 |
| Modify `packages/contracts/thread-context.ts` | `summary` on checkpoints, 413/400 codes |
| Create `packages/contracts/layered-memory.ts` | Node, page, thread and session memory types, cursor codec |
| Modify `packages/contracts/index.ts` | Export new module, extend `InvocationRequest.context` |
| Modify `packages/contracts/foundation.ts` | Parse new context fields |
| Modify `adapters/postgres/thread-context.ts` | Optimistic thread checkpoint write, thread-only reads, session filter |
| Create `adapters/postgres/layered-memory.ts` | `readChannelMemory`, `readThreadMemory`, `readSessionMemory`, `writeSessionCheckpoint` |
| Modify `adapters/postgres/package.json` | Export `./layered-memory` |
| Modify `apps/server/memory-mcp.ts` | Register four tools on channel keys, require `summary` on `thread_checkpoint` |
| Modify `adapters/postgres/store.ts` | Task context: `agent_session_memory`, `channel_memory`, `channel_notes` |
| Create `tests/contracts/layered-memory.test.ts` | Contract parsing tests |
| Create `tests/integration/layered-memory.test.ts` | Database and MCP tests |
| Modify `tests/integration/memory-mcp.test.ts`, `tests/integration/agent-memory.test.ts`, `tests/integration/connected-agent-access.test.ts` | Add `summary`, rename `channel_memory` to `channel_notes` |
| Modify `docs/architecture/thread-working-memory.md`, `docs/architecture/memory-mcp.md` | Operator docs |

**Rollout note:** `parseInvocation` rejects unknown context keys. Paired connectors must be updated before (or together with) the server that sends `agent_session_memory`, `channel_memory` (new shape) and `channel_notes`. Ship server and connector in one release.

---

### Task 1: Migration 085

**Files:**
- Create: `adapters/postgres/migrations/085_layered_memory.sql`
- Modify: `adapters/postgres/migrate.ts:22`
- Test: `tests/integration/layered-memory.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/layered-memory.test.ts`:

```typescript
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
const schema = `layered_memory_${randomBytes(6).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const directory = await mkdtemp(join(tmpdir(), 'space-layered-memory-'));
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true, memory: { directory } });
let address: string;
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); address = await app.listen({ host: '127.0.0.1', port: 0 }); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(directory, { recursive: true, force: true }); });

async function api(token: string, method: 'GET' | 'POST', path: string, payload?: object, expected = 200) {
  const response = await app.inject({ method, url: `/v1${path}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  assert.equal(response.statusCode, expected, response.body); return response.json();
}
async function post(token: string, channel: string, text: string, thread?: string) {
  return api(token, 'POST', `/channels/${channel}/messages`, { client_message_id: randomUUID(), text, ...(thread ? { thread_id: thread } : {}) }, 201);
}
async function connect(token: string) {
  const client = new Client({ name: 'layered-memory-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp/memory`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
function data(result: any) { assert.notEqual(result.isError, true, JSON.stringify(result)); return JSON.parse(result.content[0].text); }
function code(result: any) { assert.equal(result.isError, true, JSON.stringify(result)); return result.content[0].text as string; }

test('migration backfills summary and channel_id and allows session rows', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Start');
  const columns = (await pool.query(`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='thread_checkpoints'`, [schema])).rows;
  const byName = Object.fromEntries(columns.map(c => [c.column_name, c.is_nullable]));
  assert.equal(byName.summary, 'NO');
  assert.equal(byName.channel_id, 'NO');
  assert.equal(byName.session_id, 'YES');
  await pool.query(`INSERT INTO thread_checkpoints(thread_id,channel_id,revision,through_sequence,content,summary,source_message_ids,producer_id,producer_name)
    VALUES($1,$2,1,$3,'# A\nB','A',ARRAY[$4]::uuid[],$5,'x')`, [root.thread_id, a.channel_id, root.sequence, root.id, a.owner_id]);
  await assert.rejects(pool.query(`INSERT INTO thread_checkpoints(thread_id,channel_id,revision,through_sequence,content,summary,source_message_ids,producer_id,producer_name)
    VALUES($1,$2,1,$3,'dup','dup',ARRAY[$4]::uuid[],$5,'x')`, [root.thread_id, a.channel_id, root.sequence, root.id, a.owner_id]), /duplicate key/);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd tests && npx tsx --test integration/layered-memory.test.ts`
Expected: FAIL. `byName.summary` is `undefined`.

- [ ] **Step 3: Write the migration**

Create `adapters/postgres/migrations/085_layered_memory.sql`:

```sql
-- Layered short-term memory: thread and session checkpoints share one table.
ALTER TABLE thread_checkpoints ADD COLUMN session_id uuid REFERENCES agent_sessions(id) ON DELETE CASCADE;
ALTER TABLE thread_checkpoints ADD COLUMN channel_id uuid REFERENCES channels(id) ON DELETE CASCADE;
ALTER TABLE thread_checkpoints ADD COLUMN summary text;
UPDATE thread_checkpoints cp SET channel_id = t.channel_id FROM threads t WHERE t.id = cp.thread_id;
UPDATE thread_checkpoints SET summary = left(btrim(split_part(btrim(content), E'\n\n', 1)), 280);
ALTER TABLE thread_checkpoints ALTER COLUMN channel_id SET NOT NULL;
ALTER TABLE thread_checkpoints ALTER COLUMN summary SET NOT NULL;
ALTER TABLE thread_checkpoints ADD CONSTRAINT thread_checkpoints_summary CHECK (length(btrim(summary)) BETWEEN 1 AND 280);
ALTER TABLE thread_checkpoints DROP CONSTRAINT thread_checkpoints_pkey;
CREATE UNIQUE INDEX thread_checkpoints_thread_revision ON thread_checkpoints(thread_id, revision) WHERE session_id IS NULL;
CREATE UNIQUE INDEX thread_checkpoints_session_revision ON thread_checkpoints(session_id, revision) WHERE session_id IS NOT NULL;
DROP INDEX thread_checkpoints_snapshot;
CREATE INDEX thread_checkpoints_snapshot ON thread_checkpoints(thread_id, through_sequence DESC, revision DESC) WHERE session_id IS NULL;
CREATE INDEX thread_checkpoints_session_snapshot ON thread_checkpoints(session_id, through_sequence DESC, revision DESC) WHERE session_id IS NOT NULL;
CREATE INDEX thread_checkpoints_channel_recent ON thread_checkpoints(channel_id, created_at DESC) WHERE session_id IS NULL;
```

In `adapters/postgres/migrate.ts`, change `'083_office_previews.sql', '084_markdown_knowledge.sql',` to:

```typescript
  '083_office_previews.sql', '084_markdown_knowledge.sql', '085_layered_memory.sql',
```

Then search the tests for a hard-coded migration count and bump it: `grep -rn "084" tests/integration/database.test.ts`. If a fixture lists the latest version, add 85.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm --filter @space/postgres build && cd tests && npx tsx --test integration/layered-memory.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add adapters/postgres/migrations/085_layered_memory.sql adapters/postgres/migrate.ts tests/integration/layered-memory.test.ts
git commit -m "Add layered memory checkpoint schema"
```

---

### Task 2: Contracts

**Files:**
- Modify: `packages/contracts/thread-context.ts`
- Create: `packages/contracts/layered-memory.ts`
- Modify: `packages/contracts/index.ts`
- Test: `tests/contracts/layered-memory.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/contracts/layered-memory.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseThreadCheckpoint, encodeChannelCursor, parseChannelCursor, CHECKPOINT_LIMIT } from '@space/contracts';

const base = { revision: 0, through_sequence: '4', content: '# Decisions\nUse TS.', summary: 'Use TS', source_message_ids: [randomUUID()] };

test('checkpoints require a 1–280 character summary', () => {
  assert.equal(parseThreadCheckpoint(base).summary, 'Use TS');
  assert.throws(() => parseThreadCheckpoint({ ...base, summary: undefined }), (e: any) => e.code === 'invalid_summary');
  assert.throws(() => parseThreadCheckpoint({ ...base, summary: ' ' }), (e: any) => e.code === 'invalid_summary');
  assert.throws(() => parseThreadCheckpoint({ ...base, summary: 'x'.repeat(281) }), (e: any) => e.code === 'invalid_summary');
});

test('over-long checkpoints return 413 checkpoint_too_large', () => {
  assert.equal(CHECKPOINT_LIMIT, 6000);
  assert.throws(() => parseThreadCheckpoint({ ...base, content: 'x'.repeat(6001) }), (e: any) => e.status === 413 && e.code === 'checkpoint_too_large');
});

test('channel cursors round-trip and reject tampering', () => {
  const cursor = { as_of: '2026-11-11 10:00:00.123456+00', created_at: '2026-11-10 09:00:00.5+00', thread_id: randomUUID() };
  assert.deepEqual(parseChannelCursor(encodeChannelCursor(cursor)), cursor);
  for (const bad of ['', 'not-base64!', Buffer.from('{"as_of":1}').toString('base64url'), encodeChannelCursor({ ...cursor, thread_id: 'x' })]) {
    assert.throws(() => parseChannelCursor(bad), (e: any) => e.code === 'invalid_memory_cursor');
  }
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd tests && npx tsx --test contracts/layered-memory.test.ts`
Expected: FAIL with an import error for `encodeChannelCursor`.

- [ ] **Step 3: Update `packages/contracts/thread-context.ts`**

Add `summary` to both interfaces:

```typescript
export interface ThreadCheckpoint {
  revision: number;
  through_sequence: string;
  content: string;
  summary: string;
  source_message_ids: string[];
  producer_id: string;
  producer_name: string;
  created_at: string;
}
export interface ThreadCheckpointInput {
  revision: number;
  through_sequence: string;
  content: string;
  summary: string;
  source_message_ids: string[];
}
export const CHECKPOINT_LIMIT = 6000;
export const SUMMARY_LIMIT = 280;
```

Replace `parseThreadCheckpoint`:

```typescript
export function parseThreadCheckpoint(value: unknown): ThreadCheckpointInput {
  const v = record(value, ['revision', 'through_sequence', 'content', 'summary', 'source_message_ids']);
  if (!Number.isSafeInteger(v.revision) || (v.revision as number) < 0 || !Array.isArray(v.source_message_ids) || v.source_message_ids.length < 1 || v.source_message_ids.length > 32) throw new AppError(400, 'invalid_thread_checkpoint');
  if (typeof v.content === 'string' && v.content.trim().length > CHECKPOINT_LIMIT) throw new AppError(413, 'checkpoint_too_large');
  if (typeof v.summary !== 'string' || !v.summary.trim() || v.summary.trim().length > SUMMARY_LIMIT || v.summary.includes('\0')) throw new AppError(400, 'invalid_summary');
  return { revision: v.revision as number, through_sequence: chatCursor(v.through_sequence), content: text(v.content, CHECKPOINT_LIMIT), summary: v.summary.trim(), source_message_ids: [...new Set(v.source_message_ids.map(uuid))] };
}
```

In `parseThreadContext`, change the checkpoint `record(...)` key list and the parse call to include `summary`:

```typescript
    const p = record(v.checkpoint, ['revision', 'through_sequence', 'content', 'summary', 'source_message_ids', 'producer_id', 'producer_name', 'created_at']);
    const parsed = parseThreadCheckpoint({ revision: p.revision, through_sequence: p.through_sequence, content: p.content, summary: p.summary, source_message_ids: p.source_message_ids });
```

- [ ] **Step 4: Create `packages/contracts/layered-memory.ts`**

```typescript
import { AppError, uuid } from './validation.js';
import type { ThreadCheckpoint, ThreadContext, ThreadContextMessage } from './thread-context.js';

export type MemoryNodeKind = 'channel' | 'thread' | 'session';
export interface MemoryRef { kind: MemoryNodeKind; id: string }
export interface MemoryNode {
  ref: MemoryRef;
  parent: MemoryRef | null;
  summary: string;
  updated_at: string;
  children: { kind: 'thread' | 'session'; count: number } | null;
  title?: string;
  agent?: string;
  state?: 'active' | 'ended';
}
export interface ChannelMemoryPage { channel_id: string; nodes: MemoryNode[]; next_cursor: string | null }
export interface ThreadMemory { node: MemoryNode; context: ThreadContext; sessions: MemoryNode[]; checkpoint_chars: number; limit: number }
export interface SessionMemory { node: MemoryNode; checkpoint: ThreadCheckpoint | null; messages: ThreadContextMessage[]; checkpoint_chars: number; limit: number }
export interface ChannelCursor { as_of: string; created_at: string; thread_id: string }

export const CHANNEL_MEMORY_DAYS = 7;
export const CHANNEL_PAGE_DEFAULT = 20;
export const CHANNEL_PAGE_MAX = 50;

// Contracts also run in the browser, so use btoa/atob instead of Node's Buffer.
const toBase64Url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = (s: string) => new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0)));

export function encodeChannelCursor(cursor: ChannelCursor): string {
  return toBase64Url(JSON.stringify(cursor));
}
export function parseChannelCursor(value: unknown): ChannelCursor {
  const invalid = () => new AppError(400, 'invalid_memory_cursor');
  if (typeof value !== 'string' || !value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  let raw: unknown;
  try { raw = JSON.parse(fromBase64Url(value)); } catch { throw invalid(); }
  if (!raw || typeof raw !== 'object') throw invalid();
  const { as_of, created_at, thread_id } = raw as Record<string, unknown>;
  if (typeof as_of !== 'string' || typeof created_at !== 'string' || !Number.isFinite(Date.parse(as_of)) || !Number.isFinite(Date.parse(created_at))) throw invalid();
  try { return { as_of, created_at, thread_id: uuid(thread_id) }; } catch { throw invalid(); }
}
```

`Date.parse` accepts PostgreSQL's `timestamptz::text` format (`2026-11-11 10:00:00.123456+00`) in Node 22. Step 6 verifies this.

In `packages/contracts/index.ts`, next to the existing `thread-context` export, add:

```typescript
export * from './layered-memory.js';
```

- [ ] **Step 5: Build and run the test**

Run: `pnpm --filter @space/contracts build && cd tests && npx tsx --test contracts/layered-memory.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/thread-context.ts packages/contracts/layered-memory.ts packages/contracts/index.ts tests/contracts/layered-memory.test.ts
git commit -m "Add layered memory contracts and checkpoint summary"
```

---

### Task 3: Optimistic thread checkpoint writes

This task removes the `SELECT … FOR UPDATE` that `AGENTS.md` forbids. The insert itself becomes the revision check.

**Files:**
- Modify: `adapters/postgres/thread-context.ts`
- Modify: `apps/server/memory-mcp.ts` (the `thread_checkpoint` schema only)
- Modify: `tests/integration/memory-mcp.test.ts`
- Test: `tests/integration/layered-memory.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/layered-memory.test.ts`:

```typescript
async function threadKey(token: string, channel: string, thread: string, access: 'read' | 'write' = 'write') {
  return (await api(token, 'POST', `/channels/${channel}/threads/${thread}/context/connections`, { name: `Agent ${randomUUID().slice(0, 8)}`, access }, 201)).token as string;
}

test('concurrent thread checkpoints: one wins, the other gets 409, both revisions stay readable', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Start');
  const client = await connect(await threadKey(a.owner_token, a.channel_id, root.thread_id));
  try {
    const context = data(await client.callTool({ name: 'thread_context', arguments: {} }));
    const input = { revision: 0, through_sequence: context.through_sequence, content: '# Decisions\nA', summary: 'A', source_message_ids: [root.id] };
    const results = await Promise.all([
      client.callTool({ name: 'thread_checkpoint', arguments: input }),
      client.callTool({ name: 'thread_checkpoint', arguments: { ...input, content: '# Decisions\nB', summary: 'B' } }),
    ]);
    assert.equal(results.filter(r => !r.isError).length, 1);
    assert.equal(code(results.find(r => r.isError)), 'thread_checkpoint_conflict');
    const second = data(await client.callTool({ name: 'thread_checkpoint', arguments: { ...input, revision: 1, summary: 'C' } }));
    assert.equal(second.revision, 2);
    const stored = await pool.query('SELECT revision FROM thread_checkpoints WHERE thread_id=$1 AND session_id IS NULL ORDER BY revision', [root.thread_id]);
    assert.deepEqual(stored.rows.map(r => r.revision), [1, 2]);
  } finally { await client.close(); }
});

test('thread checkpoint validates summary and size with stable codes', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Start');
  const client = await connect(await threadKey(a.owner_token, a.channel_id, root.thread_id));
  try {
    const context = data(await client.callTool({ name: 'thread_context', arguments: {} }));
    const input = { revision: 0, through_sequence: context.through_sequence, content: 'ok', summary: 'ok', source_message_ids: [root.id] };
    assert.equal(code(await client.callTool({ name: 'thread_checkpoint', arguments: { ...input, content: 'x'.repeat(6001) } })), 'checkpoint_too_large');
    assert.equal(code(await client.callTool({ name: 'thread_checkpoint', arguments: { ...input, summary: 'x'.repeat(281) } })), 'invalid_summary');
    assert.equal(code(await client.callTool({ name: 'thread_checkpoint', arguments: { ...input, revision: 5 } })), 'thread_checkpoint_conflict');
  } finally { await client.close(); }
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd tests && npx tsx --test --test-name-pattern="checkpoint" integration/layered-memory.test.ts`
Expected: FAIL. The MCP schema rejects the unknown `summary` field.

- [ ] **Step 3: Update `adapters/postgres/thread-context.ts`**

Export the row helper so Task 4 can reuse it, and limit reads to thread rows:

```typescript
export async function rows<T>(c: DbSession, query: Parameters<DbSession['execute']>[0]): Promise<T[]> {
  return (await c.execute(query)).rows as T[];
}
```

```typescript
const checkpointColumns = sql`revision,through_sequence::text,content,summary,source_message_ids,producer_id,producer_name,created_at::text`;
async function checkpoint(c: DbSession, threadId: string, through: string): Promise<ThreadCheckpoint | null> {
  const [row] = await rows<ThreadCheckpoint>(c, sql`SELECT ${checkpointColumns}
    FROM thread_checkpoints WHERE thread_id=${threadId} AND session_id IS NULL AND through_sequence<=${through}::bigint ORDER BY revision DESC LIMIT 1`);
  return row ?? null;
}
```

Add an `includeSessions` option to `readThreadContext`. The default `true` keeps today's behavior for task context and `thread_context`. Task 4 passes `false`:

```typescript
export async function readThreadContext(c: DbSession, channelId: string, threadId: string, through?: string, options: { includeSessions?: boolean } = {}): Promise<ThreadContext> {
  await assertContextThread(c, channelId, threadId);
  const visible = options.includeSessions === false ? sql`AND agent_session_id IS NULL` : sql``;
  const [latest] = await rows<{ sequence: string }>(c, sql`SELECT sequence::text FROM messages WHERE channel_id=${channelId} AND thread_id=${threadId} ${visible} ORDER BY messages.sequence DESC LIMIT 1`);
  const watermark = through === undefined ? latest?.sequence ?? '0' : chatCursor(through);
  const recent = await rows<Row>(c, sql`SELECT ${columns} FROM messages WHERE channel_id=${channelId} AND thread_id=${threadId} ${visible} AND sequence<=${watermark}::bigint ORDER BY messages.sequence DESC LIMIT 17`);
  const [root] = await rows<Row>(c, sql`SELECT ${columns} FROM messages WHERE channel_id=${channelId} AND thread_id=${threadId} ${visible} AND sequence<=${watermark}::bigint ORDER BY messages.sequence LIMIT 1`);
  return { thread_id: threadId, through_sequence: watermark, root: root ? message(root) : null,
    messages: recent.slice(0,16).reverse().map(message), checkpoint: await checkpoint(c, threadId, watermark), has_earlier_messages: recent.length > 16 };
}
```

Add a shared source validator and replace `writeThreadCheckpoint`:

```typescript
// The watermark may be any message in the thread, so turn-end saves (Task 10) can use the latest one.
export async function assertCheckpointSources(c: DbSession, channelId: string, threadId: string, input: ThreadCheckpointInput, scope: 'thread' | 'session') {
  const [boundary] = await rows(c, sql`SELECT id FROM messages WHERE channel_id=${channelId} AND thread_id=${threadId} AND sequence=${input.through_sequence}::bigint`);
  if (!boundary) throw new AppError(400, `invalid_${scope}_watermark`);
  const found = await rows<{ id: string }>(c, sql`SELECT id FROM messages WHERE channel_id=${channelId} AND thread_id=${threadId}
    AND id = ANY(${sql.param(input.source_message_ids)}::uuid[]) AND sequence<=${input.through_sequence}::bigint`);
  if (found.length !== input.source_message_ids.length) throw new AppError(400, `invalid_${scope}_source`);
}

// Optimistic concurrency: the partial unique index on (thread_id, revision) rejects a competing insert.
export async function writeThreadCheckpoint(c: DbSession, channelId: string, threadId: string, input: ThreadCheckpointInput, producer: { id: string; name: string }): Promise<ThreadCheckpoint> {
  await assertContextThread(c, channelId, threadId);
  const current = await checkpoint(c, threadId, '9223372036854775807');
  if ((current?.revision ?? 0) !== input.revision) throw new AppError(409, 'thread_checkpoint_conflict');
  if (current && BigInt(input.through_sequence) < BigInt(current.through_sequence)) throw new AppError(409, 'thread_checkpoint_watermark_conflict');
  await assertCheckpointSources(c, channelId, threadId, input, 'thread');
  const [saved] = await rows<ThreadCheckpoint>(c, sql`INSERT INTO thread_checkpoints(thread_id,channel_id,revision,through_sequence,content,summary,source_message_ids,producer_id,producer_name)
    VALUES(${threadId},${channelId},${input.revision+1},${input.through_sequence}::bigint,${input.content},${input.summary},${sql.param(input.source_message_ids)}::uuid[],${producer.id},${producer.name})
    ON CONFLICT (thread_id, revision) WHERE session_id IS NULL DO NOTHING
    RETURNING ${checkpointColumns}`);
  if (!saved) throw new AppError(409, 'thread_checkpoint_conflict');
  return saved;
}
```

The old code checked sources one query at a time. The new code checks them in a single `ANY` query. `parseThreadCheckpoint` already removes duplicate IDs, so comparing the counts is exact.

- [ ] **Step 4: Update the `thread_checkpoint` tool schema in `apps/server/memory-mcp.ts`**

Allow content up to 12,000 characters and summaries up to 1,000 at the schema, so that `parseThreadCheckpoint` (not zod) returns the stable `413` and `400` codes:

```typescript
const checkpointSchema = z.strictObject({ revision: z.number().int().min(0), through_sequence: z.string().regex(/^[1-9]\d{0,18}$/), content: z.string().min(1).max(12_000), summary: z.string().max(1000), source_message_ids: z.array(z.uuid()).min(1).max(32) });
```

Use `inputSchema: checkpointSchema` in `thread_checkpoint`. Add this sentence to its description: `Also send summary: one line (≤280 chars) shown in the channel index. When checkpoint_chars passes 80% of limit, rewrite the checkpoint shorter.`

- [ ] **Step 5: Add `summary` to the existing tests**

In `tests/integration/memory-mcp.test.ts`, add `summary: 'Decisions'` to the `checkpoint` object (around line 173) and to the `input` object in the race test (around line 229). Then find any other callers: `grep -rn "thread_checkpoint" tests apps --include=*.ts`. Add `summary` to each one.

- [ ] **Step 6: Build and run the tests**

Run: `pnpm --filter @space/postgres --filter @space/server build && cd tests && npx tsx --test integration/layered-memory.test.ts integration/memory-mcp.test.ts`
Expected: PASS for all tests.

- [ ] **Step 7: Commit**

```bash
git add adapters/postgres/thread-context.ts apps/server/memory-mcp.ts tests/integration/memory-mcp.test.ts tests/integration/layered-memory.test.ts
git commit -m "Write thread checkpoints optimistically with summaries"
```

---

### Task 4: Layer readers and session checkpoints

**Files:**
- Create: `adapters/postgres/layered-memory.ts`
- Modify: `adapters/postgres/package.json` (exports)
- Test: `tests/integration/layered-memory.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/layered-memory.test.ts`:

```typescript
import { readChannelMemory, readThreadMemory, readSessionMemory, writeSessionCheckpoint } from '@space/postgres/layered-memory';

const db = () => new PostgresStore(pool).db;
async function seedCheckpoint(channel: string, thread: string, message: { id: string; sequence: string }, owner: string, summary: string, at?: string) {
  await pool.query(`INSERT INTO thread_checkpoints(thread_id,channel_id,revision,through_sequence,content,summary,source_message_ids,producer_id,producer_name,created_at)
    VALUES($1,$2,coalesce((SELECT max(revision) FROM thread_checkpoints WHERE thread_id=$1 AND session_id IS NULL),0)+1,$3,$4,$4,ARRAY[$5]::uuid[],$6,'seed',coalesce($7::timestamptz,now()))`,
    [thread, channel, message.sequence, summary, message.id, owner, at ?? null]);
}

test('channel index: 7-day window, newest first, stable keyset paging under writes', async () => {
  const a = await bootstrap(pool);
  const roots = [];
  for (let i = 0; i < 60; i++) {
    const root = await post(a.owner_token, a.channel_id, `Thread ${i}`);
    await seedCheckpoint(a.channel_id, root.thread_id, root, a.owner_id, `S${i}`, new Date(Date.now() - (60 - i) * 60_000).toISOString());
    roots.push(root);
  }
  const old = await post(a.owner_token, a.channel_id, 'Old');
  await seedCheckpoint(a.channel_id, old.thread_id, old, a.owner_id, 'Old', new Date(Date.now() - 8 * 86_400_000).toISOString());
  const first = await readChannelMemory(db(), a.channel_id, undefined, 50);
  assert.equal(first.nodes.length, 50);
  assert.equal(first.nodes[0]!.summary, 'S59');
  assert.equal(first.nodes[0]!.parent?.kind, 'channel');
  assert.ok(first.next_cursor);
  await seedCheckpoint(a.channel_id, roots[0]!.thread_id, roots[0]!, a.owner_id, 'S0 updated');
  const second = await readChannelMemory(db(), a.channel_id, first.next_cursor!, 50);
  const ids = [...first.nodes, ...second.nodes].map(n => n.ref.id);
  assert.equal(ids.length, 60);
  assert.equal(new Set(ids).size, 60);
  assert.ok(!ids.includes(old.thread_id));
  assert.equal(second.next_cursor, null);
  const thread = await readThreadMemory(db(), a.channel_id, old.thread_id);
  assert.equal(thread.node.summary, 'Old');
});

test('thread memory lists sessions without content; session memory checks the installation', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Start');
  const session = randomUUID();
  await pool.query(`INSERT INTO agent_sessions(id,workspace_id,installation_id,origin_thread_id,title) VALUES($1,$2,$3,$4,'Fix fixture')`, [session, a.workspace_id, a.installation_id, root.thread_id]);
  const turn = (await pool.query(`INSERT INTO messages(id,workspace_id,channel_id,thread_id,installation_id,author_type,text,agent_session_id)
    VALUES($1,$2,$3,$4,$5,'agent','Step 3 failed',$6) RETURNING id, sequence::text`, [randomUUID(), a.workspace_id, a.channel_id, root.thread_id, a.installation_id, session])).rows[0];
  const thread = await readThreadMemory(db(), a.channel_id, root.thread_id);
  assert.equal(thread.sessions.length, 1);
  assert.equal(thread.sessions[0]!.title, 'Fix fixture');
  assert.equal(thread.sessions[0]!.state, 'active');
  assert.ok(!thread.context.messages.some(m => m.id === turn.id));
  const saved = await writeSessionCheckpoint(db(), a.channel_id, session, a.installation_id, { revision: 0, through_sequence: turn.sequence, content: '# Progress\nStep 3 failed', summary: 'Step 3 failed', source_message_ids: [turn.id] }, { id: a.installation_id, name: 'Codex' });
  assert.equal(saved.revision, 1);
  const own = await readSessionMemory(db(), a.channel_id, session, a.installation_id);
  assert.equal(own.checkpoint?.summary, 'Step 3 failed');
  assert.equal(own.messages[0]!.id, turn.id);
  assert.equal(own.node.parent?.id, root.thread_id);
  await assert.rejects(readSessionMemory(db(), a.channel_id, session, randomUUID()), (e: any) => e.code === 'session_private');
  await assert.rejects(readSessionMemory(db(), a.channel_id, session, null), (e: any) => e.code === 'session_private');
  const other = await bootstrap(pool);
  await assert.rejects(readSessionMemory(db(), other.channel_id, session, a.installation_id), (e: any) => e.status === 404);
  await pool.query(`UPDATE agent_sessions SET state='ended' WHERE id=$1`, [session]);
  await assert.rejects(readSessionMemory(db(), a.channel_id, session, a.installation_id), (e: any) => e.code === 'session_ended');
});
```

Before running, check that the `bootstrap` result exposes `workspace_id`, `installation_id` and `owner_id`: `grep -n "return {" adapters/postgres/bootstrap.ts`. If a field has another name, use that name in the test. Also check the `messages` insert column list against `adapters/postgres/migrations/005_realtime_chat.sql`. If `sequence` has no default, insert the next channel sequence the same way `adapters/postgres/chat.ts` does.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd tests && npx tsx --test integration/layered-memory.test.ts`
Expected: FAIL. The module `@space/postgres/layered-memory` does not exist.

- [ ] **Step 3: Create `adapters/postgres/layered-memory.ts`**

```typescript
import { sql } from 'drizzle-orm';
import {
  AppError, uuid, chatCursor, encodeChannelCursor, parseChannelCursor,
  CHANNEL_MEMORY_DAYS, CHANNEL_PAGE_DEFAULT, CHANNEL_PAGE_MAX, CHECKPOINT_LIMIT,
  type ChannelMemoryPage, type MemoryNode, type SessionMemory, type ThreadMemory,
  type ThreadCheckpoint, type ThreadCheckpointInput, type ThreadContextMessage,
} from '@space/contracts';
import type { DbSession } from './database.js';
import { assertCheckpointSources, assertContextThread, readThreadContext, rows } from './thread-context.js';

const checkpointColumns = sql`revision,through_sequence::text,content,summary,source_message_ids,producer_id,producer_name,created_at::text`;

export async function readChannelMemory(c: DbSession, channelId: string, after?: string, limit = CHANNEL_PAGE_DEFAULT): Promise<ChannelMemoryPage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > CHANNEL_PAGE_MAX) throw new AppError(400, 'invalid_memory_limit');
  const cursor = after === undefined ? null : parseChannelCursor(after);
  const asOf = cursor?.as_of ?? (await rows<{ now: string }>(c, sql`SELECT now()::text AS now`))[0]!.now;
  // Snapshot at as_of so a checkpoint written between pages cannot move a thread across the cursor.
  const found = await rows<{ thread_id: string; summary: string; created_at: string; sessions: number }>(c, sql`
    SELECT latest.thread_id, latest.summary, latest.created_at::text AS created_at,
      (SELECT count(*)::int FROM agent_sessions a WHERE a.origin_thread_id = latest.thread_id) AS sessions
    FROM (
      SELECT DISTINCT ON (cp.thread_id) cp.thread_id, cp.summary, cp.created_at
      FROM thread_checkpoints cp
      WHERE cp.channel_id = ${channelId} AND cp.session_id IS NULL
        AND cp.created_at <= ${asOf}::timestamptz
        AND cp.created_at > ${asOf}::timestamptz - make_interval(days => ${CHANNEL_MEMORY_DAYS})
      ORDER BY cp.thread_id, cp.revision DESC
    ) latest
    WHERE ${cursor ? sql`(latest.created_at, latest.thread_id) < (${cursor.created_at}::timestamptz, ${cursor.thread_id}::uuid)` : sql`true`}
    ORDER BY latest.created_at DESC, latest.thread_id DESC
    LIMIT ${limit + 1}`);
  const page = found.slice(0, limit);
  const last = page.at(-1);
  return {
    channel_id: channelId,
    nodes: page.map(row => ({ ref: { kind: 'thread', id: row.thread_id }, parent: { kind: 'channel', id: channelId }, summary: row.summary, updated_at: row.created_at, children: { kind: 'session', count: row.sessions } })),
    next_cursor: found.length > limit && last ? encodeChannelCursor({ as_of: asOf, created_at: last.created_at, thread_id: last.thread_id }) : null,
  };
}

async function sessionNodes(c: DbSession, threadId: string): Promise<MemoryNode[]> {
  const found = await rows<{ id: string; title: string; state: 'active' | 'ended'; agent: string; summary: string | null; updated_at: string }>(c, sql`
    SELECT a.id, a.title, a.state, d.name AS agent,
      (SELECT cp.summary FROM thread_checkpoints cp WHERE cp.session_id = a.id ORDER BY cp.revision DESC LIMIT 1) AS summary,
      coalesce((SELECT max(cp.created_at) FROM thread_checkpoints cp WHERE cp.session_id = a.id), a.created_at)::text AS updated_at
    FROM agent_sessions a JOIN agent_installations i ON i.id = a.installation_id JOIN agent_definitions d ON d.id = i.definition_id
    WHERE a.origin_thread_id = ${threadId} ORDER BY a.created_at DESC, a.id DESC LIMIT 50`);
  return found.map(row => ({ ref: { kind: 'session', id: row.id }, parent: { kind: 'thread', id: threadId }, summary: row.summary ?? row.title, updated_at: row.updated_at, children: null, title: row.title, agent: row.agent, state: row.state }));
}

export async function readThreadMemory(c: DbSession, channelId: string, threadId: string): Promise<ThreadMemory> {
  const context = await readThreadContext(c, channelId, uuid(threadId), undefined, { includeSessions: false });
  const sessions = await sessionNodes(c, context.thread_id);
  const cp = context.checkpoint;
  return {
    node: { ref: { kind: 'thread', id: context.thread_id }, parent: { kind: 'channel', id: channelId }, summary: cp?.summary ?? context.root?.text.slice(0, 280) ?? '', updated_at: cp?.created_at ?? '', children: { kind: 'session', count: sessions.length } },
    context, sessions, checkpoint_chars: cp?.content.length ?? 0, limit: CHECKPOINT_LIMIT,
  };
}

async function sessionRow(c: DbSession, channelId: string, sessionId: string) {
  const [row] = await rows<{ id: string; thread_id: string; installation_id: string; title: string; state: 'active' | 'ended'; agent: string; created_at: string }>(c, sql`
    SELECT a.id, a.origin_thread_id AS thread_id, a.installation_id, a.title, a.state, d.name AS agent, a.created_at::text
    FROM agent_sessions a JOIN threads t ON t.id = a.origin_thread_id
    JOIN agent_installations i ON i.id = a.installation_id JOIN agent_definitions d ON d.id = i.definition_id
    WHERE a.id = ${uuid(sessionId)} AND t.channel_id = ${channelId}`);
  if (!row) throw new AppError(404, 'session_not_found');
  return row;
}
async function sessionCheckpoint(c: DbSession, sessionId: string): Promise<ThreadCheckpoint | null> {
  const [row] = await rows<ThreadCheckpoint>(c, sql`SELECT ${checkpointColumns} FROM thread_checkpoints WHERE session_id = ${sessionId} ORDER BY revision DESC LIMIT 1`);
  return row ?? null;
}

// installationId is the caller's bound installation; null means an unbound key.
export async function readSessionMemory(c: DbSession, channelId: string, sessionId: string, installationId: string | null): Promise<SessionMemory> {
  const session = await sessionRow(c, channelId, sessionId);
  if (installationId === null || session.installation_id !== installationId) throw new AppError(403, 'session_private');
  if (session.state === 'ended') throw new AppError(409, 'session_ended');
  const checkpoint = await sessionCheckpoint(c, session.id);
  const recent = await rows<{ id: string; sequence: string; text: string; text_length: number; author_id: string; attachments: ThreadContextMessage['attachments'] }>(c, sql`
    SELECT id, sequence::text, left(text, 1000) AS text, length(text) AS text_length, installation_id AS author_id, attachments
    FROM messages WHERE channel_id = ${channelId} AND thread_id = ${session.thread_id} AND agent_session_id = ${session.id}
    ORDER BY sequence DESC LIMIT 16`);
  const messages: ThreadContextMessage[] = recent.reverse().map(row => {
    const text = row.text.replace(/[\uD800-\uDBFF]$/, '');
    return { id: row.id, sequence: row.sequence, text, text_truncated: row.text_length > 1000 || text !== row.text, author: { id: row.author_id, kind: 'agent' }, attachments: row.attachments };
  });
  return {
    node: { ref: { kind: 'session', id: session.id }, parent: { kind: 'thread', id: session.thread_id }, summary: checkpoint?.summary ?? session.title, updated_at: checkpoint?.created_at ?? session.created_at, children: null, title: session.title, agent: session.agent, state: session.state },
    checkpoint, messages, checkpoint_chars: checkpoint?.content.length ?? 0, limit: CHECKPOINT_LIMIT,
  };
}

export async function writeSessionCheckpoint(c: DbSession, channelId: string, sessionId: string, installationId: string | null, input: ThreadCheckpointInput, producer: { id: string; name: string }): Promise<ThreadCheckpoint> {
  const session = await sessionRow(c, channelId, sessionId);
  if (installationId === null || session.installation_id !== installationId) throw new AppError(403, 'session_private');
  if (session.state === 'ended') throw new AppError(409, 'session_ended');
  await assertContextThread(c, channelId, session.thread_id);
  const current = await sessionCheckpoint(c, session.id);
  if ((current?.revision ?? 0) !== input.revision) throw new AppError(409, 'session_checkpoint_conflict');
  if (current && BigInt(chatCursor(input.through_sequence)) < BigInt(current.through_sequence)) throw new AppError(409, 'session_checkpoint_watermark_conflict');
  await assertCheckpointSources(c, channelId, session.thread_id, input, 'session');
  const [saved] = await rows<ThreadCheckpoint>(c, sql`INSERT INTO thread_checkpoints(thread_id,session_id,channel_id,revision,through_sequence,content,summary,source_message_ids,producer_id,producer_name)
    VALUES(${session.thread_id},${session.id},${channelId},${input.revision + 1},${input.through_sequence}::bigint,${input.content},${input.summary},${sql.param(input.source_message_ids)}::uuid[],${producer.id},${producer.name})
    ON CONFLICT (session_id, revision) WHERE session_id IS NOT NULL DO NOTHING
    RETURNING ${checkpointColumns}`);
  if (!saved) throw new AppError(409, 'session_checkpoint_conflict');
  return saved;
}
```

The ended-session check raises `409 session_ended`. The spec says ended content "is no longer given out", and this code is that rule. The session still appears in `thread_memory` with `state: 'ended'`.

In `adapters/postgres/package.json`, add next to `./thread-context`:

```json
    "./layered-memory": {
      "types": "./dist/layered-memory.d.ts",
      "default": "./dist/layered-memory.js"
    },
```

- [ ] **Step 4: Build and run the tests**

Run: `pnpm --filter @space/postgres build && cd tests && npx tsx --test integration/layered-memory.test.ts`
Expected: PASS for all tests.

- [ ] **Step 5: Commit**

```bash
git add adapters/postgres/layered-memory.ts adapters/postgres/package.json tests/integration/layered-memory.test.ts
git commit -m "Add channel, thread and session memory readers"
```

---

### Task 5: MCP tools on channel keys

**Files:**
- Modify: `apps/server/memory-mcp.ts`
- Test: `tests/integration/layered-memory.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/layered-memory.test.ts`:

```typescript
async function channelKey(token: string, channel: string, access: 'read' | 'contribute' | 'write', installation?: string) {
  const path = `/channels/${channel}/memory`;
  await api(token, 'POST', `${path}/settings`, { enabled: true });
  if (installation) await api(token, 'POST', `${path}/agents/${installation}`, { access: access === 'read' ? 'read' : 'contribute' });
  return (await api(token, 'POST', `${path}/connections`, { name: `Key ${randomUUID().slice(0, 8)}`, access, ...(installation ? { installation_id: installation } : {}) }, 201)).token as string;
}

test('agent walks channel → thread → session over MCP and is fenced at each step', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Dedupe fix');
  await seedCheckpoint(a.channel_id, root.thread_id, root, a.owner_id, 'Dedupe fix · in progress');
  const mine = randomUUID(), theirs = randomUUID();
  const secondInstallation = randomUUID();
  await pool.query(`INSERT INTO agent_installations(id,workspace_id,owner_id,definition_id,connector_id)
    SELECT $1,workspace_id,owner_id,definition_id,connector_id FROM agent_installations WHERE id=$2`, [secondInstallation, a.installation_id]);
  await pool.query(`INSERT INTO agent_sessions(id,workspace_id,installation_id,origin_thread_id,title) VALUES($1,$2,$3,$4,'Run')`, [mine, a.workspace_id, a.installation_id, root.thread_id]);
  await pool.query(`INSERT INTO agent_sessions(id,workspace_id,installation_id,origin_thread_id,title) VALUES($1,$2,$3,$4,'Run')`, [theirs, a.workspace_id, secondInstallation, root.thread_id]);
  const foreign = await post(b.owner_token, b.channel_id, 'Other workspace');
  const client = await connect(await channelKey(a.owner_token, a.channel_id, 'contribute', a.installation_id));
  try {
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const name of ['channel_memory', 'thread_memory', 'session_memory', 'session_checkpoint']) assert.ok(names.includes(name), name);
    const index = data(await client.callTool({ name: 'channel_memory', arguments: {} }));
    assert.equal(index.nodes[0].summary, 'Dedupe fix · in progress');
    const thread = data(await client.callTool({ name: 'thread_memory', arguments: { thread_id: index.nodes[0].ref.id } }));
    assert.equal(thread.sessions.length, 2);
    data(await client.callTool({ name: 'session_memory', arguments: { session_id: mine } }));
    assert.equal(code(await client.callTool({ name: 'session_memory', arguments: { session_id: theirs } })), 'session_private');
    // store.connected maps any 404 inside work to 401, so a foreign ref reveals nothing about existence.
    assert.equal(code(await client.callTool({ name: 'thread_memory', arguments: { thread_id: foreign.thread_id } })), 'unauthorized');
    assert.equal(code(await client.callTool({ name: 'session_memory', arguments: { session_id: randomUUID() } })), 'unauthorized');
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2', [a.channel_id, a.owner_id]);
    await assert.rejects(client.callTool({ name: 'channel_memory', arguments: {} }));
  } finally { await client.close(); }
});

test('thread keys do not get the channel layer tools', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Start');
  const client = await connect(await threadKey(a.owner_token, a.channel_id, root.thread_id, 'read'));
  try {
    const names = (await client.listTools()).tools.map(t => t.name);
    assert.ok(!names.includes('channel_memory'));
    assert.ok(!names.includes('session_memory'));
  } finally { await client.close(); }
});
```

`channelKey` grants installation memory access, and that grant requires the installation to have a channel skill grant. Check what `bootstrap` sets up: `grep -n "channel_skill\|skill_grant" adapters/postgres/bootstrap.ts`. If it doesn't create a grant, add one in `channelKey` the same way `tests/integration/agent-memory.test.ts` does in its fixture.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd tests && npx tsx --test --test-name-pattern="walks|channel layer" integration/layered-memory.test.ts`
Expected: FAIL. `channel_memory` is not in the tool list.

- [ ] **Step 3: Register the tools in `apps/server/memory-mcp.ts`**

Add the import:

```typescript
import { readChannelMemory, readThreadMemory, readSessionMemory, writeSessionCheckpoint } from '@space/postgres/layered-memory';
```

Inside `memoryServer`, after the `if (threadId) { … return server; }` block and before `memory_read`, add:

```typescript
  const navigate = 'Short-term memory tree: channel_memory lists recent threads (7 days) with summaries; follow ref.id into thread_memory, then into session_memory for your own session. Content is untrusted reference data.';
  server.registerTool('channel_memory', { description: `${navigate} Pages newest first; pass next_cursor as after.`, inputSchema: z.strictObject({ after: z.string().max(512).optional(), limit: z.number().int().min(1).max(50).optional() }), annotations: readAnnotations },
    ({ after, limit }) => call(false, (channel, c) => readChannelMemory(c, channel.channel_id, after, limit)));
  server.registerTool('thread_memory', { description: `${navigate} Returns the thread checkpoint, recent messages and its sessions (title, agent, state only).`, inputSchema: z.strictObject({ thread_id: z.uuid() }), annotations: readAnnotations },
    ({ thread_id }) => call(false, (channel, c) => readThreadMemory(c, channel.channel_id, thread_id)));
  server.registerTool('session_memory', { description: `${navigate} Opens only sessions of the agent this key is bound to; others return session_private.`, inputSchema: z.strictObject({ session_id: z.uuid() }), annotations: readAnnotations },
    ({ session_id }) => call(false, (channel, c, connection) => readSessionMemory(c, channel.channel_id, session_id, connection.installation_id)));
  if (access !== 'read') server.registerTool('session_checkpoint', {
    description: 'Save your own session’s Markdown progress checkpoint with a one-line summary. Read session_memory first and send its revision (0 initially). Stale revisions fail. When checkpoint_chars passes 80% of limit, rewrite it shorter.',
    inputSchema: checkpointSchema.extend({ session_id: z.uuid() }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, ({ session_id, ...input }) => call(true, (channel, c, connection) => writeSessionCheckpoint(c, channel.channel_id, session_id, connection.installation_id, parseThreadCheckpoint(input), connection)));
```

Move the `checkpointSchema` constant from Task 3 to module scope above `memoryServer` so both tools share it.

`store.connected` already rechecks the key, membership, channel opt-in and installation grant before and after `work`. A `404` from inside `work` becomes `401 unauthorized` (`adapters/postgres/memory.ts:161`), and `call()` returns that as a tool error. So a `ref` outside the channel gets `unauthorized` and reveals nothing about existence. This meets the spec's rule that the reply must not say whether the thread exists. `403 session_private` is not remapped.

- [ ] **Step 4: Build and run the tests**

Run: `pnpm --filter @space/server build && cd tests && npx tsx --test integration/layered-memory.test.ts integration/memory-mcp.test.ts`
Expected: PASS for all tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/memory-mcp.ts tests/integration/layered-memory.test.ts
git commit -m "Expose layered memory tools on channel MCP keys"
```

---

### Task 6: Task context fields

**Files:**
- Modify: `packages/contracts/index.ts:34` (`InvocationRequest.context`)
- Modify: `packages/contracts/foundation.ts:49-55`
- Modify: `adapters/postgres/store.ts:254-273`
- Modify: `tests/integration/agent-memory.test.ts`, `tests/integration/connected-agent-access.test.ts`
- Test: `tests/integration/agent-memory.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/integration/agent-memory.test.ts`, replace every `context?.channel_memory` and `context!.channel_memory` on lines 55–73 with `channel_notes`. Then add this after line 63:

```typescript
  const layered = result.request.context!;
  assert.ok(Array.isArray(layered.channel_memory!.nodes));
  assert.equal(layered.agent_session_memory?.node.ref.id, result.request.session_id);
```

In `tests/integration/connected-agent-access.test.ts:96`, change `prepared.request.context?.channel_memory` to `prepared.request.context?.channel_notes`.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd tests && npx tsx --test integration/agent-memory.test.ts`
Expected: FAIL. `channel_notes` is undefined.

- [ ] **Step 3: Extend the contract**

In `packages/contracts/index.ts`, change the `context?:` type of `InvocationRequest` to:

```typescript
context?: {handoff?:import('./sidekick.js').SidekickContext;channel_notes?:import('./memory.js').AgentMemoryContext;channel_memory?:import('./layered-memory.js').ChannelMemoryPage;agent_session_memory?:import('./layered-memory.js').SessionMemory;working_memory?:ThreadContext;thread_id:string;messages:{id:string;text:string;author_type:'human'|'agent'|'app'|'workflow'}[]}
```

In `packages/contracts/foundation.ts`, change the context record keys and the assembled object:

```typescript
    const ctx = record(v.context, ['thread_id', 'messages', 'working_memory', 'channel_notes', 'channel_memory', 'agent_session_memory', 'handoff']);
```

```typescript
    context = { ...(ctx.handoff === undefined ? {} : {handoff: parseSidekickContext(ctx.handoff)}),
      ...(ctx.channel_notes === undefined ? {} : { channel_notes: parseAgentMemoryContext(ctx.channel_notes) }),
      ...(ctx.channel_memory === undefined ? {} : { channel_memory: parseChannelMemoryPage(ctx.channel_memory) }),
      ...(ctx.agent_session_memory === undefined ? {} : { agent_session_memory: parseSessionMemory(ctx.agent_session_memory) }),
      ...(working_memory ? { working_memory } : {}), thread_id: uuid(ctx.thread_id), messages: ctx.messages.map(raw => {
```

Add the two parsers to `packages/contracts/layered-memory.ts`:

```typescript
import { record, text } from './validation.js';
import { parseThreadCheckpoint } from './thread-context.js';

function parseRef(value: unknown): MemoryRef {
  const r = record(value, ['kind', 'id']);
  if (r.kind !== 'channel' && r.kind !== 'thread' && r.kind !== 'session') throw new AppError(400, 'invalid_memory_node');
  return { kind: r.kind, id: uuid(r.id) };
}
function parseNode(value: unknown): MemoryNode {
  const n = record(value, ['ref', 'parent', 'summary', 'updated_at', 'children', 'title', 'agent', 'state']);
  if (typeof n.summary !== 'string' || n.summary.length > 280 || typeof n.updated_at !== 'string') throw new AppError(400, 'invalid_memory_node');
  let children: MemoryNode['children'] = null;
  if (n.children !== null) {
    const ch = record(n.children, ['kind', 'count']);
    if ((ch.kind !== 'thread' && ch.kind !== 'session') || !Number.isSafeInteger(ch.count) || (ch.count as number) < 0) throw new AppError(400, 'invalid_memory_node');
    children = { kind: ch.kind, count: ch.count as number };
  }
  if (n.state !== undefined && n.state !== 'active' && n.state !== 'ended') throw new AppError(400, 'invalid_memory_node');
  return { ref: parseRef(n.ref), parent: n.parent === null ? null : parseRef(n.parent), summary: n.summary, updated_at: n.updated_at, children,
    ...(n.title === undefined ? {} : { title: text(n.title, 160) }), ...(n.agent === undefined ? {} : { agent: text(n.agent, 160) }), ...(n.state === undefined ? {} : { state: n.state as 'active' | 'ended' }) };
}
export function parseChannelMemoryPage(value: unknown): ChannelMemoryPage {
  const p = record(value, ['channel_id', 'nodes', 'next_cursor']);
  if (!Array.isArray(p.nodes) || p.nodes.length > CHANNEL_PAGE_MAX) throw new AppError(400, 'invalid_channel_memory');
  return { channel_id: uuid(p.channel_id), nodes: p.nodes.map(parseNode), next_cursor: p.next_cursor === null ? null : (parseChannelCursor(p.next_cursor), p.next_cursor as string) };
}
export function parseSessionMemory(value: unknown): SessionMemory {
  const s = record(value, ['node', 'checkpoint', 'messages', 'checkpoint_chars', 'limit']);
  if (!Array.isArray(s.messages) || s.messages.length > 16 || !Number.isSafeInteger(s.checkpoint_chars) || s.limit !== 6000) throw new AppError(400, 'invalid_session_memory');
  let checkpoint: ThreadCheckpoint | null = null;
  if (s.checkpoint !== null) {
    const p = record(s.checkpoint, ['revision', 'through_sequence', 'content', 'summary', 'source_message_ids', 'producer_id', 'producer_name', 'created_at']);
    checkpoint = { ...parseThreadCheckpoint({ revision: p.revision, through_sequence: p.through_sequence, content: p.content, summary: p.summary, source_message_ids: p.source_message_ids }), producer_id: uuid(p.producer_id), producer_name: text(p.producer_name, 100), created_at: text(p.created_at, 64) };
  }
  return { node: parseNode(s.node), checkpoint, messages: s.messages.map(parseThreadContextMessage), checkpoint_chars: s.checkpoint_chars as number, limit: 6000 };
}
```

Change the import at the top of `layered-memory.ts` to `import { parseThreadCheckpoint, parseThreadContextMessage } from './thread-context.js';`.

In `packages/contracts/thread-context.ts`, move the inner `parseMessage` function out of `parseThreadContext` and export it as `parseThreadContextMessage(value: unknown): ThreadContextMessage`. Leave out the `sequence <= through` check, which stays in `parseThreadContext`:

```typescript
export function parseThreadContextMessage(value: unknown): ThreadContextMessage {
  const m = record(value, ['id', 'sequence', 'text', 'text_truncated', 'author', 'attachments']);
  const author = record(m.author, ['id', 'kind']);
  if (!['human', 'agent', 'app', 'workflow'].includes(author.kind as string) || typeof m.text !== 'string' || m.text.length > 1000 || m.text.includes('\0') || typeof m.text_truncated !== 'boolean' || !Array.isArray(m.attachments) || m.attachments.length > 20) throw new AppError(400, 'invalid_thread_message');
  const attachments = m.attachments.map(raw => {
    const a = record(raw, ['id', 'name', 'size', 'type']);
    if (!Number.isSafeInteger(a.size) || (a.size as number) < 0) throw new AppError(400, 'invalid_attachment');
    return { id: uuid(a.id), name: text(a.name, 255), size: a.size as number, type: text(a.type, 255) };
  });
  return { id: uuid(m.id), sequence: chatCursor(m.sequence), text: m.text, text_truncated: m.text_truncated, author: { id: uuid(author.id), kind: author.kind as ThreadContextMessage['author']['kind'] }, attachments };
}
```

Inside `parseThreadContext`, replace the old inner function with:

```typescript
  const parseMessage = (value: unknown): ThreadContextMessage => {
    const parsed = parseThreadContextMessage(value);
    if (BigInt(parsed.sequence) > BigInt(through)) throw new AppError(400, 'invalid_thread_sequence');
    return parsed;
  };
```

- [ ] **Step 4: Fill the fields in `adapters/postgres/store.ts`**

Add the import:

```typescript
import { readChannelMemory, readSessionMemory } from './layered-memory.js';
```

After the `const context: NonNullable<…> = { … }` line (line 255), add:

```typescript
      context.channel_memory = await readChannelMemory(c, thread.channel_id);
      if (task.session_id) {
        const own = await readSessionMemory(c, thread.channel_id, task.session_id, task.installation_id).catch(error => {
          if (error instanceof AppError && (error.code === 'session_ended' || error.code === 'session_private')) return undefined;
          throw error;
        });
        if (own) context.agent_session_memory = own;
      }
```

Change line 273 from `prepared.request.context!.channel_memory = memory;` to:

```typescript
    if (memory) prepared.request.context!.channel_notes = memory;
```

The task's requester and installation owner have already passed `this.eligible(c, task)` in this transaction, so the channel membership rule from the spec holds.

- [ ] **Step 5: Build and run the tests**

Run: `pnpm --filter @space/contracts --filter @space/postgres build && cd tests && npx tsx --test integration/agent-memory.test.ts integration/connected-agent-access.test.ts contracts/*.test.ts`
Expected: PASS for all tests.

- [ ] **Step 6: Run the connector tests, which parse invocations**

Run: `pnpm --filter @space/connector test`
Expected: PASS. A failure means a connector fixture builds `context.channel_memory` with the old shape. Rename it to `channel_notes`.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/index.ts packages/contracts/foundation.ts packages/contracts/layered-memory.ts adapters/postgres/store.ts tests/integration/agent-memory.test.ts tests/integration/connected-agent-access.test.ts
git commit -m "Send layered memory in task context and rename channel notes"
```

---

### Task 7: Docs

**Files:**
- Modify: `docs/architecture/thread-working-memory.md`
- Modify: `docs/architecture/memory-mcp.md`

- [ ] **Step 1: Add a "Layered memory" section to `docs/architecture/thread-working-memory.md`**, after "Agent tools":

```markdown
## Layered memory

Short-term memory has three layers: channel → thread → session. Every node returns `ref`, `parent`, `summary`, `updated_at` and `children`, so agents can walk down and back up.

| Tool | Key | Returns |
| --- | --- | --- |
| `channel_memory` | Channel | Threads with a checkpoint in the last 7 days, newest first, keyset-paged by `next_cursor` |
| `thread_memory` | Channel | Checkpoint, recent messages (session messages excluded) and session nodes |
| `session_memory` | Channel, bound to the session's installation | Session checkpoint and recent session turns |
| `session_checkpoint` | Channel, contribute or write | New session revision |

`thread_checkpoint` and `session_checkpoint` require `summary` (1–280 characters). Content over 6,000 characters returns `413 checkpoint_too_large`. Writes are optimistic: a stale revision returns `409`, enforced by partial unique indexes and not by row locks. Tasks receive `context.agent_session_memory`, `context.working_memory` and the first page of `context.channel_memory`. The Markdown channel memory excerpt moved to `context.channel_notes`. Apply migration `085_layered_memory.sql`, and update paired connectors in the same release.
```

- [ ] **Step 2: In `docs/architecture/memory-mcp.md`**, add these four rows to the Tools table:

```markdown
| `channel_memory` | Read | Index of recent threads with summaries; `after` cursor, `limit` 1–50 |
| `thread_memory` | Read | One thread's checkpoint, recent messages and session list |
| `session_memory` | Read | Own session only (installation-bound key); others return `session_private` |
| `session_checkpoint` | Contribute/Write | Revision-checked session checkpoint with summary |
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/thread-working-memory.md docs/architecture/memory-mcp.md
git commit -m "Document layered short-term memory"
```

---

### Task 8: Full verification

- [ ] **Step 1: Typecheck and build**

Run: `pnpm typecheck && pnpm build`
Expected: both exit 0.

- [ ] **Step 2: Full test graph**

Run: `TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:5432/workplace_test pnpm turbo run test --concurrency=1`
Expected: every package passes, with no skipped or cancelled tests.

- [ ] **Step 3: Confirm no new locks**

Run: `grep -rn "FOR UPDATE\|FOR SHARE\|SKIP LOCKED\|pg_advisory" adapters/postgres/thread-context.ts adapters/postgres/layered-memory.ts`
Expected: no output.

---

---

## Automatic updates (Tasks 9–11)

Each agent turn ends with a hidden `<space-memory>` block in the agent's own answer, so no extra model call is needed. The connector hides the block from people and attaches it as `AgentResponse.memory`. When Space accepts `execution.completed`, it saves the block in the same transaction as the turn result. A conflicting save is kept in `memory_pending` and sent back to the agent in its next task context, so the agent can merge it.

### Task 9: Memory block contract

**Files:**
- Create: `packages/contracts/memory-block.ts`
- Modify: `packages/contracts/agent-response.ts`
- Modify: `packages/contracts/index.ts`
- Test: `tests/contracts/layered-memory.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/contracts/layered-memory.test.ts`:

```typescript
import { visibleText, extractMemoryBlock, parseAgentResponse } from '@space/contracts';

const block = '<space-memory>{"session":{"base_revision":2,"summary":"Step 3 fixed","content":"# Progress\\nStep 3 fixed"}}</space-memory>';

test('the memory block is hidden from people while streaming and when final', () => {
  assert.equal(visibleText(`Done.\n${block}`, true), 'Done.');
  assert.equal(visibleText('Done.\n<space-mem', false), 'Done.\n');
  assert.equal(visibleText('a < b', true), 'a < b');
  assert.equal(visibleText('a <', false), 'a ');
});

test('extractMemoryBlock parses a valid block and drops a bad one', () => {
  assert.deepEqual(extractMemoryBlock(`x ${block}`), { session: { base_revision: 2, summary: 'Step 3 fixed', content: '# Progress\nStep 3 fixed' } });
  assert.equal(extractMemoryBlock('<space-memory>{bad</space-memory>'), undefined);
  assert.equal(extractMemoryBlock('<space-memory>{"thread":{"base_revision":0,"summary":"","content":"x"}}</space-memory>'), undefined);
  assert.equal(extractMemoryBlock('no block'), undefined);
});

test('an invalid memory field never fails the whole response', () => {
  const response = parseAgentResponse({ messages: [], tools: [], components: [], memory: { session: { base_revision: -1, summary: 'x', content: 'y' } } });
  assert.equal(response.memory, undefined);
  const ok = parseAgentResponse({ messages: [], tools: [], components: [], memory: { thread: { base_revision: 0, summary: 's', content: 'c' } } });
  assert.equal(ok.memory?.thread?.summary, 's');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd tests && npx tsx --test contracts/layered-memory.test.ts`
Expected: FAIL with an import error for `visibleText`.

- [ ] **Step 3: Create `packages/contracts/memory-block.ts`**

```typescript
import { AppError, record } from './validation.js';
import { CHECKPOINT_LIMIT, SUMMARY_LIMIT } from './thread-context.js';

export interface AgentMemoryPart { base_revision: number; summary: string; content: string }
export interface AgentMemoryUpdate { session?: AgentMemoryPart; thread?: AgentMemoryPart }

const OPEN = '<space-memory>', CLOSE = '</space-memory>';

function parsePart(value: unknown): AgentMemoryPart {
  const p = record(value, ['base_revision', 'summary', 'content']);
  if (!Number.isSafeInteger(p.base_revision) || (p.base_revision as number) < 0) throw new AppError(400, 'invalid_memory_update');
  if (typeof p.summary !== 'string' || !p.summary.trim() || p.summary.trim().length > SUMMARY_LIMIT) throw new AppError(400, 'invalid_memory_update');
  if (typeof p.content !== 'string' || !p.content.trim() || p.content.trim().length > CHECKPOINT_LIMIT || p.content.includes('\0')) throw new AppError(400, 'invalid_memory_update');
  return { base_revision: p.base_revision as number, summary: p.summary.trim(), content: p.content.trim() };
}
export function parseAgentMemoryUpdate(value: unknown): AgentMemoryUpdate {
  const v = record(value, ['session', 'thread']);
  if (v.session === undefined && v.thread === undefined) throw new AppError(400, 'invalid_memory_update');
  return { ...(v.session === undefined ? {} : { session: parsePart(v.session) }), ...(v.thread === undefined ? {} : { thread: parsePart(v.thread) }) };
}

// While streaming, also hold back a trailing partial "<space-memory" so it never flashes on screen.
export function visibleText(raw: string, final: boolean): string {
  const at = raw.indexOf(OPEN);
  if (at >= 0) return raw.slice(0, at).trimEnd();
  if (!final) for (let k = Math.min(OPEN.length - 1, raw.length); k > 0; k--) if (OPEN.startsWith(raw.slice(-k))) return raw.slice(0, -k);
  return raw;
}
export function extractMemoryBlock(raw: string): AgentMemoryUpdate | undefined {
  const start = raw.indexOf(OPEN), end = start < 0 ? -1 : raw.indexOf(CLOSE, start);
  if (start < 0 || end < 0) return undefined;
  try { return parseAgentMemoryUpdate(JSON.parse(raw.slice(start + OPEN.length, end))); } catch { return undefined; }
}
```

Export it from `packages/contracts/index.ts` with `export * from './memory-block.js';`.

- [ ] **Step 4: Add `memory` to `AgentResponse`**

In `packages/contracts/agent-response.ts`, add the import `import { parseAgentMemoryUpdate, type AgentMemoryUpdate } from './memory-block.js';`, then add `memory?: AgentMemoryUpdate` to the `AgentResponse` type.

In `parseAgentResponse`, add `'memory'` to the `record(input, [...])` key list. Then, where the returned object is built, add:

```typescript
    ...(() => { if (v.memory === undefined) return {}; try { return { memory: parseAgentMemoryUpdate(v.memory) }; } catch { return {}; } })(),
```

A bad block is dropped. It never fails the whole turn.

- [ ] **Step 5: Build and run the tests**

Run: `pnpm --filter @space/contracts build && cd tests && npx tsx --test contracts/*.test.ts`
Expected: PASS for all tests.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/memory-block.ts packages/contracts/agent-response.ts packages/contracts/index.ts tests/contracts/layered-memory.test.ts
git commit -m "Add hidden turn-end memory block contract"
```

---

### Task 10: Save memory when a turn completes

**Files:**
- Create: `adapters/postgres/migrations/086_memory_pending.sql`
- Modify: `adapters/postgres/migrate.ts`
- Modify: `adapters/postgres/layered-memory.ts`
- Modify: `adapters/postgres/store.ts` (`acceptEvent`, `prepareDelivery`)
- Modify: `packages/contracts/index.ts`, `packages/contracts/foundation.ts`, `packages/contracts/layered-memory.ts`
- Test: `tests/integration/layered-memory.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/layered-memory.test.ts`:

```typescript
import { saveTurnMemory, readPendingMemory } from '@space/postgres/layered-memory';

test('turn-end memory saves both layers, keeps a conflict as pending, and clears it on the next save', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Start');
  const session = randomUUID();
  await pool.query(`INSERT INTO agent_sessions(id,workspace_id,installation_id,origin_thread_id,title) VALUES($1,$2,$3,$4,'Run')`, [session, a.workspace_id, a.installation_id, root.thread_id]);
  const base = { channelId: a.channel_id, threadId: root.thread_id, sessionId: session, installationId: a.installation_id, producer: { id: a.installation_id, name: 'Codex' } };
  const first = await saveTurnMemory(db(), { ...base, memory: { session: { base_revision: 0, summary: 'S1', content: 'session one' }, thread: { base_revision: 0, summary: 'T1', content: 'thread one' } } });
  assert.deepEqual(first, [{ scope: 'session', outcome: 'saved' }, { scope: 'thread', outcome: 'saved' }]);
  const stale = await saveTurnMemory(db(), { ...base, memory: { thread: { base_revision: 0, summary: 'T-stale', content: 'stale' } } });
  assert.deepEqual(stale, [{ scope: 'thread', outcome: 'pending' }]);
  const pending = await readPendingMemory(db(), a.installation_id, root.thread_id, session);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.current_revision, 1);
  assert.equal(pending[0]!.summary, 'T-stale');
  await saveTurnMemory(db(), { ...base, memory: { thread: { base_revision: 1, summary: 'T2', content: 'merged' } } });
  assert.equal((await readPendingMemory(db(), a.installation_id, root.thread_id, session)).length, 0);
  await pool.query(`UPDATE agent_sessions SET state='ended' WHERE id=$1`, [session]);
  assert.deepEqual(await saveTurnMemory(db(), { ...base, memory: { session: { base_revision: 1, summary: 'S2', content: 'late' } } }), [{ scope: 'session', outcome: 'skipped' }]);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd tests && npx tsx --test --test-name-pattern="turn-end" integration/layered-memory.test.ts`
Expected: FAIL with an import error for `saveTurnMemory`.

- [ ] **Step 3: Add migration 086**

Create `adapters/postgres/migrations/086_memory_pending.sql`:

```sql
-- One pending (conflicted) turn-end update per installation and scope. The latest one replaces an earlier one.
CREATE TABLE memory_pending (
  installation_id uuid NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
  scope_key text NOT NULL CHECK (scope_key ~ '^(thread|session):[0-9a-f-]{36}$'),
  base_revision integer NOT NULL CHECK (base_revision >= 0),
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 280),
  content text NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 6000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, scope_key)
);
```

Add `'086_memory_pending.sql'` after `'085_layered_memory.sql'` in `adapters/postgres/migrate.ts`.

- [ ] **Step 4: Add `saveTurnMemory` and `readPendingMemory` to `adapters/postgres/layered-memory.ts`**

Add `writeThreadCheckpoint` to the `./thread-context.js` import and `type AgentMemoryUpdate` to the contracts import. Then append:

```typescript
type TurnScope = 'session' | 'thread';
export type TurnMemoryOutcome = { scope: TurnScope; outcome: 'saved' | 'pending' | 'skipped' };

// Called inside the execution.completed transaction. It never throws for a bad or stale update,
// so memory problems cannot fail the agent's turn.
export async function saveTurnMemory(c: DbSession, input: { channelId: string; threadId: string; sessionId: string | null; installationId: string; producer: { id: string; name: string }; memory: AgentMemoryUpdate }): Promise<TurnMemoryOutcome[]> {
  const [last] = await rows<{ id: string; sequence: string }>(c, sql`SELECT id, sequence::text FROM messages WHERE channel_id=${input.channelId} AND thread_id=${input.threadId} ORDER BY sequence DESC LIMIT 1`);
  const results: TurnMemoryOutcome[] = [];
  for (const scope of ['session', 'thread'] as const) {
    const part = input.memory[scope];
    if (!part) continue;
    if (!last || (scope === 'session' && !input.sessionId)) { results.push({ scope, outcome: 'skipped' }); continue; }
    const key = scope === 'session' ? `session:${input.sessionId}` : `thread:${input.threadId}`;
    const checkpoint = { revision: part.base_revision, through_sequence: last.sequence, content: part.content, summary: part.summary, source_message_ids: [last.id] };
    try {
      if (scope === 'session') await writeSessionCheckpoint(c, input.channelId, input.sessionId!, input.installationId, checkpoint, input.producer);
      else await writeThreadCheckpoint(c, input.channelId, input.threadId, checkpoint, input.producer);
      await c.execute(sql`DELETE FROM memory_pending WHERE installation_id=${input.installationId} AND scope_key=${key}`);
      results.push({ scope, outcome: 'saved' });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      const conflict = error.code === 'thread_checkpoint_conflict' || error.code === 'session_checkpoint_conflict'
        || error.code === 'thread_checkpoint_watermark_conflict' || error.code === 'session_checkpoint_watermark_conflict';
      if (!conflict) { results.push({ scope, outcome: 'skipped' }); continue; }
      await c.execute(sql`INSERT INTO memory_pending(installation_id,scope_key,base_revision,summary,content)
        VALUES(${input.installationId},${key},${part.base_revision},${part.summary},${part.content})
        ON CONFLICT (installation_id, scope_key) DO UPDATE SET base_revision=EXCLUDED.base_revision, summary=EXCLUDED.summary, content=EXCLUDED.content, created_at=now()`);
      results.push({ scope, outcome: 'pending' });
    }
  }
  return results;
}

export interface PendingMemory { scope: TurnScope; base_revision: number; current_revision: number; summary: string; content: string }
export async function readPendingMemory(c: DbSession, installationId: string, threadId: string, sessionId: string | null): Promise<PendingMemory[]> {
  const keys = [`thread:${threadId}`, ...(sessionId ? [`session:${sessionId}`] : [])];
  return rows<PendingMemory>(c, sql`
    SELECT split_part(p.scope_key, ':', 1) AS scope, p.base_revision, p.summary, p.content,
      coalesce((SELECT max(cp.revision) FROM thread_checkpoints cp
        WHERE (p.scope_key = 'thread:' || cp.thread_id::text AND cp.session_id IS NULL) OR p.scope_key = 'session:' || cp.session_id::text), 0) AS current_revision
    FROM memory_pending p WHERE p.installation_id=${installationId} AND p.scope_key = ANY(${sql.param(keys)}::text[])
    ORDER BY p.scope_key`);
}
```

`writeThreadCheckpoint` and `writeSessionCheckpoint` throw `AppError` before any statement that could abort the transaction. Their inserts use `ON CONFLICT DO NOTHING`. So catching the error leaves the surrounding turn transaction usable.

- [ ] **Step 5: Hook into `acceptEvent` in `adapters/postgres/store.ts`**

Add `saveTurnMemory` and `readPendingMemory` to the `./layered-memory.js` import. Inside the `if (next === 'completed') {` block (after the line that appends `'task.completed'`), add:

```typescript
        const memory = event.payload.response?.memory;
        if (memory) {
          const [definition] = (await c.execute<{ name: string }>(sql`SELECT d.name FROM agent_installations i JOIN agent_definitions d ON d.id=i.definition_id WHERE i.id=${installationId}`)).rows;
          const outcomes = await saveTurnMemory(c, { channelId: thread.channel_id, threadId: task.thread_id, sessionId: task.session_id ?? null, installationId, producer: { id: installationId, name: definition?.name ?? 'Agent' }, memory });
          for (const { scope, outcome } of outcomes) traceTurn(c, task.id, 'memory', `${scope}:${outcome}`);
        }
```

Before using it, check `traceTurn`'s signature with `grep -n "function traceTurn" adapters/postgres/*.ts`. If its third argument is a closed union, add `'memory'` to that union.

- [ ] **Step 6: Return pending updates in the next task context**

In `packages/contracts/layered-memory.ts`, add:

```typescript
export interface MemoryConflict { scope: 'session' | 'thread'; base_revision: number; current_revision: number; summary: string; content: string }
export function parseMemoryConflicts(value: unknown): MemoryConflict[] {
  if (!Array.isArray(value) || value.length > 2) throw new AppError(400, 'invalid_memory_conflicts');
  return value.map(raw => {
    const v = record(raw, ['scope', 'base_revision', 'current_revision', 'summary', 'content']);
    if ((v.scope !== 'session' && v.scope !== 'thread') || !Number.isSafeInteger(v.base_revision) || !Number.isSafeInteger(v.current_revision)) throw new AppError(400, 'invalid_memory_conflicts');
    return { scope: v.scope, base_revision: v.base_revision as number, current_revision: v.current_revision as number, summary: text(v.summary, 280), content: text(v.content, 6000) };
  });
}
```

In `packages/contracts/index.ts`, add `memory_conflicts?:import('./layered-memory.js').MemoryConflict[]` to `InvocationRequest.context`. In `packages/contracts/foundation.ts`, add `'memory_conflicts'` to the context key list and add `...(ctx.memory_conflicts === undefined ? {} : { memory_conflicts: parseMemoryConflicts(ctx.memory_conflicts) }),` to the assembled context.

In `prepareDelivery` in `adapters/postgres/store.ts`, after the `agent_session_memory` lines from Task 6, add:

```typescript
      const conflicts = await readPendingMemory(c, task.installation_id, task.thread_id, task.session_id ?? null);
      if (conflicts.length) context.memory_conflicts = conflicts;
```

- [ ] **Step 7: Add an end-to-end assertion to the test from Step 1**

Before the `UPDATE agent_sessions SET state='ended'` line, add a check that the pending conflict reaches the task context. Use the `prepared(...)` helper pattern from `tests/integration/agent-memory.test.ts`:

```typescript
  await saveTurnMemory(db(), { ...base, memory: { thread: { base_revision: 0, summary: 'T-stale-2', content: 'stale again' } } });
  const pendingNow = await readPendingMemory(db(), a.installation_id, root.thread_id, session);
  assert.equal(pendingNow[0]!.scope, 'thread');
  assert.equal(pendingNow[0]!.current_revision, 2);
```

- [ ] **Step 8: Build and run the tests**

Run: `pnpm --filter @space/contracts --filter @space/postgres build && cd tests && npx tsx --test integration/layered-memory.test.ts integration/agent-memory.test.ts integration/tasks*.test.ts contracts/*.test.ts`
Expected: PASS for all tests. If `integration/tasks*.test.ts` matches no file, drop it and run `integration/task-flow.test.ts`.

- [ ] **Step 9: Commit**

```bash
git add adapters/postgres/migrations/086_memory_pending.sql adapters/postgres/migrate.ts adapters/postgres/layered-memory.ts adapters/postgres/store.ts packages/contracts/index.ts packages/contracts/foundation.ts packages/contracts/layered-memory.ts tests/integration/layered-memory.test.ts
git commit -m "Save agent memory automatically when a turn completes"
```

---

### Task 11: Connectors write and hide the block

**Files:**
- Create: `apps/connector/memory-instructions.ts`
- Modify: `apps/connector/agent-progress.ts:41-88` (`snapshot`)
- Modify: `apps/connector/claude.ts:124,152`, `apps/connector/codex.ts:135,292`, `apps/connector/kiro.ts:161,279`
- Test: `apps/connector/test/memory-block.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `apps/connector/test/memory-block.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentProgress } from '../dist/agent-progress.js';
import { memoryInstructions } from '../dist/memory-instructions.js';

const block = '<space-memory>{"thread":{"base_revision":1,"summary":"Fixed","content":"# Done\\nFixed"}}</space-memory>';

test('progress snapshots hide the block and attach memory only when terminal', () => {
  const progress = new AgentProgress();
  const streaming = progress.snapshot([{ id: 'm', text: `Fixed it.\n<space-mem`, status: 'streaming' }], false);
  assert.equal(streaming.messages[0].text, 'Fixed it.\n');
  assert.equal(streaming.memory, undefined);
  const final = progress.snapshot([{ id: 'm', text: `Fixed it.\n${block}`, status: 'complete' }], true);
  assert.equal(final.messages[0].text, 'Fixed it.');
  assert.equal(final.memory.thread.summary, 'Fixed');
});

test('instructions name the base revisions from the supplied context', () => {
  const text = memoryInstructions({ thread_id: 't', messages: [], working_memory: { checkpoint: { revision: 3 } }, agent_session_memory: { checkpoint: null } });
  assert.match(text, /<space-memory>/);
  assert.match(text, /thread base_revision 3/);
  assert.match(text, /session base_revision 0/);
  assert.equal(memoryInstructions(undefined), '');
});
```

Before running, check how `AgentProgress` is constructed: `grep -n "constructor" apps/connector/agent-progress.ts`. If it takes arguments, pass the same ones that `apps/connector/test/agent-progress.test.mjs` uses.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @space/connector build && node --test apps/connector/test/memory-block.test.mjs`
Expected: FAIL. `streaming.messages[0].text` still contains `<space-mem`.

- [ ] **Step 3: Create `apps/connector/memory-instructions.ts`**

```typescript
import type { InvocationRequest } from '@space/contracts';

type Context = InvocationRequest['context'] | { working_memory?: { checkpoint?: { revision: number } | null }; agent_session_memory?: { checkpoint?: { revision: number } | null } } | undefined;

// The block rides on the agent's own final answer, so saving memory costs no extra model call.
export function memoryInstructions(context: Context): string {
  if (!context) return '';
  const thread = context.working_memory?.checkpoint?.revision ?? 0;
  const session = context.agent_session_memory ? context.agent_session_memory.checkpoint?.revision ?? 0 : undefined;
  return `\n\nAfter your answer, add one hidden memory block. People never see it:\n<space-memory>{"thread":{"base_revision":N,"summary":"…","content":"…"}${session === undefined ? '' : ',"session":{"base_revision":N,"summary":"…","content":"…"}'}}</space-memory>\n`
    + `Use thread base_revision ${thread}${session === undefined ? '' : ` and session base_revision ${session}`}. `
    + 'Each content replaces the whole checkpoint: keep decisions, open questions and progress, drop finished items, at most 6000 characters. Each summary is one line of at most 280 characters. '
    + 'Leave out a layer that did not change. If memory_conflicts is present, merge it into your update.';
}
```

- [ ] **Step 4: Hide and extract in `AgentProgress.snapshot`**

In `apps/connector/agent-progress.ts`, add the import `import { visibleText, extractMemoryBlock } from '@space/contracts';`. At the start of `snapshot(messages, terminal = false)`, add:

```typescript
    const memory = terminal ? extractMemoryBlock(messages.map(m => m.text).join('\n\n')) : undefined;
    messages = messages.map(m => ({ ...m, text: visibleText(m.text, terminal) }));
```

Add `...(memory ? { memory } : {})` to the object passed to the first `parseAgentResponse({...})` call on line 46. The final `parseAgentResponse(snapshot)` on line 88 keeps the field.

- [ ] **Step 5: Hide the block in `payload.text` and add the instructions**

Add `import { visibleText } from '@space/contracts';` and `import { memoryInstructions } from './memory-instructions.js';` to each runtime.

| File | Line | Change |
| --- | --- | --- |
| `apps/connector/claude.ts` | 124 (`payload: { text: value, …`) | `text: visibleText(value, terminal)` |
| `apps/connector/claude.ts` | 152 (`const prompt = …`) | Append `${memoryInstructions(request.context)}` after `${request.goal}` |
| `apps/connector/codex.ts` | 135 (`payload: { text, …`) | `text: visibleText(text, terminal)` |
| `apps/connector/codex.ts` | 292 (`const prompt = …`) | Append `${memoryInstructions(request.context)}` after `${request.goal}` |
| `apps/connector/kiro.ts` | 161 (`text: detail,`) | `text: visibleText(detail, terminal),` |
| `apps/connector/kiro.ts` | 279 (`const content = …`) | Append `${memoryInstructions(request.context)}` after `${request.goal}` |

- [ ] **Step 6: Build and run all connector tests**

Run: `pnpm --filter @space/contracts --filter @space/connector build && pnpm --filter @space/connector test`
Expected: PASS for all tests. Tests that compare exact prompt text (for example in `apps/connector/test/kiro.test.mjs` or `claude.test.mjs`) need the instruction suffix added to the expected string whenever their fixture invocation has a `context`.

- [ ] **Step 7: Commit**

```bash
git add apps/connector/memory-instructions.ts apps/connector/agent-progress.ts apps/connector/claude.ts apps/connector/codex.ts apps/connector/kiro.ts apps/connector/test
git commit -m "Write turn-end memory from connectors and hide it from people"
```

- [ ] **Step 8: Run Task 8 (full verification) again**

---

## Spec coverage

| Spec requirement | Task |
| --- | --- |
| One table, `session_id`, `channel_id`, `summary`, partial unique indexes, backfill | 1 |
| Required summary 1–280, `413`, `400 invalid_summary` | 2, 3 |
| Optimistic writes, no locks | 3, 4, 8 |
| Channel index: 7 days, newest first, keyset paging, stable under writes | 4 |
| Thread memory excludes session messages and lists sessions without content | 3, 4 |
| Own-session access, `403 session_private`, ended sessions | 4, 5 |
| `404` for refs outside the channel | 4, 5 |
| New MCP tools on channel keys only | 5 |
| Membership rechecked per call | 5 (existing `store.connected`) |
| Task context layers and `channel_notes` rename | 6 |
| Tests 1–10 from the spec | 1 (8), 3 (1, 7), 4 (4, 6), 5 (2, 3, 5, 9), 6 (10) |
| Automatic turn-end updates, hidden block, no extra model call | 9, 11 |
| Saved in the turn transaction, conflicts kept as pending and sent back | 10 |
| Bad memory never fails a turn | 9 (parse), 10 (`saveTurnMemory`) |
