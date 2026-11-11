# Knowledge graph from change data capture

## Goal

Build a knowledge graph from Space's own data, with no polling and no locks. A separate service reads every committed change from PostgreSQL through logical replication (change data capture, CDC) and keeps a graph up to date.

Today the [knowledge](2026-11-11-knowledge-notes-design.md) ingestor listens to `pg_notify`. A notify is lost if the listener is down, so the ingestor also rescans on restart. CDC replaces that gap: the database keeps every change until the reader confirms it.

Wording: this spec calls one saved item **a knowledge** and many **knowledge**. The table is still named `knowledge_notes` in code. Renaming it is a separate decision and is not part of this spec.

## Scope

| In | Out |
| --- | --- |
| Reader service for logical replication | Renaming `knowledge_notes` |
| Graph of channels, threads and knowledge | Memory checkpoint content in the graph (see open questions) |
| Replay, restart and rebuild | A graph UI (the Memory graph UI stays as is) |
| Access rules on graph reads | Auto-promotion rules (Knowledge part 4) |

## Decisions

| Question | Decision |
| --- | --- |
| How changes are read | Logical replication with the built-in `pgoutput` plugin |
| What is replicated | A publication `space_graph` on `knowledge_notes`, `channels` (selected columns) and `agent_sessions` |
| Reader | A small own service in TypeScript, not Debezium. One less system to run, and the stream is small |
| Where the graph lives | The knowledge database (PostgreSQL 17 with pgGraph), next to pgContext |
| What the graph stores | Ids, titles, kinds, revisions and workspace and channel ids. Never the full content |
| Who may read it | Checked live on every read, with the same rule as `knowledge_visible_notes()` |
| Where the reader keeps its place | In the graph database, in the same transaction as the graph write |

## Data flow

```
Space PostgreSQL (wal_level=logical)
  knowledge_notes, channels, agent_sessions
        │ WAL
        ▼
  replication slot  space_graph        ← keeps changes until confirmed
        │ pgoutput stream
        ▼
  graph-reader service
        │ one transaction per batch:
        │   upsert nodes and edges  +  save position (LSN)
        ▼
  knowledge database
    kb.graph_nodes, kb.graph_edges, kb.graph_position
        │ debounced publish
        ▼
  pgGraph named graph  ──►  knowledge_search related evidence
        │
        ▼ confirm LSN to the slot, after the commit
```

`compose.yaml` already starts Postgres with `wal_level=logical`, `max_replication_slots=20` and `max_wal_senders=20`. Production settings must match.

## Graph model

| Node | Key | Properties |
| --- | --- | --- |
| Channel | `channel/<uuid>` | workspace id, name, private flag |
| Thread | `thread/<uuid>` | workspace id, channel id |
| Session | `session/<uuid>` | workspace id, thread id, agent name, state |
| Knowledge | `knowledge/<uuid>` | workspace id, channel id, kind, title, revision |

| Edge | From → To |
| --- | --- |
| `HAS` | Channel → Thread |
| `HAS_SESSION` | Thread → Session |
| `HAS_KNOWLEDGE` | Channel → Knowledge |
| `EVIDENCE` | Knowledge → Thread (the thread of each evidence message) |

This matches the colors and edges of the [Memory graph UI](2026-11-11-memory-graph-ui-design.md), plus a Knowledge node. `EVIDENCE` is the new link: it lets an agent follow a knowledge back to the conversation it came from.

pgGraph builds edges from foreign-key columns, as `threads.sql` does for `kb.thread_messages`. So each node type is its own table, and an edge is a foreign key with `ON DELETE CASCADE`. The many-to-many `EVIDENCE` link is a small join table.

Tables in the knowledge database:

- `kb.g_channels(id, workspace_id, name, is_private, enabled, version)`
- `kb.g_threads(id, workspace_id, channel_id → g_channels, version)`
- `kb.g_sessions(id, workspace_id, thread_id → g_threads, title, state, version)`
- `kb.g_knowledge(id, workspace_id, channel_id → g_channels, kind, title, revision, version)`
- `kb.g_evidence(id, knowledge_id → g_knowledge, thread_id → g_threads, workspace_id)`
- `kb.graph_position(slot PK, lsn pg_lsn, published_lsn pg_lsn)`

`version` is the WAL position of the change as a number. A snapshot row has version 1 and a placeholder row (a parent that has not arrived yet) has version 0. The pgGraph graph `space_knowledge` is built from these tables, with source identifiers only.

Direct-message channels never enter the graph. The publication sends only the columns the graph needs. The long `content` column of a knowledge never leaves Space through this stream.

## Applying a change

The reader turns each row change into a small set of writes. All writes are idempotent.

- **Node upsert** is `INSERT ... ON CONFLICT (key) DO UPDATE ... WHERE kb.graph_nodes.revision < EXCLUDED.revision`. A replay or an older change cannot overwrite a newer one.
- **Removal** of a knowledge (its `removed_at` is set) marks the node `deleted` and removes its edges. A hard `DELETE` does the same.
- **Edge sets** for a knowledge are replaced from its evidence list in one statement per revision.
- **Switch off.** When `channels.knowledge_enabled` turns false, the channel's knowledge nodes are hidden on read, not deleted. Turning it on again needs no rebuild.
- **Unknown tables or columns** are skipped and counted. A schema change in Space never stops the reader.

Evidence messages map to threads through a lookup in Space, done once per revision and cached in the batch. A message that no longer exists drops its edge.

## Position and exactly-once effect

1. Read a batch from the slot, up to 500 changes or 1 MB, or when the stream goes quiet for 200 ms.
2. In one graph transaction: apply the writes, then set `kb.graph_position.lsn` to the batch end.
3. After the commit, send the standby status update that confirms the LSN to Postgres.

If the reader dies between steps 2 and 3, Postgres sends the batch again. The revision guard makes the replay a no-op, and the saved position lets the reader skip changes it already applied. If it dies before step 2, nothing was applied and the batch is simply sent again.

No change is lost and none is applied twice in effect. This does not use a lock, a lease or a timer scan.

## Start and rebuild

- **Normal start.** The reader connects to the existing slot and resumes from the confirmed LSN.
- **First start, missing slot or missing position.** The reader makes sure the slot exists, then reads the current rows of the three tables in one repeatable-read snapshot, in pages of 500, and writes them to the graph in one transaction that first clears the old graph. Writes that race the snapshot are already in the slot, and the version guard lets the stream correct any row the snapshot read too early. This is the same order `apps/events/bridge.ts` uses for the event outbox.
- **Invalidated slot.** If Postgres marks the slot `lost` because it fell too far behind, the reader drops it, makes a new one and does the rebuild above. This is recovery of a lost slot, not a periodic scan.
- **One reader per slot.** Postgres allows one active connection per slot. A second reader fails to connect and retries with backoff, up to a bounded count, then exits. Correctness does not rely on this: writes are idempotent and the position only moves forward, so two readers would not damage the graph.

## Reading the graph

Graph reads never trust the graph alone. Each result is passed through `knowledge_visible_notes()` (the same access rule as search) for the requester and the destination channel. A node that fails the check is dropped, and so are the edges around it. The graph holds titles only, so a stale graph can at worst show an old title to someone who can still see the channel.

The gateway only exposes `knowledge_search`, `knowledge_resolve` and `knowledge_manifest` to agents. So related knowledge is a new filter on `knowledge_search`: `filters.related = "note/<uuid>"`. It returns other knowledge that cites at least one thread the given knowledge cites, ranked by how many threads they share, limit 1–50. The first version finds them with a SQL join on `kb.g_evidence`, one hop through a thread. Deeper traversal with `graph.traverse` is left for later.

## Limits

| Item | Limit |
| --- | --- |
| Batch | 500 changes or 1 MB |
| Reader memory for one transaction | 16 MB. A larger transaction is applied in streamed pieces |
| Evidence edges per knowledge | 20 |
| Traversal depth | 2 |
| Neighbours returned | 50 |
| Slot lag | `max_slot_wal_keep_size` set (value chosen in the plan). The reader reports lag in bytes |

A reader that stops for a long time keeps WAL on the Space database. The size cap protects the disk. When the cap is hit the slot is invalidated and the rebuild path runs.

## Events and signals

The reader exposes its lag, last applied LSN, batch size and skipped-change count. It sends no polling queries. The pgGraph publish after a batch is debounced (at most one per second) so that a burst of changes costs one publish.

## Tests

- Replaying the same batch twice leaves the graph unchanged.
- An older revision arriving after a newer one is ignored.
- Killing the reader between the graph commit and the confirm replays safely.
- Killing it before the graph commit loses nothing.
- Removing a knowledge removes the node and its edges.
- Switching `knowledge_enabled` off hides nodes and on shows them again, without a rebuild.
- A private channel's knowledge is not returned to a public destination.
- A deleted evidence message drops its edge only.
- A dropped slot triggers a rebuild that matches a clean build.
- Two readers on one slot: the second one exits and the graph stays correct.

Performance claims need measurements: the plan includes a run of 100,000 changes to record batch time and lag.

## Open questions

1. **Incremental pgGraph.** Settled: the thread worker already rebuilds its named graph with `graph.build_graph(name, true)` after changes. The reader does the same, debounced, and records `published_lsn` so a crash before the publish is repaired on the next start.
2. **Memory checkpoints.** This spec keeps checkpoint content out of the graph because Memory is short-term. Say if sessions and threads should also get summary text in the graph.
3. **Rename.** Say whether `knowledge_notes` and `NoteKind` should be renamed before this is built, so the publication is created with the final names.
4. **Replication library.** Settled: `pg-logical-replication` 2.6.0, the version `apps/events` already uses.
