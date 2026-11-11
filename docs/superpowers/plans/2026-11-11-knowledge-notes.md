# Knowledge Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let agents save long-term knowledge notes per channel, find them from other threads with `knowledge_search`, and see the newest note titles in task context.

**Architecture:** Notes live in Space PostgreSQL (`knowledge_notes` plus `knowledge_note_revisions`) behind a new per-channel switch. Writes use unique indexes, `ON CONFLICT` and revision-guarded updates in single SQL statements. Agents write through new tools on `/mcp/memory` or through a `notes` list in the hidden `<space-memory>` turn-end block. A trigger sends `pg_notify`; the existing `thread-worker.mjs` copies notes into pgContext (`kb.notes`), and the pg-knowledge provider searches them and re-checks access in Space with `knowledge_visible_notes()`.

**Tech Stack:** TypeScript, Fastify, drizzle-orm with raw `sql`, PostgreSQL 17, pgContext, MCP TypeScript SDK 2.4, React with Vitest, Node test runner (`tsx --test`).

**Spec:** `docs/superpowers/specs/2026-11-11-knowledge-notes-design.md`

---

## Before you start

- Work on `main`. Do not create a branch. Do not push.
- Another session is building the memory graph UI on `main` at the same time. It edits `apps/web/src/features/memory/ChannelMemory.tsx`, `apps/server/memory.ts` and `adapters/postgres/migrate.ts`. Re-read a file right before you edit it. Stage only the files your task names. Never use `git add -A`.
- Tests need `TEST_DATABASE_URL` pointing at a disposable database where schemas can be created, for example `postgres://postgres:postgres@127.0.0.1:5432/workplace_test`. Each test file creates and drops its own schema.
- Build packages the tests import with `pnpm --filter @space/contracts --filter @space/postgres --filter @space/server build` after changing them. The integration tests import built `dist` files.

## File map

| File | Responsibility |
| --- | --- |
| `adapters/postgres/migrations/088_knowledge_notes.sql` (new) | Switch column, note tables, notify triggers, source view, visibility function |
| `adapters/postgres/migrate.ts` | Registers migration 088 |
| `adapters/postgres/schema.ts` | `channels.knowledge_enabled` for drizzle |
| `packages/contracts/knowledge-notes.ts` (new) | Note types, limits and parsers |
| `packages/contracts/memory-block.ts` | `notes` in the turn-end block |
| `packages/contracts/memory.ts` | `knowledge_enabled` in `ChannelMemory`, `parseKnowledgeSettings` |
| `packages/contracts/foundation.ts`, `packages/contracts/index.ts` | `context.knowledge_notes` |
| `adapters/postgres/knowledge-notes.ts` (new) | Note store: save, add, update, remove, list, turn-end save, task context |
| `adapters/postgres/memory.ts` | Exported `agentMemoryAccess`, switch on `MemoryChannel`, `configureKnowledge` |
| `adapters/postgres/turn-trace.ts` | `note` trace phase |
| `adapters/postgres/store.ts` | Turn-end note save, `knowledge_notes` in task context |
| `apps/server/memory.ts` | `POST /memory/knowledge`, `knowledge_enabled` in state |
| `apps/server/memory-mcp.ts` | `knowledge_list`, `knowledge_add`, `knowledge_update`, `knowledge_remove` |
| `apps/connector/memory-instructions.ts` | Turn instructions for notes |
| `apps/web/src/features/memory/KnowledgeSwitch.tsx` (new) | Manager switch in the Memory dialog |
| `apps/mcp-gateway/providers/pg-knowledge/notes.sql` (new) | `kb.notes` and the `kb_notes` collection |
| `apps/mcp-gateway/providers/pg-knowledge/notes-sync.mjs` (new) | Worker sync and reconcile for notes |
| `apps/mcp-gateway/providers/pg-knowledge/notes-search.mjs` (new) | Provider search for `source: notes` |
| `apps/mcp-gateway/providers/pg-knowledge/notes-smoke.mjs` (new) | End-to-end check with a real index and Ollama |
| `tests/contracts/knowledge-notes.test.ts` (new) | Contract tests |
| `tests/integration/knowledge-notes.test.ts` (new) | Database, route, MCP and turn tests |

---

### Task 1: Migration 088

**Files:**
- Create: `adapters/postgres/migrations/088_knowledge_notes.sql`
- Modify: `adapters/postgres/migrate.ts` (migration list)
- Modify: `adapters/postgres/schema.ts` (`channels` table)
- Test: `tests/integration/knowledge-notes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/knowledge-notes.test.ts`:

```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
const schema = `knowledge_notes_${randomBytes(6).toString('hex')}`;
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const directory = await mkdtemp(join(tmpdir(), 'space-knowledge-notes-'));
const store = new PostgresStore(pool);
const app = createApi(store, { allowDevelopmentTokens: true, memory: { directory } });
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
const db = () => store.db;
async function insertNote(a: { workspace_id: string; channel_id: string }, id: string, title: string, evidence: string) {
  return pool.query(`INSERT INTO knowledge_notes(id,workspace_id,channel_id,kind,title,content,evidence,producer_id,producer_name)
    VALUES($1,$2,$3,'decision',$4,'Dedupe charges.',ARRAY[$5]::uuid[],'p','Codex')`, [id, a.workspace_id, a.channel_id, title, evidence]);
}

test('migration: one live note per title, notify payloads, visibility follows the switch', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Dedupe on idempotency_key');
  const listener = await admin.connect();
  const payloads: string[] = [];
  listener.on('notification', n => payloads.push(n.payload ?? ''));
  await listener.query(`LISTEN space_kb_${a.workspace_id.replaceAll('-', '')}`);
  try {
    const first = randomUUID();
    await insertNote(a, first, 'Duplicate charge fix', root.id);
    await assert.rejects(insertNote(a, randomUUID(), '  duplicate   CHARGE fix ', root.id), /duplicate key/);
    const visible = (requester = a.owner_id) => pool.query('SELECT id FROM knowledge_visible_notes($1,$2,$3,$4::uuid[])', [a.workspace_id, requester, a.channel_id, [first]]);
    assert.equal((await visible()).rowCount, 0, 'hidden while the switch is off');
    await pool.query('UPDATE channels SET knowledge_enabled=true WHERE id=$1', [a.channel_id]);
    assert.equal((await visible()).rowCount, 1);
    assert.equal((await visible(randomUUID())).rowCount, 0, 'unknown requester sees nothing');
    await pool.query('UPDATE knowledge_notes SET removed_at=now() WHERE id=$1', [first]);
    assert.equal((await visible()).rowCount, 0, 'removed notes are hidden');
    await insertNote(a, randomUUID(), 'Duplicate charge fix', root.id);
    await delay(200);
    assert.ok(payloads.includes(`note/${a.channel_id}/${first}`), JSON.stringify(payloads));
    assert.ok(payloads.includes('reconcile'), 'switch change asks the worker to reconcile');
  } finally { listener.release(); }
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd tests && TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/workplace_test npx tsx --test --test-name-pattern="migration: one live note" integration/knowledge-notes.test.ts`
Expected: FAIL with `relation "knowledge_notes" does not exist`.

- [ ] **Step 3: Write the migration**

Create `adapters/postgres/migrations/088_knowledge_notes.sql`:

```sql
-- Long-term Knowledge notes. Space is the source of truth; the provider index is a copy.
ALTER TABLE channels ADD COLUMN knowledge_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE knowledge_notes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fact','decision','procedure','answer')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  title_key text GENERATED ALWAYS AS (lower(regexp_replace(btrim(title), '\s+', ' ', 'g'))) STORED,
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 16000),
  evidence uuid[] NOT NULL CHECK (cardinality(evidence) BETWEEN 1 AND 20),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  producer_id text NOT NULL,
  producer_name text NOT NULL,
  fingerprint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id, id) ON DELETE CASCADE
);
-- One live note per title per channel. Same-title saves use this as the ON CONFLICT arbiter.
CREATE UNIQUE INDEX knowledge_notes_live_title ON knowledge_notes(channel_id, title_key) WHERE removed_at IS NULL;
CREATE INDEX knowledge_notes_recent ON knowledge_notes(channel_id, updated_at DESC, id DESC) WHERE removed_at IS NULL;

CREATE TABLE knowledge_note_revisions (
  note_id uuid NOT NULL REFERENCES knowledge_notes(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  evidence uuid[] NOT NULL,
  producer_id text NOT NULL,
  producer_name text NOT NULL,
  removed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (note_id, revision)
);

-- No text in notifications. The worker reads the row through knowledge_note_sources.
CREATE FUNCTION notify_note_knowledge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'knowledge_notes' THEN
    PERFORM pg_notify('space_kb_' || replace(coalesce(NEW.workspace_id, OLD.workspace_id)::text, '-', ''),
      'note/' || coalesce(NEW.channel_id, OLD.channel_id)::text || '/' || coalesce(NEW.id, OLD.id)::text);
  ELSE
    PERFORM pg_notify('space_kb_' || replace(NEW.workspace_id::text, '-', ''), 'reconcile');
  END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER knowledge_note_changed AFTER INSERT OR UPDATE OR DELETE ON knowledge_notes
  FOR EACH ROW EXECUTE FUNCTION notify_note_knowledge();
CREATE TRIGGER knowledge_notes_switched AFTER UPDATE OF knowledge_enabled ON channels
  FOR EACH ROW WHEN (NEW.knowledge_enabled IS DISTINCT FROM OLD.knowledge_enabled) EXECUTE FUNCTION notify_note_knowledge();

-- Live notes the worker may copy: switch on, channel not archived, not a DM.
CREATE VIEW knowledge_note_sources WITH (security_barrier=true) AS
 SELECT n.workspace_id, n.channel_id, n.id, n.kind, n.title, n.content, n.evidence, n.revision, c.name AS channel_name
 FROM knowledge_notes n JOIN channels c ON c.id = n.channel_id AND c.workspace_id = n.workspace_id
 WHERE n.removed_at IS NULL AND c.kind = 'channel' AND c.archived_at IS NULL AND c.knowledge_enabled;

-- Same audience rule as knowledge_visible_messages() in migration 082.
CREATE FUNCTION knowledge_visible_notes(w uuid, requester uuid, destination uuid, ids uuid[])
 RETURNS TABLE(id uuid, channel_id uuid, kind text, title text, content text, evidence uuid[], revision integer, channel_name text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
 SELECT n.id, n.channel_id, n.kind, n.title, n.content, n.evidence, n.revision, n.channel_name
 FROM knowledge_note_sources n JOIN channels src ON src.id = n.channel_id
 JOIN channels dest ON dest.workspace_id = w AND dest.id = destination
 JOIN workspace_members actor ON actor.workspace_id = w AND actor.user_id = requester AND actor.active
 WHERE n.workspace_id = w AND n.id = ANY(ids) AND cardinality(ids) <= 128
 AND EXISTS(SELECT 1 FROM channel_members WHERE channel_id = dest.id AND user_id = requester)
 AND EXISTS(SELECT 1 FROM channel_members WHERE channel_id = src.id AND user_id = requester)
 AND (NOT src.private OR dest.private)
 AND NOT EXISTS(SELECT 1 FROM channel_members cm JOIN workspace_members viewer
      ON viewer.workspace_id = w AND viewer.user_id = cm.user_id AND viewer.active
      WHERE cm.channel_id = dest.id AND (src.private OR viewer.guest_type <> 'none')
      AND NOT EXISTS(SELECT 1 FROM channel_members allowed WHERE allowed.channel_id = src.id AND allowed.user_id = viewer.user_id))
$$;
REVOKE ALL ON FUNCTION knowledge_visible_notes(uuid,uuid,uuid,uuid[]) FROM PUBLIC;
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION knowledge_visible_notes(uuid,uuid,uuid,uuid[]) SET search_path=pg_catalog,%I,pg_temp', current_schema());
END $$;
```

- [ ] **Step 4: Register the migration and the column**

In `adapters/postgres/migrate.ts`, change the end of the list from:

```ts
'086_memory_pending.sql', '087_memory_updates.sql',
```

to:

```ts
'086_memory_pending.sql', '087_memory_updates.sql', '088_knowledge_notes.sql',
```

If another migration was added after 087 in the meantime, rename this file to the next free number and update the spec.

In `adapters/postgres/schema.ts`, in the `channels` table, change:

```ts
  memory_enabled: boolean().notNull().default(false), memory_provider: text().notNull().default('markdown'),
```

to:

```ts
  memory_enabled: boolean().notNull().default(false), memory_provider: text().notNull().default('markdown'),
  knowledge_enabled: boolean().notNull().default(false),
```

- [ ] **Step 5: Build and run the test**

Run: `pnpm --filter @space/postgres build && cd tests && TEST_DATABASE_URL=... npx tsx --test --test-name-pattern="migration: one live note" integration/knowledge-notes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add adapters/postgres/migrations/088_knowledge_notes.sql adapters/postgres/migrate.ts adapters/postgres/schema.ts tests/integration/knowledge-notes.test.ts
git commit -m "Add knowledge notes tables, switch and visibility check"
```

---

### Task 2: Contracts

**Files:**
- Create: `packages/contracts/knowledge-notes.ts`
- Modify: `packages/contracts/memory-block.ts`
- Modify: `packages/contracts/memory.ts`
- Modify: `packages/contracts/foundation.ts`
- Modify: `packages/contracts/index.ts`
- Test: `tests/contracts/knowledge-notes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/contracts/knowledge-notes.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseNoteDraft, parseNotePatch, parseKnowledgeNotesContext, parseAgentMemoryUpdate, extractMemoryBlock, parseInvocation, parseKnowledgeSettings } from '@space/contracts';

const message = randomUUID();
const note = { kind: 'decision', title: ' Duplicate charge fix ', content: ' Dedupe on idempotency_key. ', message_ids: [message, message] };

test('note drafts trim text, dedupe evidence and reject bad input', () => {
  assert.deepEqual(parseNoteDraft(note), { kind: 'decision', title: 'Duplicate charge fix', content: 'Dedupe on idempotency_key.', message_ids: [message] });
  for (const bad of [{ ...note, kind: 'rumor' }, { ...note, title: 'x'.repeat(161) }, { ...note, content: ' ' }, { ...note, message_ids: [] }, { ...note, extra: 1 }]) {
    assert.throws(() => parseNoteDraft(bad), (e: any) => e.status === 400);
  }
});

test('note patches need at least one field', () => {
  assert.deepEqual(parseNotePatch({ title: 'New' }), { title: 'New' });
  assert.throws(() => parseNotePatch({}), (e: any) => e.code === 'invalid_note');
});

test('block notes are optional evidence, 2,000 characters, at most 3, and a bad one is dropped alone', () => {
  const update = parseAgentMemoryUpdate({ notes: [{ kind: 'fact', title: 'A', content: 'B' }, { kind: 'fact', title: 'C', content: 'x'.repeat(2001) }] });
  assert.deepEqual(update.notes, [{ kind: 'fact', title: 'A', content: 'B', message_ids: [] }]);
  const many = parseAgentMemoryUpdate({ thread: { base_revision: 0, summary: 's', content: 'c' }, notes: [1, 2, 3, 4].map(i => ({ kind: 'fact', title: `T${i}`, content: 'c' })) });
  assert.equal(many.notes, undefined, 'too many notes drops the list but keeps the checkpoint');
  assert.equal(many.thread?.summary, 's');
  assert.throws(() => parseAgentMemoryUpdate({ notes: [{ kind: 'bad', title: 'A', content: 'B' }] }), (e: any) => e.code === 'invalid_memory_update');
  const block = '<space-memory>{"notes":[{"kind":"decision","title":"T","content":"C"}]}</space-memory>';
  assert.equal(extractMemoryBlock(`Done ${block}`)?.notes?.[0]?.title, 'T');
});

test('knowledge_notes context is bounded and accepted by parseInvocation', () => {
  const channel = randomUUID(), id = randomUUID();
  const context = { channel_id: channel, truncated: false, notes: [{ id, kind: 'decision', title: 'T', revision: 2, updated_at: '2026-11-11 10:00:00+00' }] };
  assert.deepEqual(parseKnowledgeNotesContext(context), context);
  assert.throws(() => parseKnowledgeNotesContext({ ...context, notes: Array(21).fill(context.notes[0]) }), (e: any) => e.code === 'invalid_knowledge_notes');
  const execution = randomUUID();
  const request = parseInvocation({ schema_version: '1.0', task_id: randomUUID(), execution_id: execution, session_id: randomUUID(), idempotency_key: execution, goal: 'g', skill: 's',
    context: { thread_id: randomUUID(), messages: [], knowledge_notes: context } });
  assert.equal(request.context?.knowledge_notes?.notes[0]?.title, 'T');
});

test('knowledge settings take one boolean', () => {
  assert.deepEqual(parseKnowledgeSettings({ enabled: true }), { enabled: true });
  assert.throws(() => parseKnowledgeSettings({ enabled: 'yes' }), (e: any) => e.code === 'invalid_knowledge_settings');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd tests && npx tsx --test contracts/knowledge-notes.test.ts`
Expected: FAIL with `parseNoteDraft is not a function` (or a missing export error).

- [ ] **Step 3: Create `packages/contracts/knowledge-notes.ts`**

```ts
import { AppError, record, uuid } from './validation.js';

export const NOTE_KINDS = ['fact', 'decision', 'procedure', 'answer'] as const;
export type NoteKind = typeof NOTE_KINDS[number];
export const NOTE_TITLE_LIMIT = 160;
export const NOTE_CONTENT_LIMIT = 16_000;
export const BLOCK_NOTE_CONTENT_LIMIT = 2_000;
export const BLOCK_NOTES_MAX = 3;
export const NOTE_EVIDENCE_MAX = 20;
export const KNOWLEDGE_TITLES_MAX = 20;

export interface NoteDraft { kind: NoteKind; title: string; content: string; message_ids: string[] }
export interface NotePatch { kind?: NoteKind; title?: string; content?: string; message_ids?: string[] }
export interface KnowledgeNote { id: string; channel_id: string; kind: NoteKind; title: string; content: string; evidence: string[]; revision: number; producer_name: string; updated_at: string }
export interface KnowledgeNoteTitle { id: string; kind: NoteKind; title: string; revision: number; updated_at: string }
export interface KnowledgeNotesContext { channel_id: string; notes: KnowledgeNoteTitle[]; truncated: boolean }

function noteKind(value: unknown): NoteKind {
  if (!NOTE_KINDS.includes(value as NoteKind)) throw new AppError(400, 'invalid_note');
  return value as NoteKind;
}
function bounded(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new AppError(400, 'invalid_note');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new AppError(400, 'invalid_note');
  return trimmed;
}
function evidence(value: unknown, min: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > NOTE_EVIDENCE_MAX) throw new AppError(400, 'invalid_note');
  return [...new Set(value.map(id => uuid(id)))].sort();
}
export function parseNoteDraft(value: unknown, contentLimit = NOTE_CONTENT_LIMIT, minEvidence = 1): NoteDraft {
  const v = record(value, ['kind', 'title', 'content', 'message_ids']);
  return { kind: noteKind(v.kind), title: bounded(v.title, NOTE_TITLE_LIMIT), content: bounded(v.content, contentLimit), message_ids: evidence(v.message_ids ?? [], minEvidence) };
}
export function parseNotePatch(value: unknown): NotePatch {
  const v = record(value, ['kind', 'title', 'content', 'message_ids']);
  const patch: NotePatch = {};
  if (v.kind !== undefined) patch.kind = noteKind(v.kind);
  if (v.title !== undefined) patch.title = bounded(v.title, NOTE_TITLE_LIMIT);
  if (v.content !== undefined) patch.content = bounded(v.content, NOTE_CONTENT_LIMIT);
  if (v.message_ids !== undefined) patch.message_ids = evidence(v.message_ids, 1);
  if (!Object.keys(patch).length) throw new AppError(400, 'invalid_note');
  return patch;
}
// Turn-end notes: smaller content and optional evidence. A bad note is dropped on its own.
export function parseBlockNotes(value: unknown): NoteDraft[] {
  if (!Array.isArray(value) || value.length > BLOCK_NOTES_MAX) throw new AppError(400, 'invalid_memory_update');
  return value.flatMap(raw => { try { return [parseNoteDraft(raw, BLOCK_NOTE_CONTENT_LIMIT, 0)]; } catch { return []; } });
}
export function parseKnowledgeNotesContext(value: unknown): KnowledgeNotesContext {
  const v = record(value, ['channel_id', 'notes', 'truncated']);
  if (!Array.isArray(v.notes) || v.notes.length > KNOWLEDGE_TITLES_MAX || typeof v.truncated !== 'boolean') throw new AppError(400, 'invalid_knowledge_notes');
  return { channel_id: uuid(v.channel_id), truncated: v.truncated, notes: v.notes.map(raw => {
    const n = record(raw, ['id', 'kind', 'title', 'revision', 'updated_at']);
    if (!Number.isSafeInteger(n.revision) || (n.revision as number) < 1 || typeof n.updated_at !== 'string' || n.updated_at.length > 64) throw new AppError(400, 'invalid_knowledge_notes');
    return { id: uuid(n.id), kind: noteKind(n.kind), title: bounded(n.title, NOTE_TITLE_LIMIT), revision: n.revision as number, updated_at: n.updated_at };
  }) };
}
```

- [ ] **Step 4: Add notes to the memory block**

In `packages/contracts/memory-block.ts`, add the import under the existing imports:

```ts
import { parseBlockNotes, type NoteDraft } from './knowledge-notes.js';
```

Replace:

```ts
export interface AgentMemoryUpdate { session?: AgentMemoryPart; thread?: AgentMemoryPart }
```

with:

```ts
export interface AgentMemoryUpdate { session?: AgentMemoryPart; thread?: AgentMemoryPart; notes?: NoteDraft[] }
```

Replace the whole `parseAgentMemoryUpdate` function with:

```ts
export function parseAgentMemoryUpdate(value: unknown): AgentMemoryUpdate {
  const v = record(value, ['session', 'thread', 'notes']);
  let notes: NoteDraft[] = [];
  // A bad notes list never costs the checkpoints.
  if (v.notes !== undefined) { try { notes = parseBlockNotes(v.notes); } catch { notes = []; } }
  if (v.session === undefined && v.thread === undefined && !notes.length) throw new AppError(400, 'invalid_memory_update');
  return { ...(v.session === undefined ? {} : { session: parsePart(v.session) }), ...(v.thread === undefined ? {} : { thread: parsePart(v.thread) }), ...(notes.length ? { notes } : {}) };
}
```

- [ ] **Step 5: Add `knowledge_enabled` and the settings parser to `packages/contracts/memory.ts`**

Replace:

```ts
export type ChannelMemory = {
  enabled: boolean; provider: string; can_manage: boolean;
```

with:

```ts
export type ChannelMemory = {
  enabled: boolean; provider: string; can_manage: boolean; knowledge_enabled: boolean;
```

Add at the end of the file:

```ts
export function parseKnowledgeSettings(input: unknown): { enabled: boolean } {
  const v = record(input, ['enabled']);
  if (typeof v.enabled !== 'boolean') throw new AppError(400, 'invalid_knowledge_settings');
  return { enabled: v.enabled };
}
```

- [ ] **Step 6: Accept `knowledge_notes` in task context**

In `packages/contracts/foundation.ts`, add the import:

```ts
import { parseKnowledgeNotesContext } from './knowledge-notes.js';
```

Change the allowed context keys from:

```ts
    const ctx = record(v.context, ['thread_id', 'messages', 'working_memory', 'channel_notes', 'channel_memory', 'agent_session_memory', 'memory_conflicts', 'handoff']);
```

to:

```ts
    const ctx = record(v.context, ['thread_id', 'messages', 'working_memory', 'channel_notes', 'channel_memory', 'agent_session_memory', 'memory_conflicts', 'knowledge_notes', 'handoff']);
```

After the line that spreads `memory_conflicts`, add:

```ts
      ...(ctx.knowledge_notes === undefined ? {} : { knowledge_notes: parseKnowledgeNotesContext(ctx.knowledge_notes) }),
```

In `packages/contracts/index.ts`, add `export * from './knowledge-notes.js';` right after `export * from './memory-block.js';`. In the `InvocationRequest` interface, change `memory_conflicts?:import('./layered-memory.js').MemoryConflict[];` to:

```ts
memory_conflicts?:import('./layered-memory.js').MemoryConflict[];knowledge_notes?:import('./knowledge-notes.js').KnowledgeNotesContext;
```

- [ ] **Step 7: Build and run the tests**

Run: `pnpm --filter @space/contracts build && cd tests && npx tsx --test contracts/knowledge-notes.test.ts contracts/layered-memory.test.ts`
Expected: PASS for both files.

- [ ] **Step 8: Typecheck callers of `ChannelMemory`**

Run: `pnpm --filter @space/server --filter @space/web typecheck`
Expected: one error in `apps/server/memory.ts` because `state()` does not return `knowledge_enabled`. Task 4 fixes it. Note the error and continue. Any other error means a caller was missed: fix it in this task.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/knowledge-notes.ts packages/contracts/memory-block.ts packages/contracts/memory.ts packages/contracts/foundation.ts packages/contracts/index.ts tests/contracts/knowledge-notes.test.ts
git commit -m "Add knowledge note contracts and notes in the turn-end block"
```

---

### Task 3: Note store

**Files:**
- Create: `adapters/postgres/knowledge-notes.ts`
- Modify: `adapters/postgres/package.json` (exports)
- Test: `tests/integration/knowledge-notes.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/knowledge-notes.test.ts`:

```ts
import { addNote, listNoteTitles, removeNote, saveNoteByTitle, updateNote } from '@space/postgres/knowledge-notes';

const codex = { id: 'codex-installation', name: 'Codex' };
const draft = (message: string, title = 'Duplicate charge fix', content = 'Dedupe on idempotency_key.') => ({ kind: 'decision' as const, title, content, message_ids: [message] });

test('same-title saves make revisions, repeats change nothing, concurrent saves keep one note', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Dedupe on idempotency_key');
  const scope = { workspaceId: a.workspace_id, channelId: a.channel_id };
  assert.equal(await saveNoteByTitle(db(), scope, draft(root.id), codex), 'saved');
  assert.equal(await saveNoteByTitle(db(), scope, draft(root.id), codex), 'unchanged');
  assert.equal(await saveNoteByTitle(db(), scope, draft(root.id, 'duplicate CHARGE fix', 'Dedupe in Postgres.'), codex), 'saved');
  await Promise.all([
    saveNoteByTitle(db(), scope, draft(root.id, 'Duplicate charge fix', 'A'), codex),
    saveNoteByTitle(db(), scope, draft(root.id, 'Duplicate charge fix', 'B'), codex),
  ]);
  const notes = (await pool.query('SELECT id, revision FROM knowledge_notes WHERE channel_id=$1 AND removed_at IS NULL', [a.channel_id])).rows;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].revision, 4);
  const revisions = (await pool.query('SELECT revision FROM knowledge_note_revisions WHERE note_id=$1 ORDER BY revision', [notes[0].id])).rows;
  assert.deepEqual(revisions.map(r => r.revision), [1, 2, 3, 4]);
});

test('MCP-style add, update and remove use ids, fingerprints and revisions', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Evidence');
  const foreign = await post(b.owner_token, b.channel_id, 'Other channel');
  const scope = { workspaceId: a.workspace_id, channelId: a.channel_id };
  const id = randomUUID();
  const added = await addNote(db(), scope, id, draft(root.id), codex);
  assert.equal(added.revision, 1);
  assert.equal((await addNote(db(), scope, id, draft(root.id), codex)).id, id, 'same id and input is a retry');
  await assert.rejects(addNote(db(), scope, id, draft(root.id, 'Other'), codex), (e: any) => e.code === 'note_id_conflict');
  await assert.rejects(addNote(db(), scope, randomUUID(), draft(root.id), codex), (e: any) => e.code === 'title_taken');
  await assert.rejects(addNote(db(), scope, randomUUID(), draft(foreign.id, 'New'), codex), (e: any) => e.code === 'foreign_evidence');
  const second = await addNote(db(), scope, randomUUID(), draft(root.id, 'Retry budget'), codex);
  await assert.rejects(updateNote(db(), a.channel_id, id, 5, { content: 'x' }, codex), (e: any) => e.code === 'note_conflict');
  await assert.rejects(updateNote(db(), a.channel_id, id, 1, { title: 'retry BUDGET' }, codex), (e: any) => e.code === 'title_taken');
  await assert.rejects(updateNote(db(), a.channel_id, randomUUID(), 1, { content: 'x' }, codex), (e: any) => e.code === 'note_not_found');
  const updated = await updateNote(db(), a.channel_id, id, 1, { content: 'Dedupe in Postgres.' }, codex);
  assert.equal(updated.revision, 2);
  const removed = await removeNote(db(), a.channel_id, second.id, 1, codex);
  assert.equal(removed.revision, 2);
  const last = (await pool.query('SELECT removed FROM knowledge_note_revisions WHERE note_id=$1 ORDER BY revision DESC LIMIT 1', [second.id])).rows[0];
  assert.equal(last.removed, true);
  await assert.rejects(removeNote(db(), a.channel_id, second.id, 2, codex), (e: any) => e.code === 'note_not_found');
});

test('title list returns the newest 20 live notes', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Evidence');
  const scope = { workspaceId: a.workspace_id, channelId: a.channel_id };
  for (let i = 0; i < 25; i++) await saveNoteByTitle(db(), scope, draft(root.id, `Note ${i}`), codex);
  const list = await listNoteTitles(db(), a.channel_id);
  assert.equal(list.notes.length, 20);
  assert.equal(list.truncated, true);
  assert.equal(list.notes[0]!.title, 'Note 24');
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd tests && TEST_DATABASE_URL=... npx tsx --test integration/knowledge-notes.test.ts`
Expected: FAIL with `Cannot find module '@space/postgres/knowledge-notes'`.

- [ ] **Step 3: Create `adapters/postgres/knowledge-notes.ts`**

```ts
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { AppError, KNOWLEDGE_TITLES_MAX, type KnowledgeNote, type KnowledgeNotesContext, type NoteDraft, type NotePatch } from '@space/contracts';
import type { DbSession } from './database.js';
import { rows } from './thread-context.js';

export type NoteProducer = { id: string; name: string };
export type NoteScope = { workspaceId: string; channelId: string };
const noteColumns = sql.raw('id, channel_id, kind, title, content, evidence, revision, producer_name, updated_at::text AS updated_at');
const pgCode = (error: unknown) => { const f = error as { code?: string; cause?: { code?: string } }; return f.cause?.code ?? f.code; };

// Every evidence message must be a live message in this channel.
export async function assertNoteEvidence(c: DbSession, channelId: string, ids: string[]) {
  if (!ids.length) throw new AppError(400, 'foreign_evidence');
  const found = await rows<{ id: string }>(c, sql`SELECT id FROM messages WHERE channel_id=${channelId} AND id = ANY(${sql.param(ids)}::uuid[]) AND deleted_at IS NULL`);
  if (found.length !== ids.length) throw new AppError(400, 'foreign_evidence');
}

// Turn-end path: same title in the channel becomes a new revision. One statement, no explicit lock.
// The unique index knowledge_notes_live_title is the ON CONFLICT arbiter.
export async function saveNoteByTitle(c: DbSession, scope: NoteScope, draft: NoteDraft, producer: NoteProducer): Promise<'saved' | 'unchanged'> {
  const saved = await rows<{ id: string }>(c, sql`
    WITH saved AS (
      INSERT INTO knowledge_notes (id, workspace_id, channel_id, kind, title, content, evidence, producer_id, producer_name)
      VALUES (gen_random_uuid(), ${scope.workspaceId}, ${scope.channelId}, ${draft.kind}, ${draft.title}, ${draft.content}, ${sql.param(draft.message_ids)}::uuid[], ${producer.id}, ${producer.name})
      ON CONFLICT (channel_id, title_key) WHERE removed_at IS NULL DO UPDATE SET
        kind = EXCLUDED.kind, title = EXCLUDED.title, content = EXCLUDED.content, evidence = EXCLUDED.evidence,
        producer_id = EXCLUDED.producer_id, producer_name = EXCLUDED.producer_name, fingerprint = NULL,
        revision = knowledge_notes.revision + 1, updated_at = now()
      WHERE (knowledge_notes.kind, knowledge_notes.content, knowledge_notes.evidence)
        IS DISTINCT FROM (EXCLUDED.kind, EXCLUDED.content, EXCLUDED.evidence)
      RETURNING *
    )
    INSERT INTO knowledge_note_revisions (note_id, revision, kind, title, content, evidence, producer_id, producer_name)
    SELECT id, revision, kind, title, content, evidence, producer_id, producer_name FROM saved
    RETURNING note_id AS id`);
  return saved.length ? 'saved' : 'unchanged';
}

export function noteFingerprint(draft: NoteDraft, producerId: string) {
  return createHash('sha256').update(JSON.stringify({ kind: draft.kind, title: draft.title, content: draft.content, message_ids: draft.message_ids, producer: producerId })).digest('hex');
}
async function noteRow(c: DbSession, id: string) {
  const [row] = await rows<KnowledgeNote & { fingerprint: string | null; removed: boolean }>(c, sql`SELECT ${noteColumns}, fingerprint, removed_at IS NOT NULL AS removed FROM knowledge_notes WHERE id=${id}`);
  return row;
}
const publicNote = ({ fingerprint: _f, removed: _r, ...note }: KnowledgeNote & { fingerprint?: string | null; removed?: boolean }): KnowledgeNote => note;

// MCP path: caller-chosen id. Same id plus same input is a retry; a used title is refused.
export async function addNote(c: DbSession, scope: NoteScope, id: string, draft: NoteDraft, producer: NoteProducer): Promise<KnowledgeNote> {
  await assertNoteEvidence(c, scope.channelId, draft.message_ids);
  const fingerprint = noteFingerprint(draft, producer.id);
  const existing = await noteRow(c, id);
  if (existing) {
    if (existing.channel_id !== scope.channelId || existing.fingerprint !== fingerprint) throw new AppError(409, 'note_id_conflict');
    return publicNote(existing);
  }
  let saved: KnowledgeNote[];
  try {
    saved = await rows<KnowledgeNote>(c, sql`
      WITH saved AS (
        INSERT INTO knowledge_notes (id, workspace_id, channel_id, kind, title, content, evidence, producer_id, producer_name, fingerprint)
        VALUES (${id}, ${scope.workspaceId}, ${scope.channelId}, ${draft.kind}, ${draft.title}, ${draft.content}, ${sql.param(draft.message_ids)}::uuid[], ${producer.id}, ${producer.name}, ${fingerprint})
        ON CONFLICT (channel_id, title_key) WHERE removed_at IS NULL DO NOTHING
        RETURNING *
      ), logged AS (
        INSERT INTO knowledge_note_revisions (note_id, revision, kind, title, content, evidence, producer_id, producer_name)
        SELECT id, revision, kind, title, content, evidence, producer_id, producer_name FROM saved
      )
      SELECT ${noteColumns} FROM saved`);
  } catch (error) {
    // Two retries with the same id raced on the primary key: the second reads the first.
    if (pgCode(error) === '23505') return addNote(c, scope, id, draft, producer);
    throw error;
  }
  if (!saved[0]) throw new AppError(409, 'title_taken');
  return saved[0];
}

async function changed(c: DbSession, channelId: string, id: string, statement: Parameters<DbSession['execute']>[0]): Promise<KnowledgeNote> {
  let saved: KnowledgeNote[];
  try { saved = await rows<KnowledgeNote>(c, statement); }
  catch (error) { if (pgCode(error) === '23505') throw new AppError(409, 'title_taken'); throw error; }
  if (saved[0]) return saved[0];
  const current = await noteRow(c, id);
  if (!current || current.channel_id !== channelId || current.removed) throw new AppError(404, 'note_not_found');
  throw new AppError(409, 'note_conflict');
}

export async function updateNote(c: DbSession, channelId: string, id: string, revision: number, patch: NotePatch, producer: NoteProducer): Promise<KnowledgeNote> {
  if (patch.message_ids) await assertNoteEvidence(c, channelId, patch.message_ids);
  return changed(c, channelId, id, sql`
    WITH saved AS (
      UPDATE knowledge_notes SET kind = coalesce(${patch.kind ?? null}::text, kind), title = coalesce(${patch.title ?? null}::text, title),
        content = coalesce(${patch.content ?? null}::text, content), evidence = coalesce(${patch.message_ids ? sql.param(patch.message_ids) : null}::uuid[], evidence),
        producer_id = ${producer.id}, producer_name = ${producer.name}, fingerprint = NULL, revision = revision + 1, updated_at = now()
      WHERE id = ${id} AND channel_id = ${channelId} AND revision = ${revision} AND removed_at IS NULL
      RETURNING *
    ), logged AS (
      INSERT INTO knowledge_note_revisions (note_id, revision, kind, title, content, evidence, producer_id, producer_name)
      SELECT id, revision, kind, title, content, evidence, producer_id, producer_name FROM saved
    )
    SELECT ${noteColumns} FROM saved`);
}

export async function removeNote(c: DbSession, channelId: string, id: string, revision: number, producer: NoteProducer): Promise<KnowledgeNote> {
  return changed(c, channelId, id, sql`
    WITH saved AS (
      UPDATE knowledge_notes SET removed_at = now(), producer_id = ${producer.id}, producer_name = ${producer.name}, revision = revision + 1, updated_at = now()
      WHERE id = ${id} AND channel_id = ${channelId} AND revision = ${revision} AND removed_at IS NULL
      RETURNING *
    ), logged AS (
      INSERT INTO knowledge_note_revisions (note_id, revision, kind, title, content, evidence, producer_id, producer_name, removed)
      SELECT id, revision, kind, title, content, evidence, producer_id, producer_name, true FROM saved
    )
    SELECT ${noteColumns} FROM saved`);
}

export async function listNoteTitles(c: DbSession, channelId: string): Promise<KnowledgeNotesContext> {
  const found = await rows<KnowledgeNotesContext['notes'][number]>(c, sql`
    SELECT id, kind, title, revision, updated_at::text AS updated_at FROM knowledge_notes
    WHERE channel_id = ${channelId} AND removed_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT ${KNOWLEDGE_TITLES_MAX + 1}`);
  return { channel_id: channelId, notes: found.slice(0, KNOWLEDGE_TITLES_MAX), truncated: found.length > KNOWLEDGE_TITLES_MAX };
}
```

In `adapters/postgres/package.json`, add an export next to `"./layered-memory"`:

```json
    "./knowledge-notes": {
      "types": "./dist/knowledge-notes.d.ts",
      "default": "./dist/knowledge-notes.js"
    },
```

- [ ] **Step 4: Build and run the tests**

Run: `pnpm --filter @space/postgres build && cd tests && TEST_DATABASE_URL=... npx tsx --test integration/knowledge-notes.test.ts`
Expected: PASS, 4 tests.

If the concurrent-save test reports revision 3 instead of 4, both concurrent saves had identical content. Check that the two drafts use `'A'` and `'B'`.

- [ ] **Step 5: Commit**

```bash
git add adapters/postgres/knowledge-notes.ts adapters/postgres/package.json tests/integration/knowledge-notes.test.ts
git commit -m "Add knowledge note store with same-title revisions"
```

---

### Task 4: Switch, access and settings route

**Files:**
- Modify: `adapters/postgres/memory.ts`
- Modify: `apps/server/memory.ts`
- Test: `tests/integration/knowledge-notes.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/knowledge-notes.test.ts`:

```ts
test('managers turn knowledge notes on with their own route; grants and keys work with only Knowledge on', async () => {
  const a = await bootstrap(pool);
  const path = `/channels/${a.channel_id}/memory`;
  assert.equal((await api(a.owner_token, 'GET', path)).knowledge_enabled, false);
  await api(a.collaborator_token, 'POST', `${path}/knowledge`, { enabled: true }, 403);
  await api(a.owner_token, 'POST', `${path}/knowledge`, { enabled: 'yes' }, 400);
  const state = await api(a.owner_token, 'POST', `${path}/knowledge`, { enabled: true });
  assert.equal(state.knowledge_enabled, true);
  assert.equal(state.enabled, false, 'the memory switch is untouched');
  await api(a.owner_token, 'POST', `${path}/agents/${a.installation_id}`, { access: 'contribute' });
  await api(a.owner_token, 'POST', `${path}/connections`, { name: 'Notes key', access: 'contribute', installation_id: a.installation_id }, 201);
  await api(a.owner_token, 'POST', `${path}/knowledge`, { enabled: false });
  await api(a.owner_token, 'POST', `${path}/connections`, { name: 'Late key', access: 'read' }, 409);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd tests && TEST_DATABASE_URL=... npx tsx --test --test-name-pattern="managers turn knowledge" integration/knowledge-notes.test.ts`
Expected: FAIL. The `GET` returns no `knowledge_enabled`, so the first assertion fails.

- [ ] **Step 3: Update `adapters/postgres/memory.ts`**

Change the `MemoryChannel` type:

```ts
export type MemoryChannel = MemoryScope & { enabled: boolean; provider: string; can_manage: boolean; knowledge_enabled: boolean };
```

In `channel()`, change the recheck line to:

```ts
    if (current.enabled !== channel.enabled || current.provider !== channel.provider || current.knowledge_enabled !== channel.knowledge_enabled) throw new AppError(409, 'memory_settings_changed');
```

In `authorize()`, change the returned object to include the switch:

```ts
    return { workspace_id: channel.workspace_id, channel_id: id, enabled: channel.memory_enabled, knowledge_enabled: channel.knowledge_enabled,
      provider: channel.memory_provider, can_manage: member?.guest_type === 'none' && (channel.created_by === actor || member.role === 'owner' || member.role === 'admin') };
```

In `setAgentAccess()`, change `!channel.enabled ||` to `(!channel.enabled && !channel.knowledge_enabled) ||`.

In `createConnection()`, change:

```ts
      else if (!channel.enabled) throw new AppError(409, 'memory_disabled');
```

to:

```ts
      else if (!channel.enabled && !channel.knowledge_enabled) throw new AppError(409, 'memory_disabled');
```

In `connected()`, change:

```ts
        if (!connection.thread_id && !channel.enabled) throw new AppError(409, 'memory_disabled');
```

to:

```ts
        if (!connection.thread_id && !channel.enabled && !channel.knowledge_enabled) throw new AppError(409, 'memory_disabled');
```

The memory document tools still refuse with `memory_disabled` when memory is off, because they go through `memoryProviderFor`, which checks `channel.enabled`.

Move the body of the private `agentAccess` method into an exported function above the class, and make the method delegate to it:

```ts
export async function agentMemoryAccess(c: DbSession, channel: MemoryScope, installationId: string): Promise<{ access: AgentMemoryAccess; revision: number } | undefined> {
  const rows = await c.execute<{ access: AgentMemoryAccess; revision: number; owner_id: string }>(sql`
    SELECT g.access,g.revision,i.owner_id FROM agent_memory_grants g
    JOIN agent_installations i ON i.id=g.installation_id AND i.workspace_id=g.workspace_id
    LEFT JOIN agent_connections ac ON ac.installation_id=i.id
    WHERE g.channel_id=${channel.channel_id} AND g.workspace_id=${channel.workspace_id} AND g.installation_id=${installationId}
      AND g.access<>'none' AND i.enabled AND ac.revoked_at IS NULL
      AND (ac.installation_id IS NOT NULL OR EXISTS (SELECT 1 FROM agent_grants ag JOIN agent_definitions d ON d.id=i.definition_id
        WHERE ag.installation_id=i.id AND ag.channel_id=g.channel_id AND d.capabilities->'skills' ? ag.skill))`);
  const grant = rows.rows[0];
  if (!grant || !await hasChannelAccess(c, grant.owner_id, channel.workspace_id, channel.channel_id)) return undefined;
  return { access: grant.access, revision: grant.revision };
}
```

```ts
  private async agentAccess(c: DbSession, channel: MemoryScope, installationId: string) {
    return agentMemoryAccess(c, channel, installationId);
  }
```

Add a method after `configure()`:

```ts
  async configureKnowledge(c: DbSession, channel: MemoryChannel, enabled: boolean) {
    if (!channel.can_manage) throw new AppError(403, 'channel_management_forbidden');
    await c.update(s.channels).set({ knowledge_enabled: enabled }).where(eq(s.channels.id, channel.channel_id));
    return Object.assign(channel, { knowledge_enabled: enabled });
  }
```

- [ ] **Step 4: Update `apps/server/memory.ts`**

Add `parseKnowledgeSettings` to the existing `@space/contracts` import.

In `state()`, add the switch to the returned object:

```ts
  const state = async (channel: MemoryChannel): Promise<ChannelMemory> => ({
    enabled: channel.enabled, provider: channel.provider, can_manage: channel.can_manage, knowledge_enabled: channel.knowledge_enabled,
```

Keep the remaining lines of `state()` as they are.

Right after the `${path}/settings` route, add:

```ts
  app.post<{ Params: { channelId: string } }>(`${path}/knowledge`, r => {
    const input = parseKnowledgeSettings(r.body);
    return store.channel(r.actorId, r.params.channelId, async (channel, c) => state(await store.configureKnowledge(c, channel, input.enabled)));
  });
```

- [ ] **Step 5: Build and run the tests**

Run: `pnpm --filter @space/postgres --filter @space/server build && cd tests && TEST_DATABASE_URL=... npx tsx --test integration/knowledge-notes.test.ts integration/agent-memory.test.ts integration/memory.test.ts`
Expected: PASS for all three files. `agent-memory` and `memory` prove the memory switch still behaves as before.

- [ ] **Step 6: Commit**

```bash
git add adapters/postgres/memory.ts apps/server/memory.ts tests/integration/knowledge-notes.test.ts
git commit -m "Add the Knowledge switch with its own manager route"
```

---

### Task 5: MCP tools

**Files:**
- Modify: `apps/server/memory-mcp.ts`
- Test: `tests/integration/knowledge-notes.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/knowledge-notes.test.ts`:

```ts
async function connect(token: string) {
  const client = new Client({ name: 'knowledge-notes-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp/memory`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
function data(result: any) { assert.notEqual(result.isError, true, JSON.stringify(result)); return JSON.parse(result.content[0].text); }
function code(result: any) { assert.equal(result.isError, true, JSON.stringify(result)); return result.content[0].text as string; }
async function knowledgeKey(token: string, channel: string, access: 'read' | 'contribute' | 'write', installation?: string) {
  const path = `/channels/${channel}/memory`;
  await api(token, 'POST', `${path}/knowledge`, { enabled: true });
  if (installation) await api(token, 'POST', `${path}/agents/${installation}`, { access: access === 'read' ? 'read' : 'contribute' });
  return (await api(token, 'POST', `${path}/connections`, { name: `Key ${randomUUID().slice(0, 8)}`, access, ...(installation ? { installation_id: installation } : {}) }, 201)).token as string;
}

test('knowledge tools over a real MCP client: contribute adds, write edits, the switch hides them', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Dedupe on idempotency_key');
  const contribute = await connect(await knowledgeKey(a.owner_token, a.channel_id, 'contribute', a.installation_id));
  const write = await connect(await knowledgeKey(a.owner_token, a.channel_id, 'write'));
  try {
    const names = (await contribute.listTools()).tools.map(t => t.name);
    assert.ok(names.includes('knowledge_add') && names.includes('knowledge_list'));
    assert.ok(!names.includes('knowledge_update') && !names.includes('knowledge_remove'));
    const id = randomUUID();
    const args = { id, kind: 'decision', title: 'Duplicate charge fix', content: 'Dedupe on idempotency_key.', message_ids: [root.id] };
    assert.equal(data(await contribute.callTool({ name: 'knowledge_add', arguments: args })).revision, 1);
    assert.equal(code(await contribute.callTool({ name: 'knowledge_add', arguments: { ...args, id: randomUUID() } })), 'title_taken');
    assert.equal(data(await write.callTool({ name: 'knowledge_list', arguments: {} })).notes[0].id, id);
    assert.equal(code(await write.callTool({ name: 'knowledge_update', arguments: { id, revision: 9, content: 'x' } })), 'note_conflict');
    assert.equal(data(await write.callTool({ name: 'knowledge_update', arguments: { id, revision: 1, content: 'Dedupe in Postgres.' } })).revision, 2);
    assert.equal(data(await write.callTool({ name: 'knowledge_remove', arguments: { id, revision: 2 } })).revision, 3);
    await api(a.owner_token, 'POST', `/channels/${a.channel_id}/memory/knowledge`, { enabled: false });
    const off = await contribute.callTool({ name: 'knowledge_add', arguments: { ...args, id: randomUUID(), title: 'Later' } });
    assert.ok(off.isError, 'tools stop once the switch is off');
  } finally { await contribute.close(); await write.close(); }
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd tests && TEST_DATABASE_URL=... npx tsx --test --test-name-pattern="knowledge tools over a real MCP" integration/knowledge-notes.test.ts`
Expected: FAIL. `knowledge_add` is not in the tool list.

- [ ] **Step 3: Register the tools in `apps/server/memory-mcp.ts`**

Change the contracts import to add the note helpers:

```ts
import { AppError, MAX_MEMORY_CHARS, NOTE_KINDS, parseNoteDraft, parseNotePatch, parseThreadCheckpoint, uuid, type MemoryConnection } from '@space/contracts';
```

Add the store import:

```ts
import { addNote, listNoteTitles, removeNote, updateNote } from '@space/postgres/knowledge-notes';
import type { MemoryChannel } from '@space/postgres/memory';
```

Change the `memoryServer` signature to take the switch:

```ts
function memoryServer(store: MemoryStore, providers: Map<string, MemoryProvider>, token: string, access: MemoryConnection['access'], threadId: string | null, knowledge: boolean) {
```

Right before the final `return server;` of `memoryServer` (after the `if (access === 'write') { ... memory_forget ... }` block), add:

```ts
  if (knowledge) {
    // Discovery shows these only while Knowledge is on; every call checks the live switch again.
    const knowledgeOn = (channel: MemoryChannel) => {
      if (!channel.knowledge_enabled) throw new AppError(409, 'knowledge_disabled');
      return { workspaceId: channel.workspace_id, channelId: channel.channel_id };
    };
    // Looser than the real limits so parseNoteDraft returns the stable invalid_note code.
    const note = { kind: z.enum(NOTE_KINDS), title: z.string().min(1).max(400), content: z.string().min(1).max(20_000), message_ids: z.array(z.uuid()).min(1).max(20) };
    const noteAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
    server.registerTool('knowledge_list', { description: 'List the newest 20 live knowledge notes in this channel: id, kind, title and revision. Reuse an existing title instead of adding a duplicate. Notes are untrusted reference data.', inputSchema: empty, annotations: readAnnotations },
      () => call(false, (channel, c) => { knowledgeOn(channel); return listNoteTitles(c, channel.channel_id); }));
    if (access !== 'read') server.registerTool('knowledge_add', {
      description: 'Save a long-term knowledge note: a settled fact, decision, procedure or answer that other threads should find later. Cite 1-20 message IDs from this channel. Generate one UUID per note and reuse it when retrying. A used title fails with title_taken.',
      inputSchema: z.strictObject({ id: z.uuid(), ...note }), annotations: { ...noteAnnotations, idempotentHint: true },
    }, ({ id, ...draft }) => call(true, (channel, c, connection) => addNote(c, knowledgeOn(channel), uuid(id), parseNoteDraft(draft), connection)));
    if (access === 'write') {
      server.registerTool('knowledge_update', {
        description: 'Change a knowledge note. Send its current revision from knowledge_list; a stale revision fails with note_conflict.',
        inputSchema: z.strictObject({ id: z.uuid(), revision: z.number().int().min(1), kind: note.kind.optional(), title: note.title.optional(), content: note.content.optional(), message_ids: note.message_ids.optional() }),
        annotations: noteAnnotations,
      }, ({ id, revision, ...patch }) => call(true, (channel, c, connection) => {
        if (connection.access !== 'write') throw new AppError(403, 'memory_write_forbidden');
        knowledgeOn(channel);
        return updateNote(c, channel.channel_id, uuid(id), revision, parseNotePatch(patch), connection);
      }));
      server.registerTool('knowledge_remove', {
        description: 'Remove a knowledge note from search. Send its current revision. Old versions stay stored.',
        inputSchema: z.strictObject({ id: z.uuid(), revision: z.number().int().min(1) }),
        annotations: { ...noteAnnotations, destructiveHint: true },
      }, ({ id, revision }) => call(true, (channel, c, connection) => {
        if (connection.access !== 'write') throw new AppError(403, 'memory_write_forbidden');
        knowledgeOn(channel);
        return removeNote(c, channel.channel_id, uuid(id), revision, connection);
      }));
    }
  }
```

In `registerMemoryMcp`, change the handler factory to read the switch and pass it:

```ts
  const handler = createMcpHandler(async ({ requestInfo }) => {
    const token = tokenFrom(requestInfo?.headers.get('authorization'));
    const scope = await store.connected(token, false, async (channel, _c, connection) => ({ ...connection, knowledge_enabled: channel.knowledge_enabled }));
    return memoryServer(store, providers, token!, scope.access, scope.thread_id, !scope.thread_id && scope.knowledge_enabled);
  });
```

Thread-scoped keys return early inside `memoryServer`, so they never see Knowledge tools.

- [ ] **Step 4: Build and run the tests**

Run: `pnpm --filter @space/server build && cd tests && TEST_DATABASE_URL=... npx tsx --test integration/knowledge-notes.test.ts integration/memory-mcp.test.ts integration/layered-memory.test.ts`
Expected: PASS for all three files.

- [ ] **Step 5: Commit**

```bash
git add apps/server/memory-mcp.ts tests/integration/knowledge-notes.test.ts
git commit -m "Add knowledge note tools to the channel MCP endpoint"
```

---

### Task 6: Save block notes at turn end

**Files:**
- Modify: `adapters/postgres/knowledge-notes.ts`
- Modify: `adapters/postgres/turn-trace.ts`
- Modify: `adapters/postgres/store.ts` (`acceptEvent`)
- Test: `tests/integration/knowledge-notes.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/knowledge-notes.test.ts`:

```ts
import { saveTurnNotes } from '@space/postgres/knowledge-notes';
import type { AgentEvent } from '@space/contracts';

test('turn notes need the switch and a contribute grant, and evidence from this channel', async () => {
  const a = await bootstrap(pool), b = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Dedupe on idempotency_key');
  const foreign = await post(b.owner_token, b.channel_id, 'Elsewhere');
  const path = `/channels/${a.channel_id}/memory`;
  const input = (notes: any[]) => ({ channelId: a.channel_id, installationId: a.installation_id, producer: codex, notes, fallbackMessageId: root.id });
  const plain = { kind: 'decision' as const, title: 'Duplicate charge fix', content: 'Dedupe.', message_ids: [] };
  assert.deepEqual(await saveTurnNotes(db(), input([plain])), ['knowledge_disabled']);
  await api(a.owner_token, 'POST', `${path}/knowledge`, { enabled: true });
  assert.deepEqual(await saveTurnNotes(db(), input([plain])), ['no_grant']);
  await api(a.owner_token, 'POST', `${path}/agents/${a.installation_id}`, { access: 'contribute' });
  assert.deepEqual(await saveTurnNotes(db(), input([plain, { ...plain, title: 'Other', message_ids: [foreign.id] }])), ['saved', 'foreign_evidence']);
  assert.deepEqual(await saveTurnNotes(db(), input([plain])), ['unchanged']);
  const [row] = (await pool.query('SELECT evidence FROM knowledge_notes WHERE channel_id=$1', [a.channel_id])).rows;
  assert.deepEqual(row.evidence, [root.id], 'empty evidence falls back to the latest human message');
});

function agentEvent(executionId: string, sequence: number, type: AgentEvent['type'], payload: AgentEvent['payload']): AgentEvent {
  return { id: randomUUID(), schema_version: '1.0', execution_id: executionId, sequence, type, occurred_at: new Date().toISOString(), payload };
}

test('a completed turn saves block notes in the same transaction as checkpoints', async () => {
  const a = await bootstrap(pool);
  const path = `/channels/${a.channel_id}/memory`;
  await api(a.owner_token, 'POST', `${path}/knowledge`, { enabled: true });
  await api(a.owner_token, 'POST', `${path}/agents/${a.installation_id}`, { access: 'contribute' });
  await post(a.owner_token, a.channel_id, 'Retries cause duplicate charges', a.thread_id);
  const task = await store.createTask(a.owner_id, { workspace_id: a.workspace_id, thread_id: a.thread_id, installation_id: a.installation_id, goal: 'Fix', skill: 'demo.echo' }, randomUUID());
  const approved = await store.approveTask(a.owner_id, task.id);
  await store.acceptEvent(a.installation_id, agentEvent(approved.active_execution_id!, 1, 'execution.started', { text: 'Working' }));
  await store.acceptEvent(a.installation_id, agentEvent(approved.active_execution_id!, 2, 'execution.completed', { text: 'Done', response: {
    messages: [], tools: [], components: [],
    memory: { notes: [{ kind: 'decision', title: 'Duplicate charge fix', content: 'Dedupe on idempotency_key.', message_ids: [] }] },
  } as any }));
  const notes = (await pool.query('SELECT title, producer_id FROM knowledge_notes WHERE channel_id=$1', [a.channel_id])).rows;
  assert.deepEqual(notes, [{ title: 'Duplicate charge fix', producer_id: a.installation_id }]);
});
```

`bootstrap()` returns a seeded `thread_id`, the same one `agent-memory.test.ts` uses for tasks.

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd tests && TEST_DATABASE_URL=... npx tsx --test --test-name-pattern="turn notes|completed turn saves" integration/knowledge-notes.test.ts`
Expected: FAIL with `saveTurnNotes is not a function`.

- [ ] **Step 3: Add `saveTurnNotes` to `adapters/postgres/knowledge-notes.ts`**

Add the imports:

```ts
import { agentMemoryAccess } from './memory.js';
```

Add at the end of the file:

```ts
export type TurnNoteOutcome = 'saved' | 'unchanged' | 'knowledge_disabled' | 'no_grant' | 'foreign_evidence';

// Called inside the execution.completed transaction. It never throws for a bad note:
// evidence is checked with a plain SELECT before the insert, so the transaction stays usable.
export async function saveTurnNotes(c: DbSession, input: { channelId: string; installationId: string; producer: NoteProducer; notes: NoteDraft[]; fallbackMessageId: string | null }): Promise<TurnNoteOutcome[]> {
  if (!input.notes.length) return [];
  const [channel] = await rows<{ workspace_id: string; knowledge_enabled: boolean; kind: string }>(c, sql`SELECT workspace_id, knowledge_enabled, kind FROM channels WHERE id=${input.channelId}`);
  if (!channel || channel.kind !== 'channel' || !channel.knowledge_enabled) return input.notes.map(() => 'knowledge_disabled');
  const grant = await agentMemoryAccess(c, { workspace_id: channel.workspace_id, channel_id: input.channelId }, input.installationId);
  if (grant?.access !== 'contribute') return input.notes.map(() => 'no_grant');
  const results: TurnNoteOutcome[] = [];
  for (const note of input.notes) {
    const message_ids = note.message_ids.length ? note.message_ids : input.fallbackMessageId ? [input.fallbackMessageId] : [];
    try { await assertNoteEvidence(c, input.channelId, message_ids); }
    catch (error) { if (error instanceof AppError) { results.push('foreign_evidence'); continue; } throw error; }
    results.push(await saveNoteByTitle(c, { workspaceId: channel.workspace_id, channelId: input.channelId }, { ...note, message_ids }, input.producer));
  }
  return results;
}
```

- [ ] **Step 4: Add the trace phase**

In `adapters/postgres/turn-trace.ts`, add to `TurnStatus`:

```ts
  note: 'saved' | 'unchanged' | 'knowledge_disabled' | 'no_grant' | 'foreign_evidence';
```

- [ ] **Step 5: Call it from `acceptEvent` in `adapters/postgres/store.ts`**

Add the import next to the `layered-memory.js` import:

```ts
import { saveTurnNotes } from './knowledge-notes.js';
```

Inside the `if (memory) { ... }` block, after the `for (const { scope, outcome } of outcomes) ...` line, add:

```ts
          if (memory.notes?.length) {
            const [human] = (await c.execute<{ id: string }>(sql`SELECT id FROM messages WHERE channel_id=${thread.channel_id} AND thread_id=${task.thread_id} AND author_type='human' AND deleted_at IS NULL ORDER BY sequence DESC LIMIT 1`)).rows;
            const notes = await saveTurnNotes(c, { channelId: thread.channel_id, installationId, producer: { id: installationId, name: definition?.name ?? 'Agent' }, notes: memory.notes, fallbackMessageId: human?.id ?? null });
            for (const outcome of notes) traceTurn(c, task.id, 'note', outcome);
          }
```

- [ ] **Step 6: Build and run the tests**

Run: `pnpm --filter @space/postgres build && cd tests && TEST_DATABASE_URL=... npx tsx --test integration/knowledge-notes.test.ts integration/layered-memory.test.ts integration/task-flow.test.ts`
Expected: PASS for all three files.

- [ ] **Step 7: Commit**

```bash
git add adapters/postgres/knowledge-notes.ts adapters/postgres/turn-trace.ts adapters/postgres/store.ts tests/integration/knowledge-notes.test.ts
git commit -m "Save turn-end notes with the checkpoints"
```

---

### Task 7: Note titles in task context

**Files:**
- Modify: `adapters/postgres/knowledge-notes.ts`
- Modify: `adapters/postgres/store.ts` (`prepareDelivery`)
- Test: `tests/integration/knowledge-notes.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/knowledge-notes.test.ts`:

```ts
import { parseInvocation } from '@space/contracts';

async function prepared(a: Awaited<ReturnType<typeof bootstrap>>) {
  const task = await store.createTask(a.owner_id, { workspace_id: a.workspace_id, thread_id: a.thread_id, installation_id: a.installation_id, goal: 'Read notes', skill: 'demo.echo' }, randomUUID());
  await store.approveTask(a.owner_id, task.id);
  const outbox = (await pool.query('SELECT id FROM outbox WHERE task_id=$1', [task.id])).rows[0];
  const delivery = await store.claimDelivery(undefined, outbox.id);
  assert.ok(delivery); return store.prepareDelivery(delivery);
}

test('task context lists note titles only with the switch on and a read grant', async () => {
  const a = await bootstrap(pool);
  const root = await post(a.owner_token, a.channel_id, 'Evidence');
  const path = `/channels/${a.channel_id}/memory`;
  await saveNoteByTitle(db(), { workspaceId: a.workspace_id, channelId: a.channel_id }, draft(root.id), codex);
  assert.equal((await prepared(a))?.request.context?.knowledge_notes, undefined, 'switch off');
  await api(a.owner_token, 'POST', `${path}/knowledge`, { enabled: true });
  assert.equal((await prepared(a))?.request.context?.knowledge_notes, undefined, 'no grant');
  await api(a.owner_token, 'POST', `${path}/agents/${a.installation_id}`, { access: 'read' });
  const result = (await prepared(a))!;
  assert.equal(result.request.context?.knowledge_notes?.notes[0]?.title, 'Duplicate charge fix');
  assert.deepEqual(parseInvocation(result.request), result.request, 'connectors accept the field');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd tests && TEST_DATABASE_URL=... npx tsx --test --test-name-pattern="task context lists note titles" integration/knowledge-notes.test.ts`
Expected: FAIL at the `read` grant assertion: `knowledge_notes` is undefined.

- [ ] **Step 3: Add `readKnowledgeContext` to `adapters/postgres/knowledge-notes.ts`**

Add the import:

```ts
import { hasChannelAccess } from './access.js';
```

Add at the end of the file:

```ts
// Titles come from Space only, so they reach the agent even when the provider or Ollama is down.
export async function readKnowledgeContext(c: DbSession, channelId: string, task: { installation_id: string; requester_id: string }): Promise<KnowledgeNotesContext | undefined> {
  const [channel] = await rows<{ workspace_id: string; knowledge_enabled: boolean; kind: string }>(c, sql`SELECT workspace_id, knowledge_enabled, kind FROM channels WHERE id=${channelId}`);
  if (!channel || channel.kind !== 'channel' || !channel.knowledge_enabled) return undefined;
  if (!await hasChannelAccess(c, task.requester_id, channel.workspace_id, channelId)) return undefined;
  if (!await agentMemoryAccess(c, { workspace_id: channel.workspace_id, channel_id: channelId }, task.installation_id)) return undefined;
  return listNoteTitles(c, channelId);
}
```

- [ ] **Step 4: Call it from `prepareDelivery` in `adapters/postgres/store.ts`**

Change the import from Task 6 to:

```ts
import { readKnowledgeContext, saveTurnNotes } from './knowledge-notes.js';
```

Right after `context.channel_memory = await readChannelMemory(c, thread.channel_id);`, add:

```ts
      const notes = await readKnowledgeContext(c, thread.channel_id, task);
      if (notes) context.knowledge_notes = notes;
```

- [ ] **Step 5: Build and run the tests**

Run: `pnpm --filter @space/postgres build && cd tests && TEST_DATABASE_URL=... npx tsx --test integration/knowledge-notes.test.ts integration/agent-memory.test.ts integration/connected-agent-access.test.ts`
Expected: PASS for all three files.

- [ ] **Step 6: Commit**

```bash
git add adapters/postgres/knowledge-notes.ts adapters/postgres/store.ts tests/integration/knowledge-notes.test.ts
git commit -m "Send the newest note titles in task context"
```

---

### Task 8: Connector instructions

**Files:**
- Modify: `apps/connector/memory-instructions.ts`
- Test: `apps/connector/test/memory-block.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `apps/connector/test/memory-block.test.mjs`:

```js
test('instructions describe notes only when knowledge_notes is supplied', () => {
  const base = { thread_id: 't', messages: [], working_memory: { checkpoint: null } };
  assert.doesNotMatch(memoryInstructions(base), /"notes"/);
  const text = memoryInstructions({ ...base, knowledge_notes: { channel_id: 'c', notes: [{ title: 'Duplicate charge fix' }], truncated: true } });
  assert.match(text, /"notes":\[/);
  assert.match(text, /At most 3 notes/);
  assert.match(text, /Reuse a title/);
  assert.match(text, /search knowledge first/);
});

test('notes in the block stay hidden from people', () => {
  const progress = new AgentProgress();
  const block = '<space-memory>{"notes":[{"kind":"fact","title":"T","content":"C"}]}</space-memory>';
  const final = progress.snapshot([{ id: 'm', text: `Answer.\n${block}`, status: 'complete' }], true);
  assert.equal(final.messages[0].text, 'Answer.');
  assert.equal(final.memory.notes[0].title, 'T');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @space/contracts build && pnpm --filter @space/connector test`
Expected: FAIL on `instructions describe notes only when knowledge_notes is supplied`. The second test may already pass because the contract parses notes since Task 2.

- [ ] **Step 3: Update `apps/connector/memory-instructions.ts`**

Replace the file with:

```ts
import type { InvocationRequest } from '@space/contracts';

type Revisioned = { checkpoint?: { revision: number } | null };
type Titles = { notes: unknown[]; truncated: boolean };
type Context = InvocationRequest['context'] | { working_memory?: Revisioned; agent_session_memory?: Revisioned; knowledge_notes?: Titles } | undefined;

// The block rides on the agent's own final answer, so saving memory costs no extra model call.
export function memoryInstructions(context: Context): string {
  if (!context) return '';
  const thread = context.working_memory?.checkpoint?.revision ?? 0;
  const session = context.agent_session_memory ? context.agent_session_memory.checkpoint?.revision ?? 0 : undefined;
  const knowledge = context.knowledge_notes;
  return `\n\nAfter your answer, add one hidden memory block. People never see it:\n<space-memory>{"thread":{"base_revision":N,"summary":"…","content":"…"}${session === undefined ? '' : ',"session":{"base_revision":N,"summary":"…","content":"…"}'}}</space-memory>\n`
    + `Use thread base_revision ${thread}${session === undefined ? '' : ` and session base_revision ${session}`}. `
    + 'Each content replaces the whole checkpoint: keep decisions, open questions and progress, drop finished items, at most 6000 characters. Each summary is one line of at most 280 characters. '
    + 'Leave out a layer that did not change. If memory_conflicts is present, merge it into your update.'
    + (knowledge ? ' You may also add "notes":[{"kind":"fact|decision|procedure|answer","title":"…","content":"…","message_ids":["…"]}] for settled knowledge that other threads should find later. '
      + 'At most 3 notes, each at most 2000 characters, citing message IDs from this channel. Reuse a title from knowledge_notes to update that note instead of adding a new one.'
      + (knowledge.truncated ? ' The title list is truncated, so search knowledge first before adding a new title.' : '') : '');
}
```

- [ ] **Step 4: Run the connector tests**

Run: `pnpm --filter @space/connector test`
Expected: PASS, all connector tests (134 before this change, now 136).

- [ ] **Step 5: Commit**

```bash
git add apps/connector/memory-instructions.ts apps/connector/test/memory-block.test.mjs
git commit -m "Tell connectors how to write knowledge notes at turn end"
```

---

### Task 9: Knowledge switch in the Memory dialog

**Files:**
- Create: `apps/web/src/features/memory/KnowledgeSwitch.tsx`
- Create: `apps/web/src/features/memory/KnowledgeSwitch.test.tsx`
- Modify: `apps/web/src/features/memory/ChannelMemory.tsx` (settings block)

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/features/memory/KnowledgeSwitch.test.tsx`:

```tsx
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KnowledgeSwitch } from './KnowledgeSwitch.js';

const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('turns knowledge notes on through its own route', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ enabled: false, knowledge_enabled: true, provider: 'markdown', can_manage: true, providers: [], document: null })));
  const onChange = vi.fn();
  render(<KnowledgeSwitch path="/channels/c/memory" enabled={false} onChange={onChange} />);
  await userEvent.click(screen.getByRole('switch', { name: 'Knowledge notes' }));
  const [path, options] = vi.mocked(fetch).mock.calls[0]!;
  expect(String(path)).toBe('/v1/channels/c/memory/knowledge');
  expect(JSON.parse((options as RequestInit).body as string)).toEqual({ enabled: true });
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ knowledge_enabled: true }));
});

it('shows the error code in words when the change fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'channel_management_forbidden' }, 403)));
  render(<KnowledgeSwitch path="/channels/c/memory" enabled={false} onChange={() => {}} />);
  await userEvent.click(screen.getByRole('switch', { name: 'Knowledge notes' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('channel management forbidden');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @space/web exec vitest run src/features/memory/KnowledgeSwitch.test.tsx`
Expected: FAIL with `Failed to resolve import "./KnowledgeSwitch.js"`.

- [ ] **Step 3: Create `apps/web/src/features/memory/KnowledgeSwitch.tsx`**

```tsx
import { useState } from 'react';
import { Switch } from '@space/ui/primitives';
import type { ChannelMemory } from '@space/contracts';
import { request } from '../../shared/api/request.js';

type Props = { path: string; enabled: boolean; onChange: (state: ChannelMemory) => void };

// Knowledge notes are long-term and have their own switch, separate from channel memory.
export function KnowledgeSwitch({ path, enabled, onChange }: Props) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function change(value: boolean) {
    setBusy(true); setError('');
    try { onChange(await request<ChannelMemory>(`${path}/knowledge`, { enabled: value })); }
    catch (e) { setError(e instanceof Error ? e.message.replaceAll('_', ' ') : 'Unable to change knowledge notes'); }
    finally { setBusy(false); }
  }
  return <div className="channel-memory-knowledge">
    <Switch label="Knowledge notes" checked={enabled} disabled={busy} onChange={value => void change(value)} />
    <p>Agents with contribute access can save settled facts as notes. Anyone who can see this channel can find them.</p>
    {error && <p role="alert">{error}</p>}
  </div>;
}
```

- [ ] **Step 4: Render it in `ChannelMemory.tsx`**

Re-read `apps/web/src/features/memory/ChannelMemory.tsx` first, because the memory graph UI work changes it.

Add the import next to the `MemoryConnections` import:

```tsx
import { KnowledgeSwitch } from './KnowledgeSwitch.js';
```

Find the settings block that starts with `{data.can_manage && <div className="channel-memory-settings">`. Inside it, directly after the closing `</div>` of the first `<div className="channel-memory-actions">` (the one with **Enable memory** / **Disable memory**), add:

```tsx
          <KnowledgeSwitch path={path} enabled={data.knowledge_enabled} onChange={result => {
            if (active.current) setData(previous => previous ? { ...previous, knowledge_enabled: result.knowledge_enabled } : previous);
          }} />
```

- [ ] **Step 5: Run the web tests and typecheck**

Run: `pnpm --filter @space/web exec vitest run src/features/memory && pnpm --filter @space/web typecheck`
Expected: PASS. Existing `ChannelMemory.test.tsx` fixtures lack `knowledge_enabled`; the switch then renders unchecked, which those tests ignore.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/memory/KnowledgeSwitch.tsx apps/web/src/features/memory/KnowledgeSwitch.test.tsx apps/web/src/features/memory/ChannelMemory.tsx
git commit -m "Add the Knowledge notes switch to the Memory dialog"
```

---

### Task 10: Index and search notes in the pg-knowledge provider

**Files:**
- Create: `apps/mcp-gateway/providers/pg-knowledge/notes.sql`
- Create: `apps/mcp-gateway/providers/pg-knowledge/notes-sync.mjs`
- Create: `apps/mcp-gateway/providers/pg-knowledge/notes-search.mjs`
- Create: `apps/mcp-gateway/providers/pg-knowledge/notes-smoke.mjs`
- Modify: `apps/mcp-gateway/providers/pg-knowledge/thread-worker.mjs`
- Modify: `apps/mcp-gateway/providers/pg-knowledge/server.mjs`

This task needs a disposable provider index database built from the provider image, with `schema.sql`, `threads.sql` and `notes.sql` installed, plus local Ollama with `all-minilm:22m`. Use throwaway containers. Do not touch the dev databases.

- [ ] **Step 1: Write the failing smoke test**

Create `apps/mcp-gateway/providers/pg-knowledge/notes-smoke.mjs`:

```js
// Run with TEST_DATABASE_URL (Space test DB), THREAD_INDEX_URL (index writer) and
// KNOWLEDGE_DATABASE_URL (index reader) for a disposable index with notes.sql installed.
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
import { removeNote, saveNoteByTitle, listNoteTitles } from '@space/postgres/knowledge-notes';
import { searchNotes } from './notes-search.mjs';
const schema = 'notes_test_' + randomUUID().replaceAll('-', '');
const admin = createPool(process.env.TEST_DATABASE_URL), index = createPool(process.env.THREAD_INDEX_URL), reader = createPool(process.env.KNOWLEDGE_DATABASE_URL);
const url = new URL(process.env.TEST_DATABASE_URL);
url.searchParams.set('options', '-c search_path=' + schema);
const source = createPool(url.href);
let worker;
async function stop() {
  if (worker && worker.exitCode === null && worker.signalCode === null) { const ended = once(worker, 'exit'); worker.kill(); await ended; }
}
async function until(fn) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await fn()) return; await delay(150); }
  throw Error('Timed out waiting for the index');
}
try {
  await admin.query('CREATE SCHEMA ' + schema);
  await migrate(source);
  const seed = await bootstrap(source), chat = new ChatStore(source), db = database(source);
  const root = await chat.send(seed.owner_id, seed.channel_id, { client_message_id: randomUUID(), text: 'Checkout retries cause duplicate charges.' });
  await source.query('UPDATE channels SET knowledge_enabled=true WHERE id=$1', [seed.channel_id]);
  const scope = { workspaceId: seed.workspace_id, channelId: seed.channel_id }, codex = { id: 'codex', name: 'Codex' };
  await saveNoteByTitle(db, scope, { kind: 'decision', title: 'Duplicate charge fix', content: 'Dedupe charges on the juniper idempotency key.', message_ids: [root.id] }, codex);
  const start = () => { worker = spawn(process.execPath, [fileURLToPath(new URL('./thread-worker.mjs', import.meta.url))], {
    env: { ...process.env, THREAD_SOURCE_URL: url.href, KNOWLEDGE_WORKSPACE_ID: seed.workspace_id }, stdio: ['ignore', 'ignore', 'inherit'] }); };
  start();
  const indexed = async () => (await index.query('SELECT id, revision FROM kb.notes WHERE workspace_id=$1', [seed.workspace_id])).rows;
  await until(async () => (await indexed()).length === 1);
  const context = { workspaceId: seed.workspace_id, requesterId: seed.owner_id, connectionId: randomUUID(), audience: { channelId: seed.channel_id } };
  const { embeddings: [vector] } = await (await fetch('http://127.0.0.1:11434/api/embed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'all-minilm:22m', input: 'juniper duplicate charges' }) })).json();
  const hits = async (requester = seed.owner_id) => searchNotes(reader, source, { ...context, requesterId: requester }, 'juniper duplicate charges', vector, 5);
  const [hit] = await hits();
  assert.equal(hit?.title, 'Duplicate charge fix');
  assert.ok(hit.citation.url.includes(root.id), 'cites the first evidence message');
  assert.deepEqual(await hits(randomUUID()), [], 'unknown requester sees nothing');
  await saveNoteByTitle(db, scope, { kind: 'decision', title: 'Duplicate charge fix', content: 'Dedupe charges on the cedar idempotency key.', message_ids: [root.id] }, codex);
  await until(async () => (await indexed())[0]?.revision === 2);
  assert.match((await hits())[0].evidence, /cedar/);
  await stop();
  const note = (await listNoteTitles(db, seed.channel_id)).notes[0];
  await removeNote(db, seed.channel_id, note.id, note.revision, codex);
  assert.deepEqual(await hits(), [], 'removed notes are hidden even while the worker is offline');
  start();
  await until(async () => !(await indexed()).length);
  console.log('PASS: backfill, live update, citation, unknown requester, removal while offline, restart recovery.');
} finally {
  await stop(); await source.end(); await index.end(); await reader.end();
  await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await admin.end();
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @space/postgres build && cd apps/mcp-gateway/providers/pg-knowledge && TEST_DATABASE_URL=... THREAD_INDEX_URL=... KNOWLEDGE_DATABASE_URL=... node notes-smoke.mjs`
Expected: FAIL with `Cannot find module './notes-search.mjs'`.

- [ ] **Step 3: Create `notes.sql`**

```sql
-- Apply once after schema.sql (and threads.sql when thread search is used).
BEGIN;
CREATE TABLE kb.notes (
 id text PRIMARY KEY, workspace_id uuid NOT NULL, channel_id uuid NOT NULL,
 revision integer NOT NULL, body text NOT NULL, embedding pgcontext.vector(384) NOT NULL
);
CREATE INDEX ON kb.notes(workspace_id, channel_id, id);
CREATE ROLE space_note_collection NOLOGIN;
GRANT space_note_collection TO space_knowledge_reader;
GRANT USAGE ON SCHEMA kb, pgcontext TO space_note_collection;
GRANT SELECT ON kb.notes TO space_note_collection;
SET SESSION AUTHORIZATION space_note_collection;
SELECT pgcontext.create_collection('kb_notes', 'kb.notes');
SELECT pgcontext.register_vector('kb_notes', 'embedding', 'embedding', 384, 'cosine');
SELECT pgcontext.register_lexical_source('kb_notes', 'text', ARRAY['body']);
RESET SESSION AUTHORIZATION;
COMMIT;
```

Install it in the disposable index: `psql -X -v ON_ERROR_STOP=1 -f notes.sql "$INSTALLER_URL"`. Give the worker login membership in `space_note_collection` and SELECT/INSERT/UPDATE/DELETE on `kb.notes`. In the Space test database, give the worker's source login SELECT on `knowledge_note_sources` and the provider lookup login EXECUTE on `knowledge_visible_notes(uuid,uuid,uuid,uuid[])`. When every login is a superuser in a throwaway container, skip the grants.

- [ ] **Step 4: Create `notes-sync.mjs`**

```js
// Copies live Space notes into kb.notes. Reads go through knowledge_note_sources, so removed notes,
// archived channels and switched-off channels drop out on the next sync or reconcile.
const pageSize = 32;
const body = row => row.title + '\n' + row.content;

export async function syncNotes(source, index, workspace, ids, embed) {
  if (!ids.length) return;
  const { rows } = await source.query('SELECT id::text AS id, channel_id, revision, title, content FROM knowledge_note_sources WHERE workspace_id=$1 AND id=ANY($2::uuid[])', [workspace, ids]);
  const { rows: existing } = await index.query('SELECT id, revision FROM kb.notes WHERE workspace_id=$1 AND id=ANY($2::text[])', [workspace, ids]);
  const old = new Map(existing.map(row => [row.id, row.revision]));
  const live = new Set(rows.map(row => row.id));
  const removed = existing.filter(row => !live.has(row.id)).map(row => row.id);
  const changed = rows.filter(row => old.get(row.id) !== row.revision);
  if (!removed.length && !changed.length) return;
  const vectors = changed.length ? await embed(changed.map(body)) : [];
  const client = await index.connect();
  try {
    await client.query('BEGIN');
    if (removed.length) {
      await client.query("SELECT pgcontext.delete_points('kb_notes',$1::text[])", [removed]);
      await client.query('DELETE FROM kb.notes WHERE workspace_id=$1 AND id=ANY($2::text[])', [workspace, removed]);
    }
    for (const [i, row] of changed.entries()) {
      await client.query(`INSERT INTO kb.notes(id,workspace_id,channel_id,revision,body,embedding) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (id) DO UPDATE SET revision=EXCLUDED.revision, body=EXCLUDED.body, embedding=EXCLUDED.embedding
        WHERE kb.notes.revision <= EXCLUDED.revision`, [row.id, workspace, row.channel_id, row.revision, body(row), JSON.stringify(vectors[i])]);
    }
    if (changed.length) await client.query("SELECT pgcontext.upsert_points('kb_notes',$1::text[])", [changed.map(row => row.id)]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// Bounded pages in both directions: drop index rows that left the source, then add missing or older rows.
export async function reconcileNotes(source, index, workspace, embed) {
  let after = '';
  for (;;) {
    const { rows } = await index.query('SELECT id FROM kb.notes WHERE workspace_id=$1 AND id>$2 ORDER BY id LIMIT $3', [workspace, after, pageSize]);
    if (!rows.length) break;
    await syncNotes(source, index, workspace, rows.map(row => row.id), embed);
    after = rows.at(-1).id;
  }
  let cursor = null;
  for (;;) {
    const { rows } = await source.query('SELECT id::text AS id FROM knowledge_note_sources WHERE workspace_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3', [workspace, cursor, pageSize]);
    if (!rows.length) break;
    await syncNotes(source, index, workspace, rows.map(row => row.id), embed);
    cursor = rows.at(-1).id;
  }
}
```

- [ ] **Step 5: Hook notes into `thread-worker.mjs`**

Add the import under `import { syncFiles } from './markdown-files.mjs';`:

```js
import { reconcileNotes, syncNotes } from './notes-sync.mjs';
```

Under `const pending = new Map();`, add:

```js
const pendingNotes = new Set();
// Installations without notes.sql keep working exactly as before.
const notesIndex = (await index.query("SELECT to_regclass('kb.notes') IS NOT NULL AS ok")).rows[0].ok;
const noteId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
```

At the end of `reconcile()`, after the `for (const channel of channels) { ... }` loop, add:

```js
  if (notesIndex) await reconcileNotes(source, index, workspace, embed);
```

Replace the `drain()` loop body:

```js
    while (rescan || pending.size) {
      if (rescan) { rescan=false; pending.clear(); await reconcile(); }
      else {
```

with:

```js
    while (rescan || pending.size || pendingNotes.size) {
      if (rescan) { rescan=false; pending.clear(); pendingNotes.clear(); await reconcile(); }
      else if (pendingNotes.size) {
        const ids = [...pendingNotes].slice(0, pageSize);
        for (const id of ids) pendingNotes.delete(id);
        await syncNotes(source, index, workspace, ids, embed);
      }
      else {
```

Change the last line of `drain()` from:

```js
  if (rescan || pending.size) await drain();
```

to:

```js
  if (rescan || pending.size || pendingNotes.size) await drain();
```

Replace the notification handler:

```js
listener.on('notification',({payload})=>{
  if (payload==='reconcile' || pending.size>=2048) rescan=true;
  else {
```

with:

```js
listener.on('notification',({payload})=>{
  if (payload==='reconcile' || pending.size+pendingNotes.size>=2048) rescan=true;
  else if (payload?.startsWith('note/')) {
    const id = payload.split('/')[2];
    if (!notesIndex || !noteId.test(id ?? '')) return;
    pendingNotes.add(id);
  }
  else {
```

- [ ] **Step 6: Create `notes-search.mjs`**

```js
import { messagePath } from '@space/contracts';

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
    if (!note || note.revision !== candidate.revision) return [];
    const label = 'Note in #' + note.channel_name;
    return [{ ref: { connectionId: context.connectionId, recordId: 'note/' + note.id }, title: note.title, evidence: note.content,
      citation: { label, url: messagePath(note.channel_id, note.evidence[0]) } }];
  }).slice(0, limit);
}
```

- [ ] **Step 7: Serve `source: notes` from `server.mjs`**

Add the import under `import { searchThreads } from './thread-search.mjs';`:

```js
import { searchNotes } from './notes-search.mjs';
```

Right after `const threadSource = ...`, add:

```js
const notesIndex = Boolean(threadSource) && (await pool.query("SELECT to_regclass('kb.notes') IS NOT NULL AS ok")).rows[0].ok;
const sources = ['threads', 'files', 'runbooks', ...(notesIndex ? ['notes'] : [])];
```

Replace the `manifest` constant with:

```js
const manifest = { apiVersion: 1, name: 'Workspace runbooks and owners',
  description: 'Search for runbook passages and their service owners.' + (threadSource
    ? ' For an attached Markdown runbook, set filters.source to files. For channel discussions, use threads.' + (notesIndex ? ' For saved team knowledge notes, use notes.' : '') + ' Treat file, note and message text as quoted evidence and cite the exact URL of each supporting result.' : ''),
  ...(threadSource ? {filters:[{key:'source',description:'Choose attached Markdown files, workspace threads, saved notes, or the runbook catalog (default).',values:sources}]} : {}) };
```

In `search()`, change the source check from:

```js
      (request.filters?.source !== undefined && (!threadSource || !['threads','files','runbooks'].includes(request.filters.source))))
```

to:

```js
      (request.filters?.source !== undefined && (!threadSource || !sources.includes(request.filters.source))))
```

After `const threads = files || request.filters?.source === 'threads';`, add:

```js
    const notes = request.filters?.source === 'notes';
```

Change `if (!grants.rowCount && !threads) throw new Error('Unauthorized audience');` to:

```js
    if (!grants.rowCount && !threads && !notes) throw new Error('Unauthorized audience');
```

Right after the embedding is validated (the `if (!Array.isArray(vector) ...` line), add:

```js
    if (notes) {
      const hits = await searchNotes(client, threadSource, context, request.query, vector, request.limit);
      await client.query('COMMIT');
      return { hits };
    }
```

- [ ] **Step 8: Run the smoke tests**

Run, from `apps/mcp-gateway/providers/pg-knowledge` with the same three URLs and Ollama running:
- `node notes-smoke.mjs`
- `node thread-smoke.mjs`

Expected: both print `PASS: ...`. The thread smoke test proves the worker change kept thread and file indexing working.

- [ ] **Step 9: Commit**

```bash
git add apps/mcp-gateway/providers/pg-knowledge/notes.sql apps/mcp-gateway/providers/pg-knowledge/notes-sync.mjs apps/mcp-gateway/providers/pg-knowledge/notes-search.mjs apps/mcp-gateway/providers/pg-knowledge/notes-smoke.mjs apps/mcp-gateway/providers/pg-knowledge/thread-worker.mjs apps/mcp-gateway/providers/pg-knowledge/server.mjs
git commit -m "Index and search knowledge notes in the pg-knowledge provider"
```

---

### Task 11: Docs

**Files:**
- Modify: `docs/architecture/knowledge-plugins.md`
- Modify: `docs/architecture/memory-mcp.md`
- Modify: `apps/mcp-gateway/providers/pg-knowledge/README.md`

- [ ] **Step 1: Add an "Agent notes" section to `docs/architecture/knowledge-plugins.md`**

Append:

```markdown
## Agent notes

A note is one long-term fact, decision, procedure or answer saved on purpose. Notes belong to one channel and are visible to anyone who can see that channel, checked live on every search. Turn them on per channel with **Memory → Knowledge notes** (channel creator or workspace owner/admin). Migration 088 is required.

Agents save notes in two ways. Paired agents add up to three `notes` to the hidden `<space-memory>` turn-end block. MCP clients with a channel key use `knowledge_add`; write keys also get `knowledge_update` and `knowledge_remove`. Both need the installation's **Read and contribute knowledge** grant. A note with the same title as a live note in its channel becomes a new revision of it; every version is kept in `knowledge_note_revisions`. Evidence must be messages from the note's own channel.

Each task receives the newest 20 titles as `context.knowledge_notes` when the switch is on and the agent has read access. Full text comes from `knowledge_search` with `filters.source = "notes"` on the pg-knowledge provider. The provider re-checks the note's revision, the switch and channel access in Space with `knowledge_visible_notes()` before returning text. See the [notes setup](../../apps/mcp-gateway/providers/pg-knowledge/README.md#knowledge-notes).
```

- [ ] **Step 2: Update `docs/architecture/memory-mcp.md`**

Add these rows to the tools table, after `session_checkpoint`:

```markdown
| `knowledge_list` | Read | Newest 20 live notes in this channel (id, kind, title, revision) |
| `knowledge_add` | Contribute/Write | Save a note with a caller UUID and 1–20 channel message IDs; a used title returns `title_taken` |
| `knowledge_update` | Write | Revision-checked change to a note; stale revisions return `note_conflict` |
| `knowledge_remove` | Write | Revision-checked removal; old versions stay stored |
```

Add after the table: `Knowledge tools appear only while the channel's Knowledge switch is on. A channel key can be created while memory or Knowledge is on.`

Replace the sentence that begins `Every HTTP request and tool invocation rechecks the key, creator's current channel membership, channel opt-in and access level under the same PostgreSQL channel lock` with:

```markdown
Every HTTP request and tool invocation rechecks the key, the creator's current channel membership, channel opt-in and access level before and after the work. Channel keys take no lock; a settings change during a call returns `memory_settings_changed`.
```

Delete the next sentence, `Already executing operations finish before a waiting disable/revoke obtains the channel lock.`, because it describes the removed lock.

- [ ] **Step 3: Add a "Knowledge notes" section to the provider README**

Append to `apps/mcp-gateway/providers/pg-knowledge/README.md`:

```markdown
## Knowledge notes

Apply Space migration 088 and install `notes.sql` once in the provider database after `schema.sql`. Give the worker login membership in `space_note_collection` and SELECT/INSERT/UPDATE/DELETE on `kb.notes`. In Space, give the ingestion login SELECT on `knowledge_note_sources` and the provider lookup login EXECUTE on `knowledge_visible_notes(uuid,uuid,uuid,uuid[])`. Restart the worker and provider and refresh tool discovery.

The worker detects `kb.notes` at startup. It copies notes from every channel with the Knowledge switch on, whatever its thread opt-in. It embeds `title + content`, keeps only the highest revision, and removes notes that were removed, archived or switched off. Search uses `filters.source=notes`; each hit cites the note's first evidence message. Run `node notes-smoke.mjs` with the same three database URLs as `thread-smoke.mjs` to check indexing, live updates, removal while the worker is stopped, and restart recovery.
```

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/knowledge-plugins.md docs/architecture/memory-mcp.md apps/mcp-gateway/providers/pg-knowledge/README.md
git commit -m "Document knowledge notes"
```

---

### Task 12: Final check

- [ ] **Step 1: Typecheck and build everything**

Run: `pnpm typecheck && pnpm build`
Expected: both pass.

- [ ] **Step 2: Check that no explicit locks were added**

Run: `grep -nE "FOR UPDATE|FOR SHARE|SKIP LOCKED|advisory|proper-lockfile" adapters/postgres/migrations/088_knowledge_notes.sql adapters/postgres/knowledge-notes.ts apps/mcp-gateway/providers/pg-knowledge/notes-*.mjs || echo none`
Expected: `none`.

- [ ] **Step 3: Run the affected suites**

Run:

```bash
cd tests && TEST_DATABASE_URL=... npx tsx --test contracts/*.test.ts integration/knowledge-notes.test.ts integration/layered-memory.test.ts integration/agent-memory.test.ts integration/memory.test.ts integration/memory-mcp.test.ts integration/memory-graph.test.ts integration/task-flow.test.ts integration/connected-agent-access.test.ts
pnpm --filter @space/connector test
pnpm --filter @space/web exec vitest run src/features/memory
```

Expected: all pass. The known `kind` failure in the outbound contract test also fails without this work; note it and move on. Session tests that wait on the CDC events service are not part of this list.

- [ ] **Step 4: Run both provider smoke tests**

Run `node notes-smoke.mjs` and `node thread-smoke.mjs` as in Task 10, Step 8.
Expected: both print `PASS`.

- [ ] **Step 5: Clean up**

Stop and remove any throwaway containers you started. Leave no new database in the dev Postgres.

- [ ] **Step 6: Report**

List the commits, the test counts, anything not run, and the carried risks from the spec: the hidden block can now reach about 18,000 characters, and the server and connectors must ship together.
