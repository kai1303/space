# Knowledge notes (Knowledge part 1)

## Goal

Give agents long-term **Knowledge** they can write and that other threads can find later.

- **Memory** is short-term and ages out. See [layered short-term memory](2026-11-11-short-term-memory-design.md).
- **Knowledge** is long-term and is read from other threads. This follows the LangChain split between a per-thread memoryer and a shared store ([LangGraph memory](https://docs.langchain.com/oss/python/langgraph/memory)).

Rule: if something is read from a different thread, it is Knowledge.

A **note** is one short fact that an agent saves on purpose. It has a kind, a title, content and 1–20 evidence messages from its own channel. Space runs no model: the agent's own model decides what becomes a note.

## Scope

Knowledge is split into four parts. Each gets its own spec, plan and build.

| Part | Covers | This spec |
| --- | --- | --- |
| 1. Notes core | Note storage, write tools, turn-end notes, indexing, search, task context | Yes |
| 2. Move `memory.md` | Import today's `channel_notes` blocks as notes, then make the file read-only | No |
| 3. Knowledge UI | Browse, edit and remove notes. Thread and file indexing toggles | No |
| 4. Promotion rules | Anything beyond the turn-end `notes` list in this spec | No |

The notes design leaves thread and Markdown indexing independent of notes. Cross-channel decision search automatically indexes eligible discussions in active channels. Markdown attachment indexing remains operator-configured. The 16,000-character connector limit is outside this design.

## Decisions

| Question | Decision |
| --- | --- |
| Where a note is stored first | Space PostgreSQL. The ingestor copies it into pgContext |
| Who can see a note | Anyone who can see its channel, checked live on every search |
| Evidence | Must come from the note's own channel |
| Where write tools live | Space's channel MCP endpoint, `/mcp/memory` |
| What turns notes on | A new per-channel switch, `channels.knowledge_enabled`, off by default |
| What the switch covers | Notes only |
| How built-in agents add notes | A `notes` list in the hidden `<space-memory>` turn-end block |
| Same title in the same channel | Updates that note as a new revision. Old revisions are kept |
| How agents see existing notes | `knowledge_search` for full text, plus the newest 20 titles in task context |

## Data flow

```
                 ┌─ knowledge_add / knowledge_update / knowledge_remove   (MCP /mcp/memory)
agent turn ──────┤
                 └─ <space-memory>{ "notes": [...] }                      (turn end)
                              │
                              ▼
        knowledge_notes + knowledge_note_revisions        Space PostgreSQL
                              │ trigger: pg_notify('space_kb_<workspace>', 'note/<channel>/<id>')
                              ▼
        thread-worker.mjs ─► embed (Ollama all-minilm:22m) ─► kb.notes, collection kb_notes
                              │
knowledge_search(filters.source = "notes") ─► rank ─► knowledge_visible_notes() ─► hits
                                                      │ live: switch, removed, revision, channel access
task context ◄─ context.knowledge_notes: newest 20 titles, read from Space only
```

## Storage

Migration `088_knowledge_notes.sql`. Number 087 is reserved by the [memory graph UI spec](2026-11-11-memory-graph-ui-design.md). If that spec is built later, this one keeps 088.

### `channels.knowledge_enabled`

`boolean NOT NULL DEFAULT false`. The channel creator or a workspace owner/admin can change it, the same rule as `memory_enabled`. Turning it off hides notes from tools, context and search right away. Stored notes are kept.

### `knowledge_notes`

The current version of each note.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK | Supplied by the MCP caller, or random for block notes (see below) |
| `workspace_id`, `channel_id` | `uuid` | FK `(workspace_id, channel_id)` to `channels` |
| `kind` | `text` | `fact`, `decision`, `procedure` or `answer` |
| `title` | `text` | 1–160 characters after trimming |
| `title_key` | `text` | Generated column: `lower(regexp_replace(btrim(title), '\s+', ' ', 'g'))` |
| `content` | `text` | 1–2,000 characters from a block, 1–16,000 from MCP. No `\0` |
| `evidence` | `uuid[]` | 1–20 message IDs, all in `channel_id` |
| `revision` | `integer` | Starts at 1 and goes up by 1 on each change |
| `producer_id`, `producer_name` | `text` | Installation or MCP connection that wrote the current revision |
| `fingerprint` | `text` | SHA-256 of the normalized input, for MCP retries |
| `created_at`, `updated_at` | `timestamptz` | |
| `removed_at` | `timestamptz` | Null while live |

Indexes:

- Unique `(channel_id, title_key) WHERE removed_at IS NULL`. One live note per title per channel.
- `(channel_id, updated_at DESC) WHERE removed_at IS NULL` for the title list.

### `knowledge_note_revisions`

Every version, including the first. Primary key `(note_id, revision)`. Columns: `kind`, `title`, `content`, `evidence`, `producer_id`, `producer_name`, `created_at`, and `removed boolean` for the version that removed the note.

### Notify trigger

`AFTER INSERT OR UPDATE OR DELETE ON knowledge_notes` sends `pg_notify('space_kb_' || <workspace without dashes>, 'note/' || channel_id || '/' || id)`. It sends no text. A change to `channels.knowledge_enabled` sends `reconcile` on the same channel name, the same way opt-in changes do in migration 082.

### `knowledge_note_sources` view and `knowledge_visible_notes()`

`knowledge_note_sources` (`security_barrier`) lists live notes in non-archived `kind = 'channel'` channels with `knowledge_enabled`, plus the channel name.

`knowledge_visible_notes(w uuid, requester uuid, destination uuid, ids uuid[])` is `SECURITY DEFINER` with a pinned `search_path`. It returns `id, channel_id, kind, title, content, evidence, revision, channel_name` for at most 128 IDs. It uses the same access rule as `knowledge_visible_messages()`:

- The requester is an active workspace member in both the note's channel and the destination channel.
- A private source channel is only returned to a private destination.
- Every active member of the destination channel can see the source channel. Guests count as viewers even for public sources.

The provider lookup role gets `EXECUTE` on this function only. The ingestion role gets `SELECT` on `knowledge_note_sources`.

## Writing notes

All writes run inside one normal transaction with no explicit locks. The database's unique indexes decide clashes.

### Same-title save (turn-end block)

```sql
INSERT INTO knowledge_notes (...) VALUES (...)
ON CONFLICT (channel_id, title_key) WHERE removed_at IS NULL
DO UPDATE SET kind = EXCLUDED.kind, title = EXCLUDED.title, content = EXCLUDED.content,
  evidence = EXCLUDED.evidence, producer_id = EXCLUDED.producer_id, producer_name = EXCLUDED.producer_name,
  revision = knowledge_notes.revision + 1, updated_at = now()
WHERE (knowledge_notes.kind, knowledge_notes.content, knowledge_notes.evidence)
  IS DISTINCT FROM (EXCLUDED.kind, EXCLUDED.content, EXCLUDED.evidence)
RETURNING id, revision;
```

The statement returns a row when it inserted or changed a note, and then a row goes into `knowledge_note_revisions`. No row means nothing changed. The latest save wins, and every earlier version stays in the revision table.

A block note gets a random `id` on insert. A repeated turn end is already stopped by the agent event receipts. If the same note arrives again anyway, the title matches, the content is the same, and nothing changes. A fixed id would risk a primary-key clash inside the turn transaction, so none is used.

The note row and its revision row are written by one SQL statement (a data-modifying `WITH`), so the MCP path needs no transaction of its own.

### MCP tools

Added to the existing `/mcp/memory` factory. They appear in discovery only while `knowledge_enabled` is on. Every call checks the key, the creator's membership and the switch again.

| Tool | Key access | Arguments | Behavior |
| --- | --- | --- | --- |
| `knowledge_list` | read, contribute or write | none | The same newest-20 title list as task context, so MCP-only agents can find a note's `id` and `revision` |
| `knowledge_add` | contribute or write | `id`, `kind`, `title`, `content`, `message_ids` (1–20) | Inserts a note. Retrying with the same `id` and fingerprint returns the same note. The same `id` with different input returns `409 note_id_conflict`. A used title returns `409 title_taken`; the caller finds the existing note with `knowledge_list` |
| `knowledge_update` | write | `id`, `revision`, and any of `kind`, `title`, `content`, `message_ids` | `UPDATE ... WHERE id = $1 AND revision = $2 AND removed_at IS NULL`. No row returns `409 note_conflict`. A clash with another live title returns `409 title_taken` |
| `knowledge_remove` | write | `id`, `revision` | Sets `removed_at` under the same revision check and writes a `removed` revision |

Installation-bound keys are capped at contribute (migration 038), so built-in agents only add notes. They update a note by saving the same title in the block.

Evidence is resolved from the key's channel. A message ID from any other channel, or a deleted one, returns `400 foreign_evidence`.

### Turn-end block

`AgentMemoryUpdate` gains an optional `notes` list:

```json
{
  "thread": { "base_revision": 3, "summary": "...", "content": "..." },
  "notes": [
    { "kind": "decision", "title": "Duplicate charge fix",
      "content": "Dedupe charges on idempotency_key.", "message_ids": ["<message uuid>"] }
  ]
}
```

| Rule | Value |
| --- | --- |
| Notes per block | 0–3 |
| Title | 1–160 characters |
| Content | 1–2,000 characters |
| `message_ids` | Optional, 0–20. Empty uses the most recent human message included in the prepared invocation, if it is still shareable. Conflicting retry contexts or missing evidence skip the note |
| A block with only `notes` | Valid. `session` and `thread` stay optional, but the block needs at least one of the three |

`parseAgentMemoryUpdate` validates each note on its own. One bad note is dropped and the rest of the block still parses. A list longer than 3 is dropped as a whole, and the memories still parse. Dropped notes never reach Space, so they leave no trace entry.

`saveTurnNotes` runs right after `saveTurnMemory`, in the same transaction, and saves a note when all of these hold:

- `knowledge_enabled` is on for the thread's channel.
- The installation's `agent_memory_grants.access` is `contribute`.
- Every evidence message is in the thread's channel.

A note that fails a check is skipped. The turn trace gets one entry per note: `note:saved`, `note:unchanged`, `note:knowledge_disabled`, `note:no_grant` or `note:foreign_evidence`. Note problems never fail the turn. The writers raise `AppError` before any SQL error, so the transaction stays usable, as it does for memories today.

## Reading notes

### Task context

`InvocationRequest.context.knowledge_notes`:

```json
{ "channel_id": "<uuid>", "notes": [{ "id": "<uuid>", "kind": "decision", "title": "Duplicate charge fix", "revision": 2, "updated_at": "..." }], "truncated": true }
```

- The newest 20 live notes of the task's channel, read from Space. No provider call.
- Sent when `knowledge_enabled` is on and the installation's grant is `read` or `contribute`.
- `truncated` is true when the channel has more than 20 live notes.
- `parseInvocation` accepts the new key. Paired connectors reject unknown keys, so the server and connectors ship in the same release.

### Search

The pg-knowledge provider adds `notes` to its `source` filter values and to its manifest description. For `filters.source = "notes"`:

1. Rank `kb.notes` with `pgcontext.query('kb_notes', ...)`, taking up to `4 × limit` candidates.
2. Call `knowledge_visible_notes()` with the candidates.
3. Keep only rows whose live `revision` matches the indexed revision.
4. Return hits with `recordId: "note/<id>"`, the title, the content as evidence, and a citation `{ label: "Note in #<channel>", url: messagePath(channel_id, evidence[0]) }`.

Notes get no URL of their own until the UI in part 3.

## Indexing

`thread-worker.mjs` also handles notes. It needs no new process.

| Event | Worker does |
| --- | --- |
| `note/<channel>/<id>` | Reads the row from `knowledge_note_sources`. If it is live, it embeds `title + "\n" + content` and upserts `kb.notes` (keeping only a higher revision), then calls `pgcontext.upsert_points('kb_notes', ...)`. If it is missing, it deletes the point and the row |
| `reconcile` | Adds a notes pass: pages through `kb.notes` and drops rows that are no longer in the source, then pages through `knowledge_note_sources` and adds missing or older rows |
| Startup | Same as `reconcile`. It subscribes first, then backfills, as today |

Notes are copied from every channel with `knowledge_enabled`, whatever its row in `knowledge_thread_channels`.

New provider file `notes.sql`, installed after `schema.sql`: `kb.notes(id text PK, workspace_id uuid, channel_id uuid, revision integer, body text, embedding pgcontext.vector(384))`, collection `kb_notes` with vector and lexical sources, and grants for the worker and reader roles. Notes use no pgGraph edges.

## Settings

A new route, `POST /v1/channels/:channelId/memory/knowledge` with `{ "enabled": boolean }`, sets the switch. It is manager-only. `GET /memory` and both settings routes return `knowledge_enabled`. A separate route keeps the memory switch request unchanged. The Memory dialog gets one **Knowledge notes** switch next to the memory switch. Browsing notes is part 3.

MCP key creation is allowed while memory **or** Knowledge is on. With only Knowledge on, the memory document tools (`memory_read`, `memory_search`, `memory_remember`, `memory_write`, `memory_forget`) still appear but return `409 memory_disabled`, as they do today. The conversation and short-term memory read tools keep working.

## Connector instructions

`memoryInstructions()` adds, when `knowledge_notes` is in context:

- What a note is: a settled fact, decision, procedure or answer worth keeping after this thread.
- Reuse a listed title to update a note. Search before making a new title when the list is truncated.
- At most 3 notes per block, at most 2,000 characters each, with evidence message IDs from this channel.

The block stays hidden from people, both while streaming and in the task result, as it is today.

## Failure handling

| Case | Result |
| --- | --- |
| Knowledge off | MCP tools hidden. Block notes skipped with `note:knowledge_disabled`. No `knowledge_notes` in context. Search hides the notes |
| No contribute grant | Block notes skipped with `note:no_grant` |
| Evidence from another channel | `400 foreign_evidence` over MCP. `note:foreign_evidence` in a block |
| Stale `knowledge_update` or `knowledge_remove` | `409 note_conflict` |
| New or renamed note uses a live title | `409 title_taken` |
| Provider or Ollama down | Notes still save, and titles still reach context. The worker catches up from `reconcile` after restart |
| Note changed or removed after indexing | The live check in `knowledge_visible_notes()` hides the old text |
| Channel archived or member removed | The live check hides notes from the next search |

## Architecture rules

- **No polling:** the worker reacts to `pg_notify` and reconciles in bounded pages on startup.
- **No explicit locks:** writes use unique indexes, `ON CONFLICT` and revision-guarded updates. PostgreSQL still takes its own row and index locks during these writes. The `/mcp/memory` key check for channel keys reads and re-checks access without a lock. `docs/architecture/memory-mcp.md` still describes an older channel lock and is corrected in this work.
- **Bounded:** 3 notes per block, 20 evidence messages, 20 titles in context, 128 IDs per visibility call, search limit 1–50.

## Risks

- The hidden block can now reach about 18,000 characters (12,000 for memories plus 6,000 for notes). The connectors' 16,000-character check counts the block, so a long answer with a full block can fail the turn. This was left for later and is now more likely.
- The latest same-title save wins. An agent can overwrite a person's text. The old text stays in `knowledge_note_revisions`.
- Server and connectors must ship together because of the new context key.

## Tests

Run on a disposable test schema, with a test provider index and local Ollama for the indexing cases.

| Test | Shows |
| --- | --- |
| Two turns save the same title at the same time | One note with two revisions |
| The same turn end saved twice | Nothing changes the second time |
| `knowledge_add` retried with the same id and input | One note |
| Stale `knowledge_update` | `409 note_conflict` |
| Rename to a live title | `409 title_taken` |
| Evidence from another channel | Refused over MCP, skipped in a block |
| Knowledge off | Tools, block notes, context and search all stop. Rows remain |
| Contribute key | Sees `knowledge_add` but not update or remove |
| Search from a channel where one member can't see the source | No hit |
| Note removed while the worker is down | Hidden at once, gone from `kb.notes` after restart |
| Context title list with 25 notes | 20 titles, `truncated: true` |
| Bad note in a block | That note is dropped. Memories and other notes save |
| Real MCP client | Discovery lists the tools, and add, update and remove work end to end |
| Connectors | A block with notes is hidden from people while streaming and in the result |
