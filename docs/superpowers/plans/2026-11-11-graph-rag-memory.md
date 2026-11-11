# Graph RAG Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all three memory layers into one Graph RAG store (graph + per-message embeddings) in the knowledge database, fed by the existing CDC reader; merge the knowledge graph and the knowledge thread index into it; drop the agent-written memory; and add a local-model step that extracts topics and facts.

**Architecture:** The CDC reader (`graph-reader.mjs`, built earlier today) is extended to watch `messages` too. It hydrates text through Space views, embeds with Ollama `all-minilm:22m`, and upserts nodes, edges and vectors into `kb.m_*` with a `version` guard, LSN saved in the same transaction, ack after commit, debounced `graph.build_graph('space_memory')`. Memory reads walk `space_memory` and rank `kb_memory` with pgContext, then pass ids through `memory_visible_messages()` in Space. A separate worker subscription runs a local chat model per thread (debounced) to write topics and facts. Knowledge nodes join the same graph; `kb.g_*` and the old `kb.thread_messages` index are dropped after the new store builds once.

**Tech Stack:** Node 22 ESM `.mjs`, `pg`, `pg-logical-replication` 2.6.0, PostgreSQL 16 source, PostgreSQL 17 + pgGraph + pgContext knowledge DB, Ollama (`all-minilm:22m` embeddings; a chat model for extraction), `node --test`, drizzle raw SQL migrations.

**Spec:** `docs/superpowers/specs/2026-11-11-graph-rag-memory-design.md`

**Rules for every task** (`AGENTS.md`): no polling, no `SELECT FOR UPDATE`/advisory/table locks, no distributed locks, bounded batches and payloads. Work on `main`. Stage named files only; after each commit run `git show --stat HEAD`. Do not query CodeGraph right after an edit.

**Databases for tests** (as in `graph-smoke.mjs`): `TEST_DATABASE_URL` (Space test DB, `wal_level=logical`, REPLICATION role), `THREAD_INDEX_URL` (knowledge DB writer), `KNOWLEDGE_DATABASE_URL` (reader), `NATS_URL`/`TEST_NATS_URL` (JetStream). Start a throwaway pgGraph container from `space-knowledge-postgres:17-graph1.2.1-context0.3.0` and a JetStream NATS for local runs; remove them after.

`$KB` = `apps/mcp-gateway/providers/pg-knowledge`. The reader and its tests from the knowledge-graph plan already exist; this plan transforms them in place.

## Ordered phases

1. Space views and access function (migration 092).
2. Knowledge-DB schema: `kb.m_*`, graph `space_memory`, collections (`memory-graph.sql`).
3. Planner: write `kb.m_*`, message nodes, knowledge at message level.
4. Reader: watch `messages`, embed, hydrate through the union view.
5. Memory read path: `memory_visible_messages()` consumers and the three MCP readers.
6. Merge knowledge thread search and `filters.related` onto the new store.
7. Remove agent memory: block parts, tools, routes, writers; migration drop.
8. Extraction worker: topics and facts, with its own migration.
9. Cutover: drop `kb.g_*`, `space_knowledge`, `kb.thread_messages`; docs; rule check.

Each phase is one or more TDD tasks below.

---

### Task 1: Space views and `memory_visible_messages` (migration 092)

**Files:**
- Create: `adapters/postgres/migrations/092_graph_rag_memory.sql`
- Modify: `adapters/postgres/migrate.ts`
- Create: `tests/integration/graph-rag-memory.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
const schema = `graph_rag_${randomBytes(6).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

const post = async (token: string, channel: string, text: string, thread?: string) => {
  const r = await app.inject({ method: 'POST', url: `/v1/channels/${channel}/messages`, headers: { authorization: `Bearer ${token}` }, payload: { client_message_id: randomUUID(), text, ...(thread ? { thread_id: thread } : {}) } });
  assert.equal(r.statusCode, 201, r.body); return r.json();
};
const visible = async (w: string, requester: string, destination: string, ids: string[]) =>
  (await pool.query('SELECT id, body FROM memory_visible_messages($1,$2,$3,$4::uuid[])', [w, requester, destination, ids])).rows;

test('memory_source_messages excludes DMs, archived, memory-off, deleted; memory_visible_messages checks membership', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const m = await post(a.owner_token, a.channel_id, 'Hello world');
  assert.equal((await pool.query('SELECT 1 FROM memory_source_messages WHERE id=$1', [m.id])).rowCount, 0, 'off by default');
  await pool.query('UPDATE channels SET memory_enabled=true WHERE id=$1', [a.channel_id]);
  assert.equal((await pool.query('SELECT 1 FROM memory_source_messages WHERE id=$1', [m.id])).rowCount, 1);
  assert.deepEqual((await visible(a.workspace_id, a.owner_id, a.channel_id, [m.id])).map(r => r.id), [m.id]);
  assert.deepEqual(await visible(a.workspace_id, randomUUID(), a.channel_id, [m.id]), [], 'stranger');
  assert.deepEqual(await visible(b.workspace_id, b.owner_id, b.channel_id, [m.id]), [], 'other workspace');
  await app.inject({ method: 'DELETE', url: `/v1/channels/${a.channel_id}/messages/${m.id}`, headers: { authorization: `Bearer ${a.owner_token}` } });
  assert.deepEqual(await visible(a.workspace_id, a.owner_id, a.channel_id, [m.id]), [], 'deleted leaves the view');
});

test('graph_source_messages carries memory and knowledge flags', async () => {
  const a = await bootstrap(pool);
  const m = await post(a.owner_token, a.channel_id, 'Flagged');
  await pool.query('UPDATE channels SET memory_enabled=true WHERE id=$1', [a.channel_id]);
  await pool.query('INSERT INTO knowledge_thread_channels(workspace_id,channel_id) VALUES($1,$2)', [a.workspace_id, a.channel_id]);
  const [row] = (await pool.query('SELECT memory, knowledge FROM graph_source_messages WHERE id=$1', [m.id])).rows;
  assert.deepEqual([row.memory, row.knowledge], [true, true]);
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `cd tests && npx tsx --test integration/graph-rag-memory.test.ts`
Expected: FAIL — `relation "memory_source_messages" does not exist`.

- [ ] **Step 3: Write migration 092**

```sql
-- Graph RAG memory: Space views and access, removal of agent-written memory.
-- Source of message text for memory. Includes agent replies and session turns.
CREATE VIEW memory_source_messages WITH (security_barrier=true) AS
  SELECT m.id, m.workspace_id, m.channel_id, m.thread_id, m.agent_session_id,
         coalesce(m.user_id, m.installation_id) AS author_id, m.author_type,
         m.sequence, m.search_revision, m.created_at, left(m.text, 8000) AS body
  FROM channels c JOIN messages m ON m.channel_id = c.id
  WHERE c.kind = 'channel' AND c.archived_at IS NULL AND c.memory_enabled
    AND m.deleted_at IS NULL AND m.retained_at IS NULL AND btrim(m.text) <> '';

-- Union feeding the one message index. memory: for memory readers. knowledge: human messages of thread-search channels.
CREATE VIEW graph_source_messages WITH (security_barrier=true) AS
  SELECT m.id, m.workspace_id, m.channel_id, m.thread_id, m.agent_session_id,
         coalesce(m.user_id, m.installation_id) AS author_id, m.author_type,
         m.sequence, m.search_revision, m.created_at, left(m.text, 8000) AS body,
         c.memory_enabled AS memory,
         (k.channel_id IS NOT NULL AND m.author_type = 'human' AND m.agent_session_id IS NULL) AS knowledge
  FROM channels c JOIN messages m ON m.channel_id = c.id
  LEFT JOIN knowledge_thread_channels k ON k.channel_id = c.id AND k.workspace_id = c.workspace_id
  WHERE c.kind = 'channel' AND c.archived_at IS NULL
    AND m.deleted_at IS NULL AND m.retained_at IS NULL AND btrim(m.text) <> ''
    AND (c.memory_enabled OR k.channel_id IS NOT NULL);

-- Same audience rule as knowledge_visible_messages(), over memory_source_messages, destination channel only.
CREATE FUNCTION memory_visible_messages(w uuid, requester uuid, destination uuid, ids uuid[])
 RETURNS TABLE(id uuid, channel_id uuid, thread_id uuid, agent_session_id uuid, author_id uuid, author_type text, body text, sequence bigint, search_revision bigint, created_at timestamptz)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
 SELECT m.id, m.channel_id, m.thread_id, m.agent_session_id, m.author_id, m.author_type, m.body, m.sequence, m.search_revision, m.created_at
 FROM memory_source_messages m JOIN channels dest ON dest.id = destination AND dest.workspace_id = w
 WHERE m.workspace_id = w AND m.channel_id = destination AND m.id = ANY(ids) AND cardinality(ids) <= 128
 AND EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w AND wm.user_id = requester AND wm.active)
 AND EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id = destination AND cm.user_id = requester)
$$;
REVOKE ALL ON FUNCTION memory_visible_messages(uuid,uuid,uuid,uuid[]) FROM PUBLIC;
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION memory_visible_messages(uuid,uuid,uuid,uuid[]) SET search_path=pg_catalog,%I,pg_temp', current_schema());
END $$;

```

The old memory tables stay until Task 7 removes the code that uses them, so every commit before Task 7 still compiles and passes.

- [ ] **Step 4: Register the migration**

Edit `adapters/postgres/migrate.ts`: append `'092_graph_rag_memory.sql'` to `migrationFiles`.

- [ ] **Step 5: Build and run**

Run: `pnpm --filter @space/postgres build`
Run: `cd tests && npx tsx --test integration/graph-rag-memory.test.ts`
Expected: both tests pass.

Note: `memory_visible_messages` returns a destination-only set, so the private/guest cross-channel clauses from `knowledge_visible_messages()` are unnecessary here — memory never crosses channels. Keep it this way.

- [ ] **Step 6: Commit**

```bash
git add adapters/postgres/migrations/092_graph_rag_memory.sql adapters/postgres/migrate.ts tests/integration/graph-rag-memory.test.ts
git commit -m "feat(memory): Space views and access for Graph RAG memory; drop agent memory tables"
git show --stat HEAD
```

This migration only adds views and a function, so the tree still compiles.

---

### Task 2: Knowledge-DB schema `memory-graph.sql`

**Files:**
- Create: `$KB/memory-graph.sql`

- [ ] **Step 1: Write it** — the `kb.m_*` tables, graph `space_memory`, collections `kb_memory` (messages) and `kb_memory_facts` (facts). Columns exactly as the spec "Graph model" and "Knowledge tables" and "Graph additions" tables list them. Mirror the style of `$KB/graph.sql` (grants to `space_knowledge_reader`, `graph.create_graph`, `graph.add_table_to_graph`, `graph.add_edge_to_graph`, `graph.grant_graph`, trailing `graph.build_graph('space_memory', true)`).

Node tables: `m_channels, m_threads, m_sessions, m_people, m_messages, m_session_turns, m_topics, m_thread_topics, m_facts, m_fact_evidence, m_knowledge, m_knowledge_evidence`, plus `graph_position` (reuse the one from `graph.sql` if Task 9 keeps that file; otherwise create it here). Vectors: register `embedding` on `kb_memory` (over `kb.m_messages`) and on `kb_memory_facts` (over `kb.m_facts`), both 384 cosine, with `body`/`text` as lexical source.

Edges exactly as the spec "Relations after the merge" table.

- [ ] **Step 2: Apply on a throwaway container and verify** — after `schema.sql` and `threads.sql`, `graph.sql` must NOT be required. Apply `schema.sql`, then `memory-graph.sql`. Expect a `build_graph` row and all `kb.m_*` tables. Verify the PG006 serialization: insert one row per table, run `build_graph` in a separate `psql -c`, delete the channel, confirm cascade — exactly the probe used in the knowledge-graph Task 1.

- [ ] **Step 3: Commit** `memory-graph.sql`.

---

### Task 3: Planner writes `kb.m_*` (transform `graph-plan.mjs`)

**Files:**
- Modify: `$KB/graph-plan.test.mjs`
- Modify: `$KB/graph-plan.mjs`

- [ ] **Step 1: Update the tests first.** Rename table expectations `kb.g_*` → `kb.m_*`. Add `messages` and `agent_sessions` and `people` cases:
  - A `messages` insert in a channel thread plans: channel stub, thread stub, person stub, a guarded `kb.m_messages` upsert (without the embedding — the reader adds it), a session-turn link when `agent_session_id` is set, and nothing for a DM.
  - A `knowledge_notes` insert plans `kb.m_knowledge` plus `kb.m_knowledge_evidence` rows keyed by `message_id` (not thread), each carrying its `thread_id`.
  - Keep the `version` guard assertions.
  Provide the full new test bodies (no "similar to"): cover insert, update, delete, DM-skip, replay-safety shape for each of messages, sessions, knowledge.

- [ ] **Step 2: Run, expect failure** (`kb.m_messages` not produced).

- [ ] **Step 3: Rewrite `graph-plan.mjs`.** Add `messages` and keep `channels`, `knowledge_notes`, `agent_sessions`. `TABLES = ['channels','messages','agent_sessions','knowledge_notes']`. A message change plans person + message upserts and a session-turn link; the reader fills `embedding` in a second pass, so the planner emits the row without it and a companion op list of `{ id, body }` to embed (return `{ ops, embed }` from `planChange`, or a separate `messagesToEmbed(change)` helper — pick one and use it consistently in Task 4). Knowledge evidence becomes message-level.

- [ ] **Step 4: Run, expect pass.** `node --test $KB/graph-plan.test.mjs`.

- [ ] **Step 5: Commit.**

---

### Task 4: Reader watches messages and embeds (transform `graph-reader.mjs`, `graph-source.mjs`, `graph-apply.mjs`)

**Files:**
- Modify: `$KB/graph-source.mjs` — snapshot reads `graph_source_messages` (channels, sessions, messages, knowledge) in dependency order; add `embed(bodies)` (Ollama, batch 32, reused from `thread-worker.mjs`).
- Modify: `$KB/graph-apply.mjs` — `applyOps` also writes message embeddings via `pgcontext.upsert_points('kb_memory', ids)` after the row upserts, inside the same transaction; `publish` builds `space_memory`; `rebuild` clears `kb.m_channels` and streams the snapshot with embeddings per page.
- Modify: `$KB/graph-reader.mjs` — publication adds `messages (id, workspace_id, channel_id, thread_id, agent_session_id, author_type, user_id, installation_id, search_revision, deleted_at)`; on a message change, hydrate its body through `memory_source_messages` (or `graph_source_messages` when only the knowledge flag applies) before embedding; slot name `space_memory_<schema>`.

- [ ] Transform `graph-smoke.mjs` into `memory-smoke.mjs` style assertions: a message in a memory-on channel appears in `kb.m_messages` with a non-null embedding; an edit re-embeds; a delete removes the row and its point; replay/version/rebuild as before; a DM/archived/memory-off channel indexes nothing; a session message creates a `kb.m_session_turns` row.
- [ ] Each step: write/adjust the smoke assertion, run the reader against the throwaway DBs + NATS, fix, commit. Keep the PG006 in-process `serial()` queue.

---

### Task 5: Memory read path

**Files:**
- Modify: `adapters/postgres/layered-memory.ts` — `readChannelMemory`, `readThreadMemory`, `readSessionMemory` query the knowledge DB graph for candidate message ids (via a new `$KB`-side search module exposed to the server, or a direct pooled query from the server to the knowledge DB — follow how `apps/mcp-gateway` already reaches the knowledge DB), then call `memory_visible_messages()` in Space and assemble the result. Keep the return contracts (`ChannelMemoryPage`, `ThreadMemory`, `SessionMemory`) so the UI and MCP shapes do not change beyond field meaning.
- Modify: `packages/contracts/thread-context.ts` — remove the `memory` field from `ThreadContext`; `readThreadContext` returns root + recent only.
- Modify: `tests/integration/layered-memory.test.ts`, `tests/integration/memory-mcp.test.ts`, `tests/integration/memory-graph.test.ts` — rewrite around reads (no saves). This is the largest test rewrite; do it assertion-by-assertion with the DBs up.

Each sub-step is TDD: write the new read assertion, run, implement, run, commit. Because reads now cross two databases, the integration tests need `KNOWLEDGE_DATABASE_URL`/`THREAD_INDEX_URL` and a running reader; gate these tests on those env vars like `graph-smoke.mjs` does, and keep a pure-contract test for the assembly logic that fakes the knowledge-DB query.

---

### Task 6: Merge knowledge thread search and related

**Files:**
- Modify: `$KB/thread-search.mjs` — rank `kb_memory`, walk `in_thread` in `space_memory`, keep `knowledge_visible_messages()`. `filters.source=threads|files` unchanged for agents.
- Modify: `$KB/graph-related.mjs` — read `kb.m_knowledge_evidence`; rank related knowledge by shared messages then shared threads.
- Modify: `$KB/server.mjs` — detection reads `kb.m_knowledge_evidence`; `filters.related` unchanged.
- Modify: `$KB/markdown.sql` + `markdown-files.mjs` — repoint Markdown passages from `kb.threads`/`kb_threads`/`space_threads` to `kb.m_threads`/`kb_memory`/`space_memory` (the spec's file-search risk). Do this before Task 9 drops the old objects.
- Modify: `$KB/thread-worker.mjs` — stop indexing thread messages and remove its `pg_notify` message path; keep Markdown files and `kb.notes`.

TDD via `notes-smoke.mjs` and a thread-search smoke run.

---

### Task 7: Remove agent memory (TypeScript)

**Files:**
- Modify: `packages/contracts/memory-block.ts` — drop `thread`/`session` parts of `AgentMemoryUpdate`; keep `notes`. Update `apps/connector/memory-instructions.ts` and its test so the block prompt only asks for `notes`.
- Modify: `apps/server/memory-mcp.ts` — remove `thread_memory_save`, `session_memory_save`.
- Modify: `apps/server/memory.ts`, `apps/web/src/features/memory/MemoryInspector.tsx`, `memory-api.ts` — remove person edit routes and the editor; the Memory UI becomes read-only.
- Modify: `adapters/postgres/layered-memory.ts`, `thread-context.ts`, `store.ts`, `packages/contracts/foundation.ts` — delete `saveTurnMemory`, `readPendingMemory`, `writeThreadMemory`, `writeSessionMemory`, the `ForPerson` variants, `memory_conflicts`, and the `saveTurnMemory` call in `store.ts`.
- Modify tests accordingly.

- [ ] Create `adapters/postgres/migrations/093_drop_agent_memory.sql` and register it in `migrate.ts`. Take a database backup first; this is the only undo.

```sql
DROP FUNCTION IF EXISTS memory_visible_summaries(uuid,uuid,uuid,uuid[]);
DROP TRIGGER IF EXISTS memory_revisions_update ON memory_revisions;
DROP FUNCTION IF EXISTS enqueue_memory_update();
DROP TABLE IF EXISTS memory_pending;
DROP TABLE IF EXISTS memory_revisions;
```

- [ ] Delete `tests/integration/memory-summaries.test.ts` (it tests the dropped function).
- [ ] Run `pnpm typecheck` → 27 tasks pass. Run the memory and connector tests. Commit.

---

### Task 8: Extraction worker (topics and facts)

**Files:**
- Create: `adapters/postgres/migrations/094_memory_extract.sql` — `memory_extract_threads`, `memory_extract_budget`, the message trigger that bumps `available_at` for memory-on channel threads, and `event_outbox` enqueue of `memory.extract.ready`. Register in `migrate.ts`.
- Create: `$KB/extract.sql` — the `kb.m_topics`, `kb.m_thread_topics`, `kb.m_facts`, `kb.m_fact_evidence` tables and the `kb_memory_facts` collection, if not already in `memory-graph.sql` (keep them in `memory-graph.sql`; this file only exists if you split it — prefer one schema file).
- Create: `apps/mcp-gateway/providers/pg-knowledge/extract-worker.mjs` — a worker that subscribes to `memory.extract.ready.*` through `@space/events` `EventBus` (mirror `apps/worker/main.ts`: durable, queue group, `handle(...)` with `retry(delay)`), reads messages after `done_through` from `memory_source_messages`, takes a budget unit, calls the model via a provider mirrored on `reply-suggestion.ts` (env `MEMORY_EXTRACT_MODEL`, Ollama chat endpoint; optional xAI), parses with the Knowledge note rules, writes topics/facts/evidence to the knowledge DB with the `extract_version` guard, then moves `done_through`.
- Create: `apps/mcp-gateway/providers/pg-knowledge/extract.test.mjs` — fake model; cover all "Tests for this step" bullets from the spec.

TDD per bullet. Model calls faked. One manual Ollama run recorded.

---

### Task 9: Cutover, docs, rule check

**Files:**
- Create: `$KB/drop-knowledge-graph.sql` — guarded: only drops `kb.g_*`, `space_knowledge` and the old `kb.thread_messages`/`kb_threads`/`space_threads` when `SELECT published_lsn > '0/0' FROM kb.graph_position` is true. Delete `$KB/graph.sql` and the old `threads.sql` graph objects after this runs in each environment.
- Modify: `$KB/README.md` — one store, one reader, the extraction worker, the Ollama models, the drop step.
- Modify: `docs/architecture/channel-memory.md`, `memory-mcp.md`, `thread-working-memory.md` — memory is now Graph RAG; no agent notes; three read-only layers plus topics and facts.

- [ ] Rule check: `grep -nE "FOR UPDATE|FOR SHARE|SKIP LOCKED|advisory|LOCK TABLE|setInterval" $KB/*.mjs apps/mcp-gateway/providers/pg-knowledge/*.sql` → empty. `grep -n setTimeout $KB/graph-reader.mjs $KB/extract-worker.mjs` → only debounce lines.
- [ ] Full gate: `pnpm typecheck`, `pnpm --filter @space/web exec vitest run src/features/memory`, the knowledge-DB smokes (`memory-smoke`, `notes-smoke`, `extract.test`), and the memory integration tests with all env vars set. Record pass counts.
- [ ] Commit docs and the drop script.

## Self-review against the spec

| Spec section | Task |
| --- | --- |
| Why Graph RAG; retrieve flow | 5 |
| `memory_source_messages`, access check | 1 |
| Graph model `kb.m_*`, collections | 2 |
| CDC writes messages, embeddings, version guard, rebuild | 3, 4 |
| Reading the three layers with live access | 5 |
| Merging the thread index; file-search risk | 6 |
| What is removed; migration 092 | 1, 7 |
| Model step: tables, worker, debounce, caps, access on derived text | 8 |
| Knowledge in the same graph; drop old graph | 2, 3, 6, 9 |
| Tests (store, reads, extraction) | 4, 5, 8 |

Not covered by automated tests, run by hand and record before any performance claim: the 50,000-message first build, the lost-slot rebuild, and extraction cost per run.

**Sequencing.** The destructive migration (093) runs only in Task 7, after the code that reads the old tables is gone. Until then agents still write the old memory, so Tasks 1–6 can ship without data loss.

**Detail level.** Task 1 is fully coded. Tasks 2–9 give exact files, the contract each change must meet and the assertions to write, but not every line of code, because Tasks 3–5 depend on what the reader looks like after Task 4. Expand each task into step-level code before starting it.
