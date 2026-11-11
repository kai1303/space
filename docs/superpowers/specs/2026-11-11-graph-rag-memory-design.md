# Memory on Graph RAG

## Goal

Rebuild memory so that all three layers live in one Graph RAG store: a graph of channels, threads, sessions and messages, with an embedding on every message. A change to any message reaches the store through change data capture. Agents read memory by walking the graph and ranking messages by meaning, instead of reading notes that agents wrote.

| Layer | Graph scope | What an agent gets |
| --- | --- | --- |
| Agent session memory | One session and its messages | The session's recent turns, plus its turns most related to the task |
| Thread memory | One thread, its messages and its sessions | Root message, recent messages, the messages most related to the task, the session list |
| Channel memory | One channel and its threads | Recent threads, plus the threads most related to the task |

This replaces the agent-written memory notes (the `thread` and `session` parts of `<space-memory>`, `memory_pending` and `memory_revisions`), and it merges the knowledge thread index into the same store. It supersedes the messages-only memory spec. Knowledge is not part of this spec: the `notes` list in `<space-memory>` and the knowledge tools stay.

## Why Graph RAG

- **Graph** answers "where": which channel holds this thread, which messages belong to this session, who took part.
- **RAG** answers "what is relevant": the messages closest in meaning to the task, found by vector and full-text ranking.
- Together they let an agent ask "the parts of this thread that matter for my task", which neither a recent-messages window nor an agent note can give.

## What already exists

| Piece | Where | Reused for |
| --- | --- | --- |
| Knowledge database | PostgreSQL 17 with pgGraph and pgContext (`apps/mcp-gateway/providers/pg-knowledge`) | The store |
| CDC reader | `graph-reader.mjs`: one slot, guarded upserts, LSN saved with the writes, ack after commit, debounced graph build | The writer, extended with messages |
| Embeddings | Local Ollama `all-minilm:22m`, 384 dimensions (`thread-worker.mjs`) | Message vectors. Text never leaves the machine for this |
| Hybrid ranking | `pgcontext.query(collection, vector, text, ...)` (`thread-search.mjs`) | Ranking messages |
| Live access check | `knowledge_visible_messages()` (migration 082) | The model for memory's read check |

## Data flow

```
Space PostgreSQL
  messages, agent_sessions, channels
     │ WAL, publication space_graph_<schema> (ids and flags only, no text)
     ▼
graph-reader.mjs (extended)
     │ 1. plan changes into guarded writes (as today)
     │ 2. for changed messages: read text through memory_source_messages (Space view)
     │ 3. embed new or edited bodies with Ollama, in batches of 32
     │ 4. one graph transaction: upserts + vectors + LSN
     │ 5. ack the LSN; debounced graph build and pgcontext point update
     ▼
knowledge database
  kb.m_* tables, graph space_memory, collection kb_memory
     ▲
memory readers (MCP tools, task context, Memory UI)
     │ graph walk + hybrid ranking → candidate ids
     │ memory_visible_messages() in Space → only what this requester may see
     ▼
agent
```

The stream carries ids, sequences and flags. Text is read through one Space view, so the rules for what may be copied live in one place.

### `memory_source_messages` (Space view, `security_barrier`)

Live messages in non-archived `kind = 'channel'` channels with `memory_enabled`, including agent replies and agent session messages, excluding deleted and retained messages and empty text. Columns: `id, workspace_id, channel_id, thread_id, agent_session_id, author_id, author_type, sequence, search_revision, created_at, body` (`left(text, 8000)`).

## Graph model (knowledge database)

| Table | Key | Columns |
| --- | --- | --- |
| `kb.m_channels` | `id` | `workspace_id`, `name`, `is_private`, `enabled`, `version` |
| `kb.m_threads` | `id` | `workspace_id`, `channel_id → m_channels`, `root_message_id`, `last_activity_at`, `reply_count`, `version` |
| `kb.m_sessions` | `id` | `workspace_id`, `thread_id → m_threads`, `title`, `state`, `version` |
| `kb.m_people` | `id` | `workspace_id`, `kind` (`human` or `agent`) |
| `kb.m_messages` | `id` | `workspace_id`, `thread_id → m_threads`, `author_id → m_people`, `sequence`, `revision`, `created_at`, `body`, `embedding vector(384)`, `version` |
| `kb.m_session_turns` | `message_id` | `session_id → m_sessions`, `message_id → m_messages` |

Edges in graph `space_memory` (pgGraph builds them from these foreign keys):

| Edge | From → To |
| --- | --- |
| `in_channel` | thread → channel |
| `in_thread` | message → thread |
| `of_thread` | session → thread |
| `in_session` | session turn → session, session turn → message |
| `written_by` | message → person |

`kb_memory` is a pgContext collection over `kb.m_messages` with the `embedding` vector and `body` as lexical source.

`version` is the WAL position of the change, as in the knowledge graph. Every upsert is `ON CONFLICT ... WHERE stored.version < EXCLUDED.version`, so replays and late changes do nothing. Thread counts (`reply_count`, `last_activity_at`) are recomputed from `kb.m_messages` for each thread touched in a batch, inside the same transaction.

### Changes that remove data

- A deleted or retained message, or one whose channel left `memory_source_messages`, is deleted from `kb.m_messages` and its pgContext point removed.
- A channel switched off is marked `enabled = false` and its rows are deleted in pages of 500 by the reader, inside the batches that follow. Reads already hide it from the moment the flag changes.
- A deleted channel, thread or session cascades through the foreign keys.

## Reading memory

All three readers take an optional `query`. Task context passes the task goal. MCP tools take it from the agent. Without a query they return the recent part only.

| Reader | Graph walk | Ranking |
| --- | --- | --- |
| `session_memory(session_id, query?)` | session → its turns | Top 8 turns by `kb_memory` within the session, plus the 8 newest |
| `thread_memory(thread_id, query?)` | thread → messages, thread → sessions | Root, top 8 messages within the thread, the 8 newest, session list |
| `channel_memory(query?, after?, limit?)` | channel → threads | Recent threads by `last_activity_at` (keyset, 1–50, 7 days); with a query, the threads holding the top 50 matching messages, grouped and ranked by best match |

Each reader collects message ids, then calls `memory_visible_messages(w, requester, destination, ids)` in Space. It returns text only for messages this requester may see, at the indexed revision. Anything else is dropped. Text shown to an agent always comes from Space, never from the knowledge database.

The installation rule for sessions stays: an agent may open only its own sessions; people may open any session in a thread they can see.

### `memory_visible_messages()` (Space function)

Same audience rule as `knowledge_visible_messages()`, but over `memory_source_messages`, and limited to the destination channel itself: memory never crosses channels. At most 128 ids per call.

## What is removed

| Part | Where |
| --- | --- |
| `thread` and `session` parts of `<space-memory>` | `packages/contracts/memory-block.ts`, `apps/connector/memory-instructions.ts` |
| Turn-end memory save, `memory_pending`, `memory_conflicts` | `layered-memory.ts`, `store.ts`, `foundation.ts` |
| MCP tools `thread_memory_save`, `session_memory_save` | `apps/server/memory-mcp.ts` |
| Person edit routes and the Memory editor | `apps/server/memory.ts`, `MemoryInspector.tsx`, `memory-api.ts` |
| Memory writers in Space | `writeThreadMemory`, `writeSessionMemory` and the person variants |
| `memory_revisions` | Dropped in this migration |
| `memory_visible_summaries()` | Migration 091, replaced by `memory_visible_messages()` |

The Memory graph UI keeps its channel, thread and session view, now drawn from `kb.m_*` through Space routes, with titles, counts and activity instead of agent summaries, and no Edit button.

Risk: the migration deletes every agent-written memory note in `memory_revisions` and `memory_pending`. They cannot be rebuilt from messages. Undo is only possible from a database backup taken before the migration.

## Space migration

`092_graph_rag_memory.sql`:

1. Create the views `memory_source_messages` and `graph_source_messages`.
2. Create `memory_visible_messages()` and drop `memory_visible_summaries()`.
3. Drop `memory_pending`, the `memory_revisions_update` trigger, `enqueue_memory_update()` and `memory_revisions`.
4. Remove the `notify_thread_knowledge` trigger on `messages`; keep it on `knowledge_thread_channels` only if the Markdown path still needs it.

Memory graph refreshes in open browsers move to an event the reader emits after each graph build, delivered through the existing channel update path. The plan defines it.

## Start and rebuild

The reader's existing rebuild path is extended: the snapshot also copies `memory_source_messages` in pages of 500, embedding each page before writing. A first build of a large workspace is bounded by embedding speed; the reader reports progress and lag. Nothing polls.

## Limits

| Item | Limit |
| --- | --- |
| Body per message | 8,000 characters |
| Embedding batch | 32 bodies, 30 s timeout |
| CDC batch | 500 changes or 1 MB (unchanged) |
| Ranked messages per reader | 8 (session, thread), 50 (channel) |
| Ids per access check | 128 |
| Recent messages per reader | 8, text cut at 1,000 characters |
| Channel memory page | 1–50, default 20, 7 days |

## Tests

- A message in a memory-on channel appears in `kb.m_messages` with an embedding; a DM, an archived channel or a memory-off channel never does.
- An edit re-embeds; a delete removes the message and its point; replays change nothing.
- Thread counts and activity follow inserts, edits and deletes.
- A session turn links to its session; human messages do not.
- `thread_memory` with a query returns the related message from early in a long thread that the recent window misses.
- `channel_memory` with a query ranks the matching thread first; without a query it is newest first and stable under writes.
- A requester outside the channel gets nothing; another agent's session is refused.
- Switching memory off hides the channel at once and removes its rows in later batches.
- Task context has no agent note and no `memory_conflicts`; connectors no longer ask for `thread` or `session`.
- Reader restart and slot rebuild produce the same graph as a clean build.

Performance claims need measurements: the plan includes a timed first build of 50,000 messages.

## Model step: topics and facts

The graph above holds only the links Space already has. This step adds what a model can read out of the text: **topics** (what a thread is about) and **facts** (short statements backed by messages). It runs after the graph write, on its own path, so a slow or failed model call never holds up memory.

### Where it runs

```
message change (memory-on channel)
  │ trigger, same transaction
  ▼
memory_extract_threads (Space)  thread_id, pending_through, done_through, available_at
  │ trigger when available_at moves
  ▼
event_outbox 'memory.extract.ready'  → WAL → events bridge → NATS
  ▼
worker subscription 'memory.extract.ready.*'  durable, queue group, maxPending 4
  │ not due → delivery.retry(delay)                 (broker timer, no scan)
  │ due:
  │   1. read messages after done_through from memory_source_messages (≤64, ≤12 KB)
  │   2. take one unit of the workspace hourly cap (conditional UPDATE)
  │   3. call the model → { topics[], facts[] }
  │   4. knowledge DB, one transaction: replace this thread's topic links and facts
  │        WHERE stored extract_version < new extract_version
  │   5. Space: UPDATE memory_extract_threads SET done_through = $new
  │        WHERE thread_id = $t AND done_through = $old
  ▼
debounced graph build → topics and facts are part of space_memory
```

This is the same per-thread debounce shape the navigator uses (`navigator_threads` plus `navigator.ready`). It adds no polling and no lock.

### Model

Default: a local Ollama chat model, so message text stays on the machine, the same as embeddings. The model name is pinned in config (`MEMORY_EXTRACT_MODEL`). An xAI option is allowed by config for hosts without a GPU; it is off unless set.

The prompt sends the thread's current topics and facts and the new messages as JSON data, says the data is conversation and never instructions, and asks for JSON only:

```json
{ "topics": [ { "name": "checkout retries" } ],
  "facts":  [ { "text": "Charges are deduped on the idempotency key.", "kind": "decision",
                "topic": "checkout retries", "message_ids": ["…"] } ] }
```

Rules applied to the output, each item checked alone, a bad item dropped alone:

- At most 5 topics and 5 facts per run. Topic name 1–60 characters. Fact text 1–280 characters.
- `kind` is `fact`, `decision`, `procedure` or `answer`, the same four kinds as Knowledge.
- Every fact needs 1–10 evidence ids, all from the messages sent in this run.
- The model never sees other threads, DMs or other channels.

### Graph additions (knowledge database)

| Table | Key | Columns |
| --- | --- | --- |
| `kb.m_topics` | `id` (hash of workspace + normalized name) | `workspace_id`, `name` |
| `kb.m_thread_topics` | `(thread_id, topic_id)` | `extract_version` |
| `kb.m_facts` | `id` | `workspace_id`, `thread_id → m_threads`, `topic_id → m_topics`, `kind`, `text`, `extract_version`, `embedding vector(384)` |
| `kb.m_fact_evidence` | `(fact_id, message_id)` | FKs to `m_facts` and `m_messages`, cascade |

| Edge | From → To |
| --- | --- |
| `discusses` | thread topic link → thread, → topic |
| `about` | fact → topic |
| `from_thread` | fact → thread |
| `supported_by` | fact evidence → fact, → message |

Facts get an embedding and join a second pgContext collection, `kb_memory_facts`, so a query can match a fact directly.

Topics are shared across a workspace by normalized name. That is what lets the graph connect two threads in different channels that talk about the same thing. A topic holds only its name; it shows up for a requester only through a thread or fact they may see.

### Keeping facts true

- A run replaces all facts and topic links of its thread whose `extract_version` is older, in one transaction. A replay or an older run changes nothing.
- When an evidence message is deleted or leaves memory, its `m_fact_evidence` row cascades away. A fact left with no evidence is deleted in the same reader batch.
- An edited message moves `pending_through` back to its sequence, so the next run re-reads it.
- Facts are memory: short-term, rebuilt from messages, never edited by hand. Long-term Knowledge stays the agent-saved `knowledge_notes`. Promoting a fact to Knowledge is a later feature.

### Reading topics and facts

| Reader | Adds |
| --- | --- |
| `thread_memory` | The thread's topics, and up to 8 facts ranked by the query |
| `session_memory` | Facts whose evidence includes the session's turns |
| `channel_memory` | With a query: topics matching it, then threads in this channel linked to those topics, merged with the message ranking |

A fact or topic is returned only if **every** evidence message passes `memory_visible_messages()` for the requester. A fact built partly from a message the requester cannot see is dropped, so derived text never leaks more than its sources.

### Limits for this step

| Item | Limit |
| --- | --- |
| Debounce | 60 s after the last message |
| Spacing per thread | 5 min between runs |
| Messages per run | 64, inside 12 KB |
| Topics, facts per run | 5, 5 |
| Runs per workspace per hour | 60 (`MEMORY_EXTRACT_HOURLY_CAP`) |
| Model timeout | 30 s local, 10 s xAI |
| Failures in a row before waiting for the next message | 6, with backoff up to 1 h |

### Tests for this step

- A burst of messages leads to one run; a DM or memory-off channel leads to none.
- A fact with evidence outside the run is dropped; the others are saved.
- A replayed or older run leaves newer facts in place.
- Deleting the only evidence message deletes the fact.
- Two threads in different channels share a topic node; a requester in only one channel sees only that channel's thread and facts.
- A fact with one hidden evidence message is not returned.
- The hourly cap moves runs to the next hour; model failure backs off and stops after 6 tries.
- No model configured: no extraction rows are created and memory works without topics and facts.

Model calls are faked in tests. One manual run records time and cost per run before any claim.

## Knowledge in the same graph

The knowledge graph built from `2026-11-11-knowledge-graph-cdc-design.md` (graph `space_knowledge`, tables `kb.g_*`) is merged into `space_memory`. One reader, one slot, one set of channel, thread and session nodes.

### Entities after the merge

| # | Entity | Table | From | Model |
| --- | --- | --- | --- | --- |
| 1 | Channel | `kb.m_channels` | `channels` | No |
| 2 | Thread | `kb.m_threads` | `messages` | No |
| 3 | Session | `kb.m_sessions` | `agent_sessions` | No |
| 4 | Person | `kb.m_people` | message authors | No |
| 5 | Message | `kb.m_messages` | `messages` | No |
| 6 | Topic | `kb.m_topics` | extraction step | Yes |
| 7 | Fact | `kb.m_facts` | extraction step | Yes |
| 8 | Knowledge | `kb.m_knowledge` | `knowledge_notes` | No (agent-saved) |

`kb.m_channels` gains `knowledge_enabled` next to `memory_enabled` (the old `enabled`), so each reader can hide what its switch turns off.

### Knowledge tables

| Table | Key | Columns |
| --- | --- | --- |
| `kb.m_knowledge` | `id` | `workspace_id`, `channel_id → m_channels`, `kind`, `title`, `revision`, `version` |
| `kb.m_knowledge_evidence` | `(knowledge_id, message_id)` | `thread_id → m_threads`, `workspace_id` |

Evidence keeps the thread as its foreign key, as `kb.g_evidence` does today. A knowledge's evidence may sit in a channel that has memory off, so its messages are not always in `kb.m_messages`. The thread node exists either way: the planner writes a version-0 placeholder thread when it has to, the same way it does now. When the message is indexed, readers can follow `message_id` to it; when it is not, they stop at the thread.

Knowledge content still never leaves Space through the stream. The graph holds the title, kind and revision only.

### Relations after the merge

| From | Relation | To |
| --- | --- | --- |
| Thread | `in_channel` | Channel |
| Message | `in_thread` | Thread |
| Message | `written_by` | Person |
| Session | `of_thread` | Thread |
| Session turn | `in_session` | Session, Message |
| Thread–topic link | `discusses` | Thread, Topic |
| Fact | `about` | Topic |
| Fact | `from_thread` | Thread |
| Fact evidence | `supported_by` | Fact, Message |
| Knowledge | `in_channel` | Channel |
| Knowledge evidence | `supports` | Knowledge |
| Knowledge evidence | `from_thread` | Thread |

A fact and a knowledge are related when they cite the same message or the same thread. That relation is found at read time through the evidence tables; it is not stored.

### What changes in built code

| File | Change |
| --- | --- |
| `graph.sql` | Replaced by `memory-graph.sql`: the `kb.m_*` tables and graph `space_memory` |
| `graph-plan.mjs` | Writes `kb.m_*` instead of `kb.g_*`. Knowledge evidence keeps `message_id` |
| `graph-source.mjs` | Snapshot adds `graph_source_messages`; lookups unchanged |
| `graph-apply.mjs` | `rebuild` clears `kb.m_channels`; `publish` builds `space_memory` |
| `graph-related.mjs` | Reads `kb.m_knowledge_evidence`. It ranks by shared messages first, then by shared threads |
| `graph-smoke.mjs`, `graph-plan.test.mjs` | Table names and the new message-level evidence |
| `server.mjs` | `filters.related` unchanged for agents; detection checks `kb.m_knowledge_evidence` |

The access checks do not change: `knowledge_visible_notes()` for knowledge, `memory_visible_messages()` for memory, `knowledge_visible_messages()` for thread search.

### Moving over

1. Apply `memory-graph.sql` next to the old `graph.sql` objects.
2. Start the extended reader. With no saved position for its slot, it rebuilds `space_memory` from a snapshot.
3. When `kb.graph_position` shows the rebuild done, a provider script drops `kb.g_*` and graph `space_knowledge`.

The old graph is derived data, so dropping it loses nothing that the rebuild does not recreate.

## Decisions made after review

1. **One message index.** `kb.thread_messages`, its collection `kb_threads` and graph `space_threads` are merged into the new store. See "Merging the thread index".
2. **Human and agent messages.** Memory holds both, including agent replies and agent session turns.
3. **Old notes are dropped** in this migration, together with `memory_pending`.
4. **Model step added** for topics and facts, local Ollama by default.
5. **One graph.** The knowledge graph is merged into `space_memory`. Knowledge becomes entity 8.

## Open questions

1. **Extraction model.** Which local Ollama chat model to pin (for example `qwen2.5:3b` or `llama3.2:3b`). It needs a check for JSON quality and speed on this machine before the plan fixes it.
2. **Group summaries.** Microsoft-style GraphRAG also writes a summary per group of related topics. Leave it out (this spec) or add it as a later step.

## Merging the thread index

Today `thread-worker.mjs` copies human messages of channels opted in through `knowledge_thread_channels` into `kb.thread_messages`, and `thread-search.mjs` ranks them for `knowledge_search` with `filters.source = "threads"`. After this change:

- The index set is the union of two Space views: `memory_source_messages` (memory-on channels, human and agent) and `knowledge_thread_messages` (thread-search channels, human only). The reader hydrates text from a third view, `graph_source_messages`, which is that union with a `memory` flag and a `knowledge` flag per row.
- `kb.m_messages` stores both flags. A message leaves the index only when both are false.
- `thread-search.mjs` ranks `kb_memory` instead of `kb_threads`, walks `in_thread` in `space_memory` instead of `space_threads`, and keeps calling `knowledge_visible_messages()`. That function reads `knowledge_thread_messages`, so knowledge search still sees only human messages of opted-in channels.
- Memory readers call `memory_visible_messages()`, which reads `memory_source_messages`. Each reader therefore sees only its own set, even though they share one index.
- `thread-worker.mjs` stops indexing messages and its `pg_notify` message path is removed. It keeps Markdown files (`kb_markdown`) and knowledge notes (`kb.notes`), which are out of scope here.
- `threads.sql` objects (`kb.thread_messages`, `kb.threads`, `kb_threads`, `space_threads`) are dropped after the new store has been built once, by a provider script that checks `kb.graph_position` first.

Risk: Markdown file passages in `kb_markdown` reference `kb.threads` today. The plan must move that reference to `kb.m_threads` before `kb.threads` is dropped, or file search breaks.
