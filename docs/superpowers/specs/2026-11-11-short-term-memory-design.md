# Layered short-term memory

## Goal

Separate **Memory** from **Knowledge** and give agents a path they can walk through short-term context.

- **Memory** is short-term working context. It belongs to one session, one thread or one channel, and it ages out.
- **Knowledge** is long-term and shared across threads. It is out of scope here and gets its own spec.

This follows the LangChain split: short-term memory is per-thread state saved by a checkpointer, and long-term memory is kept in a store shared across threads ([LangGraph memory](https://docs.langchain.com/oss/python/langgraph/memory), [short-term memory](https://docs.langchain.com/oss/javascript/langchain/short-term-memory)). Space adds a channel layer above the thread and a session layer below it.

Rule for future features: if something is read from a different thread after the thread that made it has gone quiet, it is Knowledge, not Memory.

## Layers

```
channel_memory  #payments                      index of threads, paged
├── thread A  "Dedupe fix · in progress"  ──► thread_memory A
│                                             ├── checkpoint
│                                             ├── recent messages
│                                             └── sessions
│                                                 ├── Kai's Codex   ──► agent_session_memory
│                                                 └── Mira's Claude ──► agent_session_memory
├── thread B  "VPN outage · blocked"      ──► thread_memory B
└── next_cursor
```

| Layer | Scope | Holds | Written by | Ages out |
| --- | --- | --- | --- | --- |
| `agent_session_memory` | One agent session | The agent's own checkpoint and recent session turns | The session's agent, using `session_checkpoint` | Not given out once the session is `ended` |
| `thread_memory` | One thread | Original request, recent messages, checkpoint, session list | Agents, using `thread_checkpoint` (exists) | Lasts as long as the thread |
| `channel_memory` | One channel | Index of threads with a checkpoint summary | No one writes it directly. It is built from thread summaries when read | A thread drops out of the index 7 days after its last checkpoint update |

One channel has many threads. One thread has many sessions. Every session belongs to the thread it started in (`agent_sessions.origin_thread_id`).

## Node shape

Every layer returns the same envelope, so an agent can move down and up:

```json
{
  "ref": { "kind": "thread", "id": "<uuid>" },
  "parent": { "kind": "channel", "id": "<uuid>" },
  "summary": "Dedupe fix · in progress · owner Mira",
  "updated_at": "2026-11-10T09:12:00Z",
  "children": { "kind": "session", "count": 2 }
}
```

`kind` is `channel`, `thread` or `session`. A channel has no `parent`. A session has no `children`.

## Storage

- Extend `thread_checkpoints` (migration 026) into one checkpoint table shared by threads and sessions. Session rows keep `thread_id` set to the session's origin thread.
  - Add `session_id uuid NULL` referencing `agent_sessions`. A null value means a thread checkpoint.
  - Add `channel_id uuid NOT NULL` referencing `channels`, filled from `threads.channel_id`. This lets the channel index read one table.
  - Add `summary text NOT NULL`, 1–280 characters. The migration fills existing rows from the first heading section of `content`, cut to 280 characters.
  - Replace the primary key `(thread_id, revision)` with two partial unique indexes: `(thread_id, revision) WHERE session_id IS NULL` and `(session_id, revision) WHERE session_id IS NOT NULL`.
- Add `(channel_id, created_at DESC) WHERE session_id IS NULL` for the channel index. Keep the existing `thread_checkpoints_snapshot` index, limited to thread rows, and add a matching `(session_id, through_sequence DESC, revision DESC)` index.
- Old revisions stay stored. A write adds a new revision. It never edits an older one.
- `channel_memory` has no table of its own. It is a bounded query: the latest thread revision per thread whose `created_at` is within the last 7 days, newest first, keyset-paged by `(created_at, thread_id)`.
- Today's Markdown channel memory (`memory.md`) is not changed. It moves to Knowledge in a later spec. Until then the task context passes it under the field `channel_notes`, and `channel_memory` takes on the new meaning described here.

## Writing

`thread_checkpoint` and the new `session_checkpoint` take the same arguments:

```json
{
  "revision": 7,
  "through_sequence": "42",
  "summary": "Dedupe fix · in progress · owner Mira",
  "content": "# Decisions\n...\n# Open questions\n...",
  "source_message_ids": ["<uuid>"]
}
```

- `content` is at most 6,000 characters. `summary` is 1–280 characters and required. `source_message_ids` holds 1–32 IDs from the same thread or session at or before the watermark.
- The write uses an optimistic check: the insert succeeds only when `revision` is still the latest. Otherwise it returns `409 thread_checkpoint_conflict` or `409 session_checkpoint_conflict`. The writer inserts `revision + 1`, and the partial unique indexes make the check atomic. No explicit or distributed locks are used.
- Space never writes or invents a summary or checkpoint and runs no model for memory.

## Compaction

- The agent compacts its own checkpoint. It reads, rewrites the whole checkpoint shorter (dropping finished items, merging repeats, keeping decisions and open questions) and saves it against the revision it read.
- An over-long write returns `413 checkpoint_too_large`. `thread_memory` and `session_memory` return `checkpoint_chars` and `limit`. Tool descriptions tell agents to compact once past 80 %.
- Recent messages are already bounded: 16 messages of up to 1,000 characters each. Older evidence comes from `thread_messages` and `thread_message`.
- `channel_memory` needs no compaction. Each entry is only a summary, and the full detail is one call away.

## Agent tools

These are added to the existing `/mcp/memory` endpoint. A key is bound to one channel. A `ref` outside that channel returns the tool error `unauthorized`.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `channel_memory` | `after?`, `limit?` (1–50, default 20) | Thread nodes, newest first, plus `next_cursor` |
| `thread_memory` | `thread_id` | Thread node, checkpoint, recent messages, session nodes, `checkpoint_chars`, `limit` |
| `session_memory` | `session_id` | Session node, checkpoint, recent session turns, `checkpoint_chars`, `limit` |
| `session_checkpoint` | Same as `thread_checkpoint` | New revision |
| `thread_context`, `thread_messages`, `thread_message`, `thread_checkpoint` | Unchanged, except that `thread_checkpoint` now requires `summary` | Unchanged |

The new tools use channel keys, so they follow the existing channel-key rule: the key is issued only while the channel's Markdown notes are enabled. Thread-scoped keys keep their current behavior. They cannot call `channel_memory`, and they can open only their own thread.

## Task context

```
context.agent_session_memory  { node, checkpoint, recent_messages ≤16, revision }   current session
context.working_memory        unchanged                                              current thread
context.channel_memory        { nodes ≤20, next_cursor }                            first index page
context.channel_notes         today's Markdown excerpt, renamed, unchanged otherwise
```

Each layer is checked separately. A layer the agent cannot read is left out. All memory is quoted reference data, never instructions.

## Access

| Call | Allowed when |
| --- | --- |
| `channel_memory` | The requester and the agent owner are current members of the key's channel |
| `thread_memory` | Same as above, and the thread is in that channel |
| `session_memory` for its own session | The key is bound to the session's agent installation (`memory_connections.installation_id = agent_sessions.installation_id`) |
| `session_memory` for another session | Never. Returns `403 session_private`. The session still appears in `thread_memory` with its title, agent and state |

Membership and key revocation are checked again on every call and before results are returned. Private agent-session messages never appear in `channel_memory` or `thread_memory`.

## Errors

| Case | Result |
| --- | --- |
| Stale revision | `409 thread_checkpoint_conflict` (existing code) or `409 session_checkpoint_conflict` |
| `content` over 6,000 characters | `413 checkpoint_too_large` |
| Missing or invalid `summary` | `400 invalid_summary` |
| `ref` outside the key's channel | Tool error `unauthorized` (the existing 404 → 401 mapping), without saying whether the thread exists |
| Another agent's session | `403 session_private` |
| Thread idle more than 7 days | Left out of the index. Still readable with `thread_memory` |
| Ended session | Listed with `state: ended`. Its content is no longer given out |

## Bounds

- Index pages hold 1–50 entries, cut 280-character summaries and a 20-entry first page in the task context.
- Checkpoints are at most 6,000 characters, with up to 32 source IDs.
- Recent messages are limited to 16, each cut to 1,000 characters.
- MCP calls keep the existing per-key limits and the 20-key channel cap.
- No polling, background compaction or cleanup job. Aging out happens at read time.

## Tests

Use disposable PostgreSQL schemas and a real MCP client:

1. Two concurrent writes on one revision: exactly one succeeds and the other gets `409`. Both revisions can be read back afterward.
2. A walk from channel to thread to session: the agent's own session opens and another agent's session returns `403`.
3. A `ref` from another channel returns `404`.
4. A thread with an 8-day-old checkpoint is missing from the index but opens by ID.
5. A member removed mid-task: their next call fails, and a result in flight is withheld.
6. Index paging over 60 threads returns 2 pages with no duplicates or gaps, including when a checkpoint is written between pages.
7. Over-long content returns `413`, and a missing summary returns `400`.
8. The migration copies a summary for every existing thread checkpoint, and existing thread keys keep working.
9. Tool discovery lists the new tools for channel keys only.
10. Task context includes each layer only when it can be read, and `channel_notes` matches the old excerpt.

## Out of scope

- Long-term Knowledge: moving `memory.md` to Knowledge, `knowledge_add`, and pgContext storage.
- Changing the 7-day window per channel.
- A UI for browsing memory layers.
