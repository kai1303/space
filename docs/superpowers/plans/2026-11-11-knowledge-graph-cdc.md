# Knowledge Graph From CDC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reader service turns committed Space changes (logical replication) into a knowledge graph in the knowledge database, and agents can ask for knowledge related to one they found.

**Architecture:** A `pgoutput` publication on `knowledge_notes`, `channels` and `agent_sessions` feeds a slot. `graph-reader.mjs` plans each change into guarded SQL (`graph-plan.mjs`), applies a batch and its LSN in one graph transaction (`graph-apply.mjs`), then confirms the LSN to the slot. Nodes are one table each (`kb.g_*`), edges are foreign keys, and a debounced `graph.build_graph` publishes the pgGraph graph `space_knowledge`. Related knowledge is a `knowledge_search` filter that joins `kb.g_evidence` and re-checks access with `knowledge_visible_notes()`.

**Tech Stack:** Node 22 ESM (`.mjs`, like the sibling provider files), `pg`, `pg-logical-replication` 2.6.0 (already used by `apps/events/bridge.ts`), PostgreSQL 16 source (column-list publications) and PostgreSQL 17 + pgGraph + pgContext for the knowledge database, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-11-knowledge-graph-cdc-design.md`

**Rules for every task** (from `AGENTS.md`): no polling, no `SELECT FOR UPDATE`/advisory/table locks, no distributed locks, bounded batches. Work on `main`. Stage named files only, because other changes sit in the working tree. After each commit run `git show --stat HEAD` and check it holds exactly the files you staged.

All new files live in `apps/mcp-gateway/providers/pg-knowledge/` unless a path says otherwise. Call that folder `$KB`.

## File structure

| File | Job |
| --- | --- |
| `$KB/graph.sql` | Graph tables, position table, pgGraph graph |
| `$KB/graph-plan.mjs` | Pure: LSN to version, one change to guarded SQL ops |
| `$KB/graph-plan.test.mjs` | Unit tests for the planner |
| `$KB/graph-source.mjs` | Space lookups (message to thread) and the snapshot reader |
| `$KB/graph-apply.mjs` | Run ops plus position in one transaction, publish, rebuild |
| `$KB/graph-reader.mjs` | The service: slot, publication, stream, ack, debounce |
| `$KB/graph-related.mjs` | Related-knowledge query with live access check |
| `$KB/graph-smoke.mjs` | End-to-end check against disposable databases |
| `$KB/notes-search.mjs` | Modify: export `noteHit` |
| `$KB/server.mjs` | Modify: `filters.related` |
| `$KB/README.md` | Modify: how to run the reader |
| `apps/mcp-gateway/package.json` | Modify: add `pg-logical-replication` |

---

### Task 1: Graph schema

**Files:**
- Create: `$KB/graph.sql`

- [ ] **Step 1: Write the schema**

```sql
-- Apply once after schema.sql, as the owner of schema kb. Graph metadata holds source identifiers only.
BEGIN;
CREATE TABLE kb.g_channels (
  id text PRIMARY KEY, workspace_id uuid NOT NULL, name text NOT NULL,
  is_private boolean NOT NULL, enabled boolean NOT NULL DEFAULT false, version bigint NOT NULL
);
CREATE TABLE kb.g_threads (
  id text PRIMARY KEY, workspace_id uuid NOT NULL,
  channel_id text NOT NULL REFERENCES kb.g_channels(id) ON DELETE CASCADE, version bigint NOT NULL
);
CREATE TABLE kb.g_sessions (
  id text PRIMARY KEY, workspace_id uuid NOT NULL,
  thread_id text NOT NULL REFERENCES kb.g_threads(id) ON DELETE CASCADE,
  title text NOT NULL, state text NOT NULL, version bigint NOT NULL
);
CREATE TABLE kb.g_knowledge (
  id text PRIMARY KEY, workspace_id uuid NOT NULL,
  channel_id text NOT NULL REFERENCES kb.g_channels(id) ON DELETE CASCADE,
  kind text NOT NULL, title text NOT NULL, revision integer NOT NULL, version bigint NOT NULL
);
CREATE TABLE kb.g_evidence (
  id text PRIMARY KEY, workspace_id uuid NOT NULL,
  knowledge_id text NOT NULL REFERENCES kb.g_knowledge(id) ON DELETE CASCADE,
  thread_id text NOT NULL REFERENCES kb.g_threads(id) ON DELETE CASCADE
);
CREATE INDEX ON kb.g_threads(channel_id);
CREATE INDEX ON kb.g_sessions(thread_id);
CREATE INDEX ON kb.g_knowledge(workspace_id, channel_id);
CREATE INDEX ON kb.g_evidence(thread_id);
CREATE INDEX ON kb.g_evidence(knowledge_id);
-- lsn: last transaction applied. published_lsn: last position the pgGraph graph was built at.
CREATE TABLE kb.graph_position (
  slot text PRIMARY KEY, lsn pg_lsn NOT NULL, published_lsn pg_lsn NOT NULL DEFAULT '0/0'
);
GRANT SELECT ON kb.g_channels, kb.g_threads, kb.g_sessions, kb.g_knowledge, kb.g_evidence TO space_knowledge_reader;
SELECT graph.create_graph('space_knowledge');
SELECT graph.add_table_to_graph('space_knowledge','kb.g_channels'::regclass,'id',ARRAY['id']);
SELECT graph.add_table_to_graph('space_knowledge','kb.g_threads'::regclass,'id',ARRAY['id']);
SELECT graph.add_table_to_graph('space_knowledge','kb.g_sessions'::regclass,'id',ARRAY['id']);
SELECT graph.add_table_to_graph('space_knowledge','kb.g_knowledge'::regclass,'id',ARRAY['id']);
SELECT graph.add_table_to_graph('space_knowledge','kb.g_evidence'::regclass,'id',ARRAY['id']);
SELECT graph.add_edge_to_graph('space_knowledge','kb.g_threads'::regclass,'channel_id','kb.g_channels'::regclass,'id',
  label := 'in_channel', bidirectional := false);
SELECT graph.add_edge_to_graph('space_knowledge','kb.g_sessions'::regclass,'thread_id','kb.g_threads'::regclass,'id',
  label := 'of_thread', bidirectional := false);
SELECT graph.add_edge_to_graph('space_knowledge','kb.g_knowledge'::regclass,'channel_id','kb.g_channels'::regclass,'id',
  label := 'in_channel', bidirectional := false);
SELECT graph.add_edge_to_graph('space_knowledge','kb.g_evidence'::regclass,'knowledge_id','kb.g_knowledge'::regclass,'id',
  label := 'supports', bidirectional := false);
SELECT graph.add_edge_to_graph('space_knowledge','kb.g_evidence'::regclass,'thread_id','kb.g_threads'::regclass,'id',
  label := 'from_thread', bidirectional := false);
SELECT graph.grant_graph('space_knowledge','space_knowledge_reader','read');
COMMIT;
SELECT * FROM graph.build_graph('space_knowledge', true);
```

- [ ] **Step 2: Apply it to a disposable knowledge database and check**

The `THREAD_INDEX_URL` database already has `schema.sql` and `threads.sql` (see the header of `notes-smoke.mjs`).

Run: `psql "$THREAD_INDEX_URL" -v ON_ERROR_STOP=1 -f apps/mcp-gateway/providers/pg-knowledge/graph.sql`
Expected: ends with a `build_graph` result row and no error.

Run: `psql "$THREAD_INDEX_URL" -c "\dt kb.g_*"`
Expected: five tables listed.

- [ ] **Step 3: Commit**

```bash
git add apps/mcp-gateway/providers/pg-knowledge/graph.sql
git commit -m "feat(knowledge): graph tables and pgGraph graph for CDC"
git show --stat HEAD
```

---

### Task 2: Planner (pure, test first)

**Files:**
- Create: `$KB/graph-plan.test.mjs`
- Create: `$KB/graph-plan.mjs`

A *change* is `{ table, op, row, lsn }`. `table` is `channels`, `knowledge_notes` or `agent_sessions`. `op` is `insert`, `update` or `delete`. For `delete`, `row` is the old key row and may hold only `id`. `lookup` has two async functions that return a `Map`:
- `threadsOf(workspaceId, messageIds)`: message id to `{ message, thread, channel, kind }`.
- `channelsOfThreads(workspaceId, threadIds)`: thread id to `{ thread, channel, kind }`.

An *op* is `{ text, values }`.

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { lsnToVersion, planChange } from './graph-plan.mjs';

const ws = '11111111-1111-4111-8111-111111111111';
const lookup = {
  threadsOf: async () => new Map([
    ['m1', { message: 'm1', thread: 't1', channel: 'c1', kind: 'channel' }],
    ['m2', { message: 'm2', thread: 't2', channel: 'c2', kind: 'channel' }],
  ]),
  channelsOfThreads: async () => new Map([
    ['t1', { thread: 't1', channel: 'c1', kind: 'channel' }],
    ['td', { thread: 'td', channel: 'cd', kind: 'direct' }],
  ]),
};
const note = (extra = {}) => ({ id: 'k1', workspace_id: ws, channel_id: 'c1', kind: 'fact', title: 'T', evidence: ['m1', 'm2'], revision: 3, removed_at: null, ...extra });

test('lsnToVersion turns an LSN into a number that grows with the log', () => {
  assert.equal(lsnToVersion('0/16B3748'), 0x16B3748n);
  assert.equal(lsnToVersion('1/0'), 1n << 32n);
  assert.ok(lsnToVersion('1/0') > lsnToVersion('0/FFFFFFFF'));
  assert.throws(() => lsnToVersion('nope'));
});

test('a knowledge insert writes a guarded upsert and only evidence from its own channel', async () => {
  const ops = await planChange({ table: 'knowledge_notes', op: 'insert', row: note() }, 50n, lookup);
  const upsert = ops.find(o => o.text.includes('INSERT INTO kb.g_knowledge'));
  assert.match(upsert.text, /WHERE kb\.g_knowledge\.version<EXCLUDED\.version/);
  assert.deepEqual(upsert.values.slice(0, 6), ['k1', ws, 'c1', 'fact', 'T', 3]);
  assert.equal(upsert.values[6], '50');
  const evidence = ops.find(o => o.text.includes('INSERT INTO kb.g_evidence'));
  assert.deepEqual(evidence.values[2], ['t1'], 'm2 belongs to another channel and is dropped');
  const stubs = ops.filter(o => o.text.includes('INSERT INTO kb.g_channels') || o.text.includes('INSERT INTO kb.g_threads'));
  assert.equal(stubs.length, 2, 'the channel and thread exist before the knowledge points at them');
  assert.ok(ops.indexOf(stubs[0]) < ops.indexOf(upsert));
});

test('evidence arrives as text in a Postgres array literal too', async () => {
  const ops = await planChange({ table: 'knowledge_notes', op: 'insert', row: note({ evidence: '{m1}' }) }, 5n, lookup);
  assert.deepEqual(ops.find(o => o.text.includes('INSERT INTO kb.g_evidence')).values[2], ['t1']);
});

test('evidence rows are only touched when this change won the version check', async () => {
  const ops = await planChange({ table: 'knowledge_notes', op: 'update', row: note() }, 9n, lookup);
  for (const o of ops.filter(o => o.text.includes('g_evidence'))) assert.match(o.text, /version=\$\d+::bigint/);
});

test('a removed knowledge becomes one guarded delete', async () => {
  const ops = await planChange({ table: 'knowledge_notes', op: 'update', row: note({ removed_at: new Date() }) }, 7n, lookup);
  assert.equal(ops.length, 1);
  assert.match(ops[0].text, /DELETE FROM kb\.g_knowledge WHERE id=\$1::text AND version<=\$2::bigint/);
  assert.deepEqual(ops[0].values, ['k1', '7']);
});

test('a delete change uses the key row alone', async () => {
  const ops = await planChange({ table: 'knowledge_notes', op: 'delete', row: { id: 'k1' } }, 8n, lookup);
  assert.deepEqual(ops.map(o => o.values), [['k1', '8']]);
});

test('direct-message channels never enter the graph', async () => {
  const dm = { id: 'cd', workspace_id: ws, name: '', private: true, kind: 'direct', knowledge_enabled: false };
  assert.deepEqual(await planChange({ table: 'channels', op: 'insert', row: dm }, 4n, lookup), []);
});

test('a channel row is a guarded upsert', async () => {
  const row = { id: 'c1', workspace_id: ws, name: 'general', private: false, kind: 'channel', knowledge_enabled: true };
  const [op] = await planChange({ table: 'channels', op: 'update', row }, 6n, lookup);
  assert.match(op.text, /WHERE kb\.g_channels\.version<EXCLUDED\.version/);
  assert.deepEqual(op.values, ['c1', ws, 'general', false, true, '6']);
});

test('a session in a direct-message thread is skipped, one in a channel thread is kept', async () => {
  const base = { id: 's1', workspace_id: ws, title: 'Run', state: 'active' };
  assert.deepEqual(await planChange({ table: 'agent_sessions', op: 'insert', row: { ...base, origin_thread_id: 'td' } }, 3n, lookup), []);
  const ops = await planChange({ table: 'agent_sessions', op: 'insert', row: { ...base, origin_thread_id: 't1' } }, 3n, lookup);
  assert.ok(ops.some(o => o.text.includes('INSERT INTO kb.g_sessions') && o.text.includes('kb.g_sessions.version<EXCLUDED.version')));
});

test('other tables are ignored', async () => {
  assert.deepEqual(await planChange({ table: 'messages', op: 'insert', row: {} }, 1n, lookup), []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test apps/mcp-gateway/providers/pg-knowledge/graph-plan.test.mjs`
Expected: FAIL, cannot find module `./graph-plan.mjs`.

- [ ] **Step 3: Write the planner**

```js
// Turns one committed Space change into guarded SQL for the knowledge graph. Pure apart from `lookup`.
// Each write is idempotent: a row is replaced only by a change with a higher version (its WAL position),
// so a replay or an older change after a newer one changes nothing. Parents that have not arrived yet get
// version-0 placeholders that any real row replaces.
export const TABLES = ['channels', 'knowledge_notes', 'agent_sessions'];

const arrayOf = value => Array.isArray(value) ? value.map(String) : String(value ?? '').replace(/^\{|\}$/g, '').split(',').filter(Boolean);
const sql = (text, values) => ({ text, values });

export function lsnToVersion(lsn) {
  const match = /^([0-9A-Fa-f]+)\/([0-9A-Fa-f]+)$/.exec(String(lsn));
  if (!match) throw new Error('Invalid LSN');
  return (BigInt('0x' + match[1]) << 32n) | BigInt('0x' + match[2]);
}

const channelStub = (id, workspace) => sql(
  `INSERT INTO kb.g_channels(id,workspace_id,name,is_private,enabled,version) VALUES($1::text,$2::uuid,'',true,false,0) ON CONFLICT (id) DO NOTHING`,
  [id, workspace]);
const threadStub = (id, channel, workspace) => sql(
  `INSERT INTO kb.g_threads(id,workspace_id,channel_id,version) VALUES($1::text,$2::uuid,$3::text,0) ON CONFLICT (id) DO NOTHING`,
  [id, workspace, channel]);

function planChannel({ op, row }, version) {
  if (op === 'delete') return [sql('DELETE FROM kb.g_channels WHERE id=$1::text AND version<=$2::bigint', [row.id, String(version)])];
  if (row.kind !== 'channel') return [];
  return [sql(
    `INSERT INTO kb.g_channels(id,workspace_id,name,is_private,enabled,version) VALUES($1::text,$2::uuid,$3,$4,$5,$6::bigint)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,is_private=EXCLUDED.is_private,enabled=EXCLUDED.enabled,version=EXCLUDED.version
     WHERE kb.g_channels.version<EXCLUDED.version`,
    [row.id, row.workspace_id, row.name, row.private, row.knowledge_enabled, String(version)])];
}

async function planKnowledge({ op, row }, version, lookup) {
  const v = String(version);
  if (op === 'delete' || row.removed_at) return [sql('DELETE FROM kb.g_knowledge WHERE id=$1::text AND version<=$2::bigint', [row.id, v])];
  const messages = arrayOf(row.evidence);
  const found = messages.length ? await lookup.threadsOf(row.workspace_id, messages) : new Map();
  // Evidence must come from the knowledge's own channel, and only channel threads are kept.
  const threads = [...new Set(messages.flatMap(m => {
    const hit = found.get(m);
    return hit && hit.kind === 'channel' && hit.channel === row.channel_id ? [hit.thread] : [];
  }))];
  const won = 'EXISTS (SELECT 1 FROM kb.g_knowledge WHERE id=$1::text AND version=$4::bigint)';
  return [
    channelStub(row.channel_id, row.workspace_id),
    ...threads.map(t => threadStub(t, row.channel_id, row.workspace_id)),
    sql(`INSERT INTO kb.g_knowledge(id,workspace_id,channel_id,kind,title,revision,version) VALUES($1::text,$2::uuid,$3::text,$4,$5,$6::int,$7::bigint)
         ON CONFLICT (id) DO UPDATE SET channel_id=EXCLUDED.channel_id,kind=EXCLUDED.kind,title=EXCLUDED.title,revision=EXCLUDED.revision,version=EXCLUDED.version
         WHERE kb.g_knowledge.version<EXCLUDED.version`,
      [row.id, row.workspace_id, row.channel_id, row.kind, row.title, row.revision, v]),
    sql(`DELETE FROM kb.g_evidence WHERE knowledge_id=$1::text AND workspace_id=$2::uuid AND NOT (thread_id=ANY($3::text[])) AND ${won}`,
      [row.id, row.workspace_id, threads, v]),
    sql(`INSERT INTO kb.g_evidence(id,workspace_id,knowledge_id,thread_id) SELECT $1::text||'/'||t,$2::uuid,$1::text,t FROM unnest($3::text[]) t
         WHERE ${won} ON CONFLICT (id) DO NOTHING`,
      [row.id, row.workspace_id, threads, v]),
  ];
}

async function planSession({ op, row }, version, lookup) {
  const v = String(version);
  if (op === 'delete') return [sql('DELETE FROM kb.g_sessions WHERE id=$1::text AND version<=$2::bigint', [row.id, v])];
  const owner = (await lookup.channelsOfThreads(row.workspace_id, [row.origin_thread_id])).get(row.origin_thread_id);
  if (!owner || owner.kind !== 'channel') return [];
  return [
    channelStub(owner.channel, row.workspace_id),
    threadStub(row.origin_thread_id, owner.channel, row.workspace_id),
    sql(`INSERT INTO kb.g_sessions(id,workspace_id,thread_id,title,state,version) VALUES($1::text,$2::uuid,$3::text,$4,$5,$6::bigint)
         ON CONFLICT (id) DO UPDATE SET thread_id=EXCLUDED.thread_id,title=EXCLUDED.title,state=EXCLUDED.state,version=EXCLUDED.version
         WHERE kb.g_sessions.version<EXCLUDED.version`,
      [row.id, row.workspace_id, row.origin_thread_id, row.title, row.state, v]),
  ];
}

export async function planChange(change, version, lookup) {
  if (change.table === 'channels') return planChannel(change, version);
  if (change.table === 'knowledge_notes') return planKnowledge(change, version, lookup);
  if (change.table === 'agent_sessions') return planSession(change, version, lookup);
  return [];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test apps/mcp-gateway/providers/pg-knowledge/graph-plan.test.mjs`
Expected: 10 tests pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp-gateway/providers/pg-knowledge/graph-plan.mjs apps/mcp-gateway/providers/pg-knowledge/graph-plan.test.mjs
git commit -m "feat(knowledge): plan CDC changes into guarded graph writes"
git show --stat HEAD
```

---

### Task 3: Space lookups and snapshot

**Files:**
- Create: `$KB/graph-source.mjs`

- [ ] **Step 1: Write the file**

```js
// Reads from Space: which thread and channel a message belongs to, and the finite snapshot used to
// start or rebuild the graph. Direct-message channels are returned with kind 'direct' so the planner drops them.
export function sourceLookup(source) {
  return {
    async threadsOf(workspace, messageIds) {
      const { rows } = await source.query(
        `SELECT m.id::text AS message, m.thread_id::text AS thread, m.channel_id::text AS channel, c.kind
         FROM messages m JOIN channels c ON c.id=m.channel_id WHERE m.workspace_id=$1 AND m.id=ANY($2::uuid[])`,
        [workspace, messageIds]);
      return new Map(rows.map(row => [row.message, row]));
    },
    async channelsOfThreads(workspace, threadIds) {
      const { rows } = await source.query(
        `SELECT DISTINCT ON (m.thread_id) m.thread_id::text AS thread, m.channel_id::text AS channel, c.kind
         FROM messages m JOIN channels c ON c.id=m.channel_id WHERE m.workspace_id=$1 AND m.thread_id=ANY($2::uuid[])
         ORDER BY m.thread_id`,
        [workspace, threadIds]);
      return new Map(rows.map(row => [row.thread, row]));
    },
  };
}

const snapshotQueries = [
  ['channels', "SELECT id::text, workspace_id::text, name, private, kind, knowledge_enabled FROM channels WHERE kind='channel' ORDER BY id"],
  ['knowledge_notes', 'SELECT id::text, workspace_id::text, channel_id::text, kind, title, evidence, revision, removed_at FROM knowledge_notes WHERE removed_at IS NULL ORDER BY id'],
  ['agent_sessions', 'SELECT id::text, workspace_id::text, origin_thread_id::text, title, state FROM agent_sessions ORDER BY id'],
];

// Channels come first, so a real channel row is written before any placeholder for it. Pages of 500.
export async function* snapshot(source) {
  const client = await source.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const [table, query] of snapshotQueries) {
      await client.query(`DECLARE graph_snapshot NO SCROLL CURSOR FOR ${query}`);
      for (;;) {
        const { rows } = await client.query('FETCH 500 FROM graph_snapshot');
        for (const row of rows) yield { table, op: 'insert', row };
        if (rows.length < 500) break;
      }
      await client.query('CLOSE graph_snapshot');
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check apps/mcp-gateway/providers/pg-knowledge/graph-source.mjs`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add apps/mcp-gateway/providers/pg-knowledge/graph-source.mjs
git commit -m "feat(knowledge): Space lookups and snapshot for the graph reader"
git show --stat HEAD
```

---

### Task 4: Apply, publish and rebuild

**Files:**
- Create: `$KB/graph-apply.mjs`

- [ ] **Step 1: Write the file**

```js
import { planChange } from './graph-plan.mjs';
import { snapshot } from './graph-source.mjs';

const SNAPSHOT_VERSION = 1n;
const run = async (client, ops) => { for (const op of ops) await client.query(op.text, op.values); };

async function inTransaction(index, work) {
  const client = await index.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function savedPosition(index, slot) {
  const { rows } = await index.query('SELECT lsn::text AS lsn FROM kb.graph_position WHERE slot=$1', [slot]);
  return rows[0]?.lsn ?? null;
}

// The graph writes and the new position commit together. The position only moves forward.
export function applyOps(index, ops, position) {
  return inTransaction(index, async client => {
    await run(client, ops);
    if (position) await client.query(
      `INSERT INTO kb.graph_position(slot,lsn) VALUES($1,$2::pg_lsn)
       ON CONFLICT (slot) DO UPDATE SET lsn=EXCLUDED.lsn WHERE kb.graph_position.lsn<EXCLUDED.lsn`,
      [position.slot, position.lsn]);
  });
}

export async function publishNeeded(index, slot) {
  const { rows } = await index.query('SELECT lsn>published_lsn AS dirty FROM kb.graph_position WHERE slot=$1', [slot]);
  return Boolean(rows[0]?.dirty);
}

// Builds the pgGraph graph from the tables and records which position it reflects.
export function publish(index, slot) {
  return inTransaction(index, async client => {
    const { rows } = await client.query('SELECT lsn::text AS lsn FROM kb.graph_position WHERE slot=$1', [slot]);
    if (!rows.length) return;
    await client.query("SELECT * FROM graph.build_graph('space_knowledge', true)");
    await client.query('UPDATE kb.graph_position SET published_lsn=$2::pg_lsn WHERE slot=$1 AND published_lsn<$2::pg_lsn', [slot, rows[0].lsn]);
  });
}

// Clears the graph and refills it from one Space snapshot in a single transaction, so readers keep
// the old graph until the new one is complete. `position` is the slot's confirmed LSN taken after the
// slot existed; everything the snapshot may have missed is later in the stream.
export function rebuild(index, source, lookup, slot, position) {
  return inTransaction(index, async client => {
    await client.query('DELETE FROM kb.g_channels');
    await client.query('DELETE FROM kb.graph_position WHERE slot=$1', [slot]);
    let ops = [];
    for await (const change of snapshot(source)) {
      ops.push(...await planChange(change, SNAPSHOT_VERSION, lookup));
      if (ops.length >= 500) { await run(client, ops); ops = []; }
    }
    await run(client, ops);
    await client.query("INSERT INTO kb.graph_position(slot,lsn) VALUES($1,$2::pg_lsn)", [slot, position]);
  });
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check apps/mcp-gateway/providers/pg-knowledge/graph-apply.mjs`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add apps/mcp-gateway/providers/pg-knowledge/graph-apply.mjs
git commit -m "feat(knowledge): apply, publish and rebuild the knowledge graph"
git show --stat HEAD
```

---

### Task 5: The reader service

**Files:**
- Modify: `apps/mcp-gateway/package.json`
- Create: `$KB/graph-reader.mjs`

- [ ] **Step 1: Add the dependency with an exact version**

Run: `pnpm --filter @space/mcp-gateway add --save-exact pg-logical-replication@2.6.0`
Expected: `apps/mcp-gateway/package.json` gains `"pg-logical-replication": "2.6.0"` and the lockfile updates.

- [ ] **Step 2: Write the reader**

```js
// One instance per Space database schema. Reads committed changes from a logical replication slot and keeps
// the knowledge graph current. On any failure it exits so the supervisor restarts it; the slot keeps every
// unconfirmed change, and every graph write is guarded, so a restart repeats nothing harmful.
//   GRAPH_SOURCE_URL       Space database; may create the publication and slot; can read messages and channels
//   GRAPH_REPLICATION_URL  Space database role with REPLICATION
//   GRAPH_INDEX_URL        knowledge database writer (graph.sql applied)
//   GRAPH_SOURCE_SCHEMA    schema holding the Space tables (default public)
import { LogicalReplicationService, PgoutputPlugin } from 'pg-logical-replication';
import { createPool } from '@space/postgres/database';
import { TABLES, lsnToVersion, planChange } from './graph-plan.mjs';
import { sourceLookup } from './graph-source.mjs';
import { applyOps, publish, publishNeeded, rebuild, savedPosition } from './graph-apply.mjs';

const schema = process.env.GRAPH_SOURCE_SCHEMA ?? 'public';
if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('Invalid GRAPH_SOURCE_SCHEMA');
const slot = ('space_graph_' + schema).slice(0, 63), publication = slot;
const source = createPool(process.env.GRAPH_SOURCE_URL);
const index = createPool(process.env.GRAPH_INDEX_URL);
const lookup = sourceLookup(source);
const CHUNK = 500, PUBLISH_DELAY_MS = 1000, LAG_REPORT_MS = 60000;
let buffer = [], saved = 0n, publishTimer, publishing = Promise.resolve(), lastReport = 0, stopping = false;
// pgGraph refuses `build_graph` while a registered source transaction is open (error PG006, checked in
// Task 1). So graph writes and publishes run one at a time inside this process. This is an in-process
// queue, not a database or distributed lock.
let queue = Promise.resolve();
const serial = work => { const next = queue.then(work); queue = next.catch(() => {}); return next; };

// Column lists keep long text out of the stream: a knowledge's content never leaves Space through here.
async function prepare() {
  const q = name => `"${schema}"."${name}"`;
  const { rowCount } = await source.query('SELECT 1 FROM pg_publication WHERE pubname=$1', [publication]);
  if (!rowCount) await source.query(`CREATE PUBLICATION "${publication}" FOR TABLE
    ${q('channels')} (id, workspace_id, name, private, kind, knowledge_enabled),
    ${q('knowledge_notes')} (id, workspace_id, channel_id, kind, title, evidence, revision, removed_at),
    ${q('agent_sessions')} (id, workspace_id, origin_thread_id, title, state)`).catch(error => { if (error.code !== '42710') throw error; });
  let { rows: [state] } = await source.query('SELECT wal_status FROM pg_replication_slots WHERE slot_name=$1', [slot]);
  if (state?.wal_status === 'lost') {
    console.error('Replication slot was lost; rebuilding the graph');
    await source.query('SELECT pg_drop_replication_slot($1)', [slot]);
    state = undefined;
  }
  if (!state) await source.query("SELECT pg_create_logical_replication_slot($1,'pgoutput')", [slot]).catch(error => { if (error.code !== '42710') throw error; });
  const position = await savedPosition(index, slot);
  if (!state || !position) {
    const { rows: [flush] } = await source.query('SELECT confirmed_flush_lsn::text AS lsn FROM pg_replication_slots WHERE slot_name=$1', [slot]);
    await rebuild(index, source, lookup, slot, flush.lsn);
    console.log('Graph rebuilt from snapshot');
  }
  saved = lsnToVersion(await savedPosition(index, slot));
}

async function flush(position) {
  const batch = buffer; buffer = [];
  const ops = [];
  for (const change of batch) ops.push(...await planChange(change, lsnToVersion(change.lsn), lookup));
  await serial(() => applyOps(index, ops, position ? { slot, lsn: position } : undefined));
  if (position) { saved = lsnToVersion(position); schedulePublish(); }
}

// Debounce: a burst of commits costs one graph build.
function schedulePublish() {
  clearTimeout(publishTimer);
  publishTimer = setTimeout(() => {
    publishing = serial(() => publish(index, slot)).catch(fail);
  }, PUBLISH_DELAY_MS);
}

async function onMessage(replication, lsn, message) {
  if (message.tag === 'begin') buffer = [];
  else if ((message.tag === 'insert' || message.tag === 'update' || message.tag === 'delete')
      && message.relation.schema === schema && TABLES.includes(message.relation.name)) {
    buffer.push({ table: message.relation.name, op: message.tag, lsn, row: message.tag === 'delete' ? (message.old ?? message.key) : message.new });
    if (buffer.length >= CHUNK) await flush();            // partial chunk: guarded writes, position unchanged
  } else if (message.tag === 'commit') {
    if (lsnToVersion(message.commitEndLsn) <= saved) buffer = [];   // already applied before a crash
    else await flush(message.commitEndLsn);
    await replication.acknowledge(message.commitEndLsn);          // only after the graph commit
  }
}

function fail(error) { console.error('Knowledge graph reader stopped:', error.code ?? error.name, error.message); process.exit(1); }

await prepare();
if (await publishNeeded(index, slot)) await publish(index, slot);
const replication = new LogicalReplicationService(
  { connectionString: process.env.GRAPH_REPLICATION_URL, application_name: 'space-graph-reader', keepAlive: true },
  { acknowledge: { auto: false, timeoutSeconds: 0 }, flowControl: { enabled: true } });
let confirmed = '0/0';
// Keepalives from the server carry its WAL end, so lag is reported without any query.
replication.on('heartbeat', async (lsn, _time, respond) => {
  if (respond) await replication.acknowledge(confirmed);
  if (Date.now() - lastReport > LAG_REPORT_MS) {
    lastReport = Date.now();
    console.log(JSON.stringify({ graph_reader: 'lag', bytes: String(lsnToVersion(lsn) - saved) }));
  }
});
replication.on('data', async (lsn, message) => {
  try {
    await onMessage(replication, lsn, message);
    if (message.tag === 'commit') confirmed = message.commitEndLsn;
  } catch (error) { fail(error); }
});
replication.on('error', fail);
replication.subscribe(new PgoutputPlugin({ protoVersion: 1, publicationNames: [publication] }), slot).catch(fail);
console.log('Knowledge graph reader ready');
for (const name of ['SIGTERM', 'SIGINT']) process.once(name, async () => {
  stopping = true; clearTimeout(publishTimer);
  await replication.stop().catch(() => {}); await publishing.catch(() => {});
  process.exit(0);
});
```

- [ ] **Step 3: Syntax check**

Run: `node --check apps/mcp-gateway/providers/pg-knowledge/graph-reader.mjs`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add apps/mcp-gateway/package.json pnpm-lock.yaml apps/mcp-gateway/providers/pg-knowledge/graph-reader.mjs
git commit -m "feat(knowledge): CDC reader that builds the knowledge graph"
git show --stat HEAD
```

---

### Task 6: End-to-end smoke test (no related search yet)

**Files:**
- Create: `$KB/graph-smoke.mjs`

Needs three disposable databases, like `notes-smoke.mjs`: `TEST_DATABASE_URL` (Space test database, `wal_level=logical`, role with REPLICATION), `THREAD_INDEX_URL` (knowledge database writer with `schema.sql`, `threads.sql` and `graph.sql` applied) and `KNOWLEDGE_DATABASE_URL` (reader role).

- [ ] **Step 1: Write the smoke test**

```js
// Run with TEST_DATABASE_URL, THREAD_INDEX_URL and KNOWLEDGE_DATABASE_URL as described in the plan.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool, database } from '@space/postgres/database';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { ChatStore } from '@space/postgres/chat';
import { listNoteTitles, removeNote, saveNoteByTitle } from '@space/postgres/knowledge-notes';

const schema = 'graph_test_' + randomUUID().replaceAll('-', '');
const slot = ('space_graph_' + schema).slice(0, 63);
const admin = createPool(process.env.TEST_DATABASE_URL), index = createPool(process.env.THREAD_INDEX_URL);
const url = new URL(process.env.TEST_DATABASE_URL);
url.searchParams.set('options', '-c search_path=' + schema);
const source = createPool(url.href);
let worker;
async function stop() {
  if (worker && worker.exitCode === null && worker.signalCode === null) { const ended = once(worker, 'exit'); worker.kill(); await ended; }
}
const start = () => { worker = spawn(process.execPath, [fileURLToPath(new URL('./graph-reader.mjs', import.meta.url))], {
  env: { ...process.env, GRAPH_SOURCE_URL: url.href, GRAPH_REPLICATION_URL: process.env.TEST_DATABASE_URL,
    GRAPH_INDEX_URL: process.env.THREAD_INDEX_URL, GRAPH_SOURCE_SCHEMA: schema }, stdio: ['ignore', 'ignore', 'inherit'] }); };
async function until(fn) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await fn()) return; await delay(150); }
  throw Error('Timed out waiting for the graph');
}
const count = async table => Number((await index.query(`SELECT count(*) FROM kb.${table}`)).rows[0].count);
const titles = async () => (await index.query('SELECT title FROM kb.g_knowledge ORDER BY title')).rows.map(r => r.title);
try {
  await admin.query('CREATE SCHEMA ' + schema);
  await migrate(source);
  const seed = await bootstrap(source), chat = new ChatStore(source), db = database(source);
  const one = await chat.send(seed.owner_id, seed.channel_id, { client_message_id: randomUUID(), text: 'Retries double charge.' });
  const two = await chat.send(seed.owner_id, seed.channel_id, { client_message_id: randomUUID(), text: 'Rotate keys quarterly.' });
  await source.query('UPDATE channels SET knowledge_enabled=true WHERE id=$1', [seed.channel_id]);
  const scope = { workspaceId: seed.workspace_id, channelId: seed.channel_id }, codex = { id: 'codex', name: 'Codex' };
  const save = (title, id) => saveNoteByTitle(db, scope, { kind: 'fact', title, content: title + ' body.', message_ids: [id] }, codex);
  await save('A', one.id); await save('B', one.id); await save('C', two.id);

  start();
  await until(async () => (await count('g_knowledge')) === 3);
  assert.deepEqual(await titles(), ['A', 'B', 'C'], 'first start rebuilds from the snapshot');
  assert.equal(await count('g_evidence'), 3);
  assert.equal(await count('g_channels'), 1);

  await save('D', two.id);                       // live change through the slot
  await until(async () => (await count('g_knowledge')) === 4);
  await save('B', two.id);                       // same title, new evidence: B moves from thread one to two
  await until(async () => (await index.query(`SELECT 1 FROM kb.g_evidence e JOIN kb.g_knowledge k ON k.id=e.knowledge_id WHERE k.title='B' AND e.thread_id=$1`, [two.id])).rowCount === 1);
  assert.equal((await index.query(`SELECT 1 FROM kb.g_evidence e JOIN kb.g_knowledge k ON k.id=e.knowledge_id WHERE k.title='B' AND e.thread_id=$1`, [one.id])).rowCount, 0, 'old evidence edge is gone');

  await stop();                                   // reader offline
  const a = (await listNoteTitles(db, seed.channel_id)).notes.find(n => n.title === 'A');
  await removeNote(db, seed.channel_id, a.id, a.revision, codex);
  await save('E', one.id);
  start();                                        // restart: the slot replays what was missed
  await until(async () => (await titles()).join() === 'B,C,D,E');
  const lsn = (await index.query('SELECT lsn::text, published_lsn::text FROM kb.graph_position WHERE slot=$1', [slot])).rows[0];
  assert.ok(lsn.lsn !== '0/0');
  await until(async () => (await index.query('SELECT lsn=published_lsn AS same FROM kb.graph_position WHERE slot=$1', [slot])).rows[0].same);

  await stop(); start();                          // restart with nothing new changes nothing
  await delay(1500);
  assert.deepEqual(await titles(), ['B', 'C', 'D', 'E']);

  const before = await count('g_evidence');
  await source.query('UPDATE channels SET knowledge_enabled=false WHERE id=$1', [seed.channel_id]);
  await until(async () => (await index.query('SELECT enabled FROM kb.g_channels')).rows[0].enabled === false);
  assert.equal(await count('g_evidence'), before, 'switching off hides knowledge on read; the graph keeps it');
  console.log('PASS: snapshot start, live change, evidence move, removal while offline, replay, idempotent restart, switch.');
} finally {
  await stop();
  for (let i = 0; i < 20; i++) {
    try { await admin.query('SELECT pg_drop_replication_slot($1)', [slot]); break; } catch { await delay(250); }
  }
  await admin.query(`DROP PUBLICATION IF EXISTS "${slot}"`).catch(() => {});
  await index.query('DELETE FROM kb.g_channels').catch(() => {});
  await index.query('DELETE FROM kb.graph_position WHERE slot=$1', [slot]).catch(() => {});
  await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
  await Promise.all([admin.end(), index.end(), source.end()]);
}
```

- [ ] **Step 2: Run it**

Run: `node --env-file=.env apps/mcp-gateway/providers/pg-knowledge/graph-smoke.mjs`
(Use the same way you start `notes-smoke.mjs`; the three URLs must be set.)
Expected: `PASS: snapshot start, live change, evidence move, removal while offline, replay, idempotent restart, switch.`

If a step fails, read the reader's stderr (it prints `Knowledge graph reader stopped:` with the error code), fix the cause in `graph-plan.mjs`, `graph-apply.mjs` or `graph-reader.mjs`, and add a unit case to `graph-plan.test.mjs` when the cause was in the planner. Do not weaken an assertion to pass.

- [ ] **Step 3: Run the unit tests again**

Run: `node --test apps/mcp-gateway/providers/pg-knowledge/graph-plan.test.mjs`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add apps/mcp-gateway/providers/pg-knowledge/graph-smoke.mjs
git commit -m "test(knowledge): end-to-end smoke for the CDC graph reader"
git show --stat HEAD
```

---

### Task 7: Related knowledge

**Files:**
- Modify: `$KB/notes-search.mjs`
- Create: `$KB/graph-related.mjs`
- Modify: `$KB/server.mjs`
- Modify: `$KB/graph-smoke.mjs`

- [ ] **Step 1: Extend the smoke test first (it fails until the code exists)**

Add this import at the top of `graph-smoke.mjs`:

```js
import { searchRelated } from './graph-related.mjs';
```

Add `const reader = createPool(process.env.KNOWLEDGE_DATABASE_URL);` next to the other pools, and `reader.end()` to the final `Promise.all`. Insert this block after the `assert.equal(await count('g_channels'), 1);` line:

```js
  const ids = Object.fromEntries((await listNoteTitles(db, seed.channel_id)).notes.map(n => [n.title, n.id]));
  const ctx = requesterId => ({ workspaceId: seed.workspace_id, requesterId, connectionId: randomUUID(), audience: { channelId: seed.channel_id } });
  assert.deepEqual((await searchRelated(reader, source, ctx(seed.owner_id), 'note/' + ids.A, 5)).map(h => h.title), ['B'], 'A and B cite the same thread');
  assert.deepEqual(await searchRelated(reader, source, ctx(randomUUID()), 'note/' + ids.A, 5), [], 'unknown requester sees nothing');
  await assert.rejects(() => searchRelated(reader, source, ctx(seed.owner_id), 'message/' + ids.A, 5), /Invalid related reference/);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --env-file=.env apps/mcp-gateway/providers/pg-knowledge/graph-smoke.mjs`
Expected: FAIL, cannot find module `./graph-related.mjs`.

- [ ] **Step 3: Export the hit builder from `notes-search.mjs`**

Replace the body of `notes-search.mjs` after the import with:

```js
export function noteHit(context, note) {
  const label = 'Note in #' + note.channel_name;
  return { ref: { connectionId: context.connectionId, recordId: 'note/' + note.id }, title: note.title, evidence: note.content,
    citation: { label, url: messagePath(note.channel_id, note.evidence[0]) } };
}

// Rank indexed notes, then return only those Space still shows to this requester and destination,
// at the same revision that was indexed.
export async function searchNotes(index, source, context, query, vector, limit) {
  const ranked = await index.query(`
    SELECT n.id, n.revision FROM pgcontext.query('kb_notes',$1::pgcontext.vector,$2,'text',$3) q
    JOIN kb.notes n ON n.id=q.source_key AND n.workspace_id=$4
    ORDER BY q.score DESC, n.id`, [JSON.stringify(vector), query, Math.min(100, limit * 4), context.workspaceId]);
  if (!ranked.rows.length) return [];
  const { rows } = await source.query('SELECT * FROM knowledge_visible_notes($1,$2,$3,$4::uuid[])',
    [context.workspaceId, context.requesterId, context.audience.channelId, ranked.rows.map(row => row.id)]);
  const visible = new Map(rows.map(row => [row.id, row]));
  return ranked.rows.flatMap(candidate => {
    const note = visible.get(candidate.id);
    return note && note.revision === candidate.revision ? [noteHit(context, note)] : [];
  }).slice(0, limit);
}
```

- [ ] **Step 4: Write `graph-related.mjs`**

```js
import { noteHit } from './notes-search.mjs';

const reference = /^note\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

// Knowledge that cites a thread the given knowledge also cites, most shared threads first. The graph only
// proposes ids; Space decides what this requester may see, and the starting knowledge must be visible too.
export async function searchRelated(index, source, context, recordId, limit) {
  const start = reference.exec(recordId)?.[1];
  if (!start) throw new Error('Invalid related reference');
  const { rows: near } = await index.query(
    `SELECT other.knowledge_id AS id, count(*) AS shared
     FROM kb.g_evidence mine JOIN kb.g_evidence other
       ON other.thread_id=mine.thread_id AND other.knowledge_id<>mine.knowledge_id AND other.workspace_id=mine.workspace_id
     WHERE mine.knowledge_id=$1 AND mine.workspace_id=$2
     GROUP BY other.knowledge_id ORDER BY shared DESC, other.knowledge_id LIMIT $3`,
    [start, context.workspaceId, Math.min(100, limit * 4)]);
  if (!near.length) return [];
  const ids = [start, ...near.map(row => row.id)];
  const { rows } = await source.query('SELECT * FROM knowledge_visible_notes($1,$2,$3,$4::uuid[])',
    [context.workspaceId, context.requesterId, context.audience.channelId, ids]);
  const visible = new Map(rows.map(row => [row.id, row]));
  if (!visible.has(start)) return [];
  return near.flatMap(row => visible.has(row.id) ? [noteHit(context, visible.get(row.id))] : []).slice(0, limit);
}
```

- [ ] **Step 5: Wire it into `server.mjs`**

Edit 1, the import (line 2-3 area). Replace:

```js
import { searchNotes } from './notes-search.mjs';
```

with:

```js
import { searchNotes } from './notes-search.mjs';
import { searchRelated } from './graph-related.mjs';
```

Edit 2, detect the graph tables. Replace:

```js
const sources = ['threads', 'files', 'runbooks', ...(notesIndex ? ['notes'] : [])];
```

with:

```js
const graphIndex = notesIndex && (await pool.query("SELECT to_regclass('kb.g_evidence') IS NOT NULL AS ok")).rows[0].ok;
const sources = ['threads', 'files', 'runbooks', ...(notesIndex ? ['notes'] : [])];
```

Edit 3, the manifest filter. Replace:

```js
  ...(threadSource ? {filters:[{key:'source',description:'Choose attached Markdown files, workspace threads, saved notes, or the runbook catalog (default).',values:sources}]} : {}) };
```

with:

```js
  ...(threadSource ? {filters:[{key:'source',description:'Choose attached Markdown files, workspace threads, saved notes, or the runbook catalog (default).',values:sources},
    ...(graphIndex ? [{key:'related',description:'A knowledge reference such as note/<uuid>. Returns other knowledge that cites the same conversations. The query text is ignored.'}] : [])]} : {}) };
```

Edit 4, request validation. Replace:

```js
      request.cursor !== undefined || Object.keys(request.filters ?? {}).some(k=>k!=='source') ||
```

with:

```js
      request.cursor !== undefined || Object.keys(request.filters ?? {}).some(k => k !== 'source' && !(k === 'related' && graphIndex)) ||
      (request.filters?.related !== undefined && (typeof request.filters.related !== 'string' || request.filters.related.length > 64)) ||
```

Edit 5, the branch. Replace:

```js
    if (!grants.rowCount && !threads && !notes) throw new Error('Unauthorized audience');
    await client.query("SELECT set_config('kb.private',$1,true)", [grants.rows[0]?.include_private ? 'on' : 'off']);
```

with:

```js
    const related = request.filters?.related;
    if (!grants.rowCount && !threads && !notes && related === undefined) throw new Error('Unauthorized audience');
    await client.query("SELECT set_config('kb.private',$1,true)", [grants.rows[0]?.include_private ? 'on' : 'off']);
    if (related !== undefined) {
      const hits = await searchRelated(client, threadSource, context, related, request.limit);
      await client.query('COMMIT');
      return { hits };
    }
```

- [ ] **Step 6: Run to verify it passes**

Run: `node --env-file=.env apps/mcp-gateway/providers/pg-knowledge/graph-smoke.mjs`
Expected: PASS line as in Task 6.

Run: `pnpm --filter @space/mcp-gateway typecheck && pnpm --filter @space/mcp-gateway test`
Expected: both succeed (these do not load the `.mjs` provider, so they check nothing broke around it).

- [ ] **Step 7: Commit**

```bash
git add apps/mcp-gateway/providers/pg-knowledge/notes-search.mjs apps/mcp-gateway/providers/pg-knowledge/graph-related.mjs apps/mcp-gateway/providers/pg-knowledge/server.mjs apps/mcp-gateway/providers/pg-knowledge/graph-smoke.mjs
git commit -m "feat(knowledge): find related knowledge through shared evidence threads"
git show --stat HEAD
```

---

### Task 8: Docs and rule check

**Files:**
- Modify: `$KB/README.md`

- [ ] **Step 1: Append a section to the README**

````markdown
## Knowledge graph from change data capture

`graph-reader.mjs` reads committed changes from a logical replication slot and keeps the `space_knowledge` pgGraph graph current. It adds `filters.related` to `knowledge_search`: `note/<uuid>` returns other knowledge that cites the same conversations.

Space database needs `wal_level=logical`, PostgreSQL 15 or newer (column-list publications), and `max_slot_wal_keep_size` set so a stopped reader cannot fill the disk. If the slot passes the cap, the reader drops it and rebuilds the graph from a snapshot on its next start.

1. Apply `graph.sql` to the knowledge database after `schema.sql` and `threads.sql`.
2. Run one reader per Space schema:

```sh
GRAPH_SOURCE_URL=... GRAPH_REPLICATION_URL=... GRAPH_INDEX_URL=... GRAPH_SOURCE_SCHEMA=public \
  node apps/mcp-gateway/providers/pg-knowledge/graph-reader.mjs
```

`GRAPH_SOURCE_URL` may create the publication and slot and must read `messages`, `channels` and `agent_sessions`. `GRAPH_REPLICATION_URL` needs the REPLICATION attribute. `GRAPH_INDEX_URL` writes `kb.g_*`. Restart the reader after any failure; it exits on error and the slot keeps unconfirmed changes.

Checks: `node --test apps/mcp-gateway/providers/pg-knowledge/graph-plan.test.mjs`, and `graph-smoke.mjs` with the three test database URLs.
````

- [ ] **Step 2: Check the architecture rules**

Run: `grep -nE "FOR UPDATE|FOR SHARE|SKIP LOCKED|advisory|LOCK TABLE|setInterval" apps/mcp-gateway/providers/pg-knowledge/graph-*.mjs apps/mcp-gateway/providers/pg-knowledge/graph.sql`
Expected: no output.

Run: `grep -n "setTimeout" apps/mcp-gateway/providers/pg-knowledge/graph-reader.mjs`
Expected: one line, the debounce in `schedulePublish` (a deadline, not a scan).

- [ ] **Step 3: Commit**

```bash
git add apps/mcp-gateway/providers/pg-knowledge/README.md
git commit -m "docs(knowledge): run the CDC graph reader"
git show --stat HEAD
```

---

## Self-review against the spec

| Spec section | Task |
| --- | --- |
| Data flow, publication on three tables | 5 (`prepare`) |
| Graph model, tables, DM exclusion, no content in stream | 1, 2, 5 |
| Applying a change: guarded upsert, removal, evidence replace, switch off hides | 2, 6 |
| Position and exactly-once effect | 4 (`applyOps`), 5 (`onMessage` ack after commit, skip applied) |
| Start and rebuild, lost slot | 4 (`rebuild`), 5 (`prepare`) |
| Reading the graph with live access check | 7 |
| Limits: batch 500, snapshot pages 500 | 3, 5 |
| Lag signal without queries; debounced publish; `published_lsn` repair | 4, 5 |
| Tests | 2 (unit), 6, 7 (smoke) |
| Large-transaction case | 5 (chunk flush leaves the position alone) |

Not covered by an automated test: the lost-slot rebuild (needs a slot that exceeds `max_slot_wal_keep_size`), two readers on one slot, and the 100,000-change timing run the spec asks for. Run those by hand after Task 7 and record the numbers before making any performance claim.

Names used across tasks: `planChange`, `lsnToVersion`, `TABLES` (Task 2); `sourceLookup`, `snapshot` (Task 3); `applyOps`, `publish`, `publishNeeded`, `rebuild`, `savedPosition` (Task 4); `searchRelated`, `noteHit` (Task 7). All match where they are imported.
