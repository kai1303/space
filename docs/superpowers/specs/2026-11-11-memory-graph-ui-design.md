# Memory graph UI

## Goal

Let people see the layered short-term memory (`docs/superpowers/specs/2026-11-11-short-term-memory-design.md`) as a graph. Channel managers can also correct a checkpoint.

The look follows the Neo4j Browser graph view: circle nodes, named arrows, a force layout, double-click to expand, a ring menu and a right-hand details panel. **All code is written for Space.** Neo4j Browser is GPL-3.0 and Space is MIT, so no Neo4j source, logo, icons or name is copied. Only the interaction design is reused. The layout uses `d3-force`, `d3-zoom`, `d3-drag` and `d3-selection` (ISC).

Out of scope: a Knowledge graph view, graph search, and editing the Markdown notes (the existing editor stays as it is).

## Where it lives

The existing channel **Memory** dialog (`apps/web/src/features/memory/ChannelMemory.tsx`, opened from the channel) gets two views:

| View | Content |
| --- | --- |
| Graph (default) | The memory graph and its details panel |
| Notes | Today's Markdown channel notes editor, unchanged |

The Graph view works while Markdown notes are off. It needs only channel membership.

```
┌ Memory in #payments ─────────── [Graph] [Notes] ─────────────────┐
│ ⊕ ⊖ ⤢   ● channel ● thread ● session ● ended   │ Thread A         │
│                                                  │ rev 3 · Codex    │
│      (Thread B)                                  │ 2h ago           │
│          \ HAS                                   │──────────────────│
│ (#payments)──HAS──(Thread A)                     │ Dedupe fix ·     │
│                      │ HAS_SESSION               │ in progress      │
│               ┌──────┴──────┐                    │ ▸ Checkpoint     │
│         (Codex run)   (Claude run)               │ ▸ Sources (3)    │
│                                                  │ [Edit] (manager) │
│ Load more threads                                │ Open thread →    │
└──────────────────────────────────────────────────┴──────────────────┘
```

## Components

| Unit | Path | Job | Depends on |
| --- | --- | --- | --- |
| `GraphCanvas` | `packages/ui/src/graph/` exported as `@space/ui/graph` | Generic graph view: nodes, links, layout, zoom, drag, selection, ring menu, keyboard focus. Knows nothing about memory | d3 modules, `@space/ui` tokens |
| `MemoryGraph` | `apps/web/src/features/memory/MemoryGraph.tsx` | Maps memory nodes to graph nodes, loads children on expand, keeps the expanded set, refreshes on live events | `GraphCanvas`, memory API, `subscribeUpdates` |
| `MemoryInspector` | `apps/web/src/features/memory/MemoryInspector.tsx` | Right panel: node details, checkpoint, sources, editor for managers | `@space/ui/primitives` |
| Read and edit routes | `apps/server/memory.ts` | Human HTTP access to the layers | `@space/postgres/layered-memory` |

### `GraphCanvas` contract

```typescript
type GraphNode = { id: string; kind: string; caption: string; ring?: boolean; muted?: boolean };
type GraphLink = { id: string; source: string; target: string; label: string };
type GraphCanvasProps = {
  nodes: GraphNode[]; links: GraphLink[];
  palette: Record<string, string>;            // kind → CSS colour token
  selectedId?: string; expandedIds: ReadonlySet<string>;
  onSelect(id: string | undefined): void;
  onToggleExpand(id: string): void;            // double-click, Enter, or ring menu
  menu?(id: string): { label: string; onClick(): void }[];
  label: string;                               // accessible name
};
```

- **Layout:** `forceManyBody`, `forceLink` (distance = both radii + 90 px), `forceCollide`, and weak `forceX`/`forceY` to the centre. Velocity decay is 0.4. It stops below alpha 0.05. Up to 300 ticks are pre-computed before the first paint, so the graph appears settled. New nodes start on a circle around their parent. Dragging pins a node, and double-clicking an empty area unpins all.
- **Drawing:** SVG. Nodes are circles with a caption cut to 24 characters and an ellipsis. Links are arrows with a centred label. Two links between the same pair curve apart.
- **Zoom:** wheel and pinch, the ⊕ ⊖ buttons, and ⤢ to fit everything. Zoom range 0.2–4.
- **Ring menu:** appears around the selected node with Expand/Collapse, Open and Hide.
- **Motion:** respects `prefers-reduced-motion`. When it is set, the layout runs fully before painting and nothing animates.
- **Accessibility:** the SVG has `role="application"` with the `label`. Every node is a focusable `role="button"` with its caption and kind. Arrow keys move focus between linked nodes, Enter toggles expand, and Space selects. A hidden list next to the canvas mirrors the nodes for screen readers.
- **Bounds:** the canvas refuses more than 500 nodes and shows a "too many items" note instead.

## Graph model

| Memory node | Graph kind | Colour | Caption | Ring |
| --- | --- | --- | --- | --- |
| Channel | `channel` | blue | `#name` | — |
| Thread | `thread` | green | `summary` | Expand, Open thread, Hide |
| Session (active) | `session` | orange | agent name | Open session, Hide |
| Session (ended) | `session` + `muted` | grey | agent name | Open session, Hide |

Links: channel → thread `HAS`, thread → session `HAS_SESSION`.

**Start:** the channel node plus the first page of threads (20). "Load more threads" adds the next page using `next_cursor`, up to 50 per request.

**Expand:** double-clicking a thread loads `thread_memory` and adds its sessions (at most 50). Double-clicking again removes them. Hide removes a node from the view only.

## Details panel

| Field | Channel | Thread | Session |
| --- | --- | --- | --- |
| Title | `#name` | `summary` | title and agent |
| Meta | thread count in view | revision, writer, time | state, revision, writer, time |
| Checkpoint | — | Markdown text, collapsed | Markdown text, collapsed |
| Sources | — | links to the source messages | links to the source messages |
| Usage | — | `checkpoint_chars / 6000` bar | same |
| Action | — | Open thread → | Open session → |
| Edit | — | managers only | managers only |

Text is shown as plain text in a scrollable block, like the existing notes editor. It is not rendered as HTML.

## Editing

- Only **channel managers** see Edit, and the server checks the role on every save.
- The editor has `summary` (1–280) and `content` (1–6,000), with live character counts.
- Save sends `{ revision, summary, content }`. The server uses the thread's latest message as the watermark and source, like the turn-end save, and records the person as `producer_id` / `producer_name`.
- On `409`, the draft is kept. The panel shows the newer checkpoint next to the draft, and the person can copy from it and save again on the new revision. Closing with unsaved changes asks first.
- An edit is a normal new revision, so old revisions stay stored. An agent whose turn-end block used the old revision gets a `memory_pending` conflict and merges it on its next turn.
- Edits to an ended session are refused with `409 session_ended`.

## HTTP routes

All routes require an authenticated actor and current channel membership. They return `Cache-Control: no-store`, the same as the other memory routes.

| Method | Path | Body | Returns | Rule |
| --- | --- | --- | --- | --- |
| GET | `/v1/channels/:channelId/memory/layers?after=&limit=` | — | `ChannelMemoryPage` | Member |
| GET | `/v1/channels/:channelId/threads/:threadId/memory` | — | `ThreadMemory` | Member, thread in channel |
| GET | `/v1/channels/:channelId/agent-sessions/:sessionId/memory` | — | `SessionMemory` | Member, and the actor can open the session through the existing `GET /v1/agent-sessions/:sessionId` rule |
| POST | `/v1/channels/:channelId/threads/:threadId/memory` | `{ revision, summary, content }` | `ThreadCheckpoint` | Channel manager |
| POST | `/v1/channels/:channelId/agent-sessions/:sessionId/memory` | `{ revision, summary, content }` | `ThreadCheckpoint` | Channel manager, session in channel |

- The human session read needs a variant of `readSessionMemory` that skips the installation check. It is authorized by the session read rule instead.
- The human session write needs a variant of `writeSessionCheckpoint` that skips the installation check. It is authorized by the manager role instead.
- Errors: non-member `404`, non-manager `403`, stale revision `409 thread_checkpoint_conflict` / `409 session_checkpoint_conflict`, ended session `409 session_ended`, bad summary `400 invalid_summary`, too long `413 checkpoint_too_large`.
- Writes use the same optimistic insert as agents. No row locks are added.

## Live updates

There are no timers. No delivery fires for checkpoint inserts today, so migration `087_memory_updates.sql` adds an `AFTER INSERT` trigger on `thread_checkpoints`. It inserts one `chat_delivery_outbox` row per checkpoint with `resource_scope = 'metadata'` and the checkpoint's `channel_id`. The existing `enqueue_stream_chat` trigger (migration 049) turns that into `workspace:` and `channel:<id>` keys.

`MemoryGraph` subscribes with the existing `subscribeUpdates('channel', channelId, …)`. On an update, it re-reads the loaded index pages and the expanded threads. A re-read keeps the expanded set, the selection and the node positions. Losing access closes the dialog the same way the notes view does.

## Bounds

- Up to 20 threads on first load and 50 per "Load more".
- Up to 50 sessions per expanded thread.
- Up to 500 nodes on the canvas.
- Checkpoint text is at most 6,000 characters and summaries 280, as stored.

## Tests

| Layer | Test |
| --- | --- |
| `GraphCanvas` (Vitest + Testing Library) | Renders nodes and links with accessible names. Click selects, double-click and Enter toggle expand. Arrow keys move focus. Reduced motion paints with no animation. Over 500 nodes shows the note |
| `MemoryGraph` | First page shows the channel plus threads. Load more appends with no duplicates. Expanding a thread adds sessions and collapsing removes them. A live event re-reads and keeps the expanded set. Revocation closes the view |
| `MemoryInspector` | A member sees no Edit. A manager edits and saves. `409` keeps the draft and shows the newer text. Closing a dirty editor asks. An ended session shows no Edit |
| Server integration | Each route checks membership. A non-manager write gets `403`. A stale revision gets `409`. A session the actor can't open gets `404`. A manager edit appears as a new revision with the person as writer. A later agent turn-end save on the old revision becomes pending |
| Storybook | `GraphCanvas` stories for small, crowded, curved double links and reduced motion |

## Files

| Action | Path |
| --- | --- |
| Create | `packages/ui/src/graph/GraphCanvas.tsx`, `layout.ts`, `arrows.ts`, `graph.css`, `index.ts`, plus tests and a story |
| Modify | `packages/ui/package.json` (add the `./graph` export and the d3 dependencies) |
| Create | `apps/web/src/features/memory/MemoryGraph.tsx`, `MemoryInspector.tsx`, `memory-graph.css`, plus tests |
| Modify | `apps/web/src/features/memory/ChannelMemory.tsx` (Graph and Notes views) |
| Modify | `apps/server/memory.ts` (5 routes) |
| Modify | `adapters/postgres/layered-memory.ts` (human read and write variants) |
| Create | `adapters/postgres/migrations/087_memory_updates.sql`, and register it in `adapters/postgres/migrate.ts` |
| Create | `tests/integration/memory-graph.test.ts` |
