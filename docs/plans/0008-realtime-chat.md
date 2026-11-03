# Realtime human and agent chat

Selected 2026-11-03. User selected Socket.IO and rejected Centrifugo and PostgreSQL as the chat broker; Redis carries update hints. Status: implemented and locally verified.

## Scope

Build native chat on the existing Fastify/Postgres backend and a connected React
screen at /chat, reusing the shared UI. Preserve /workspace as the local design preview.

- Workspace channels: create/list, public self-join, private membership, creator or
  current workspace owner/admin management (must already belong to the channel).
- Human channel messages create a thread; replies reference an existing same-channel
  thread. Authenticate authors, reject caller-supplied identity, store idempotent
  client message IDs and reject conflicting retries.
- Messages explicitly identify human or agent. Agent results originate only from
  trusted connector events tied to a task/execution/installation; humans cannot
  send as an agent. Retain task approval and grant checks.
- Durable per-channel event history includes message creation and task lifecycle /
  progress. Database triggers update a locked channel counter and insert events in
  the originating transaction, making sequence order consistent with commit order.
  Existing result messages are backfilled; existing task events remain accessible
  through the task API (no invented historical realtime events).
- Socket.IO handshake auth uses the development bearer token (never URL).
  Socket.IO handshake timeout, bounded frames/commands, heartbeats and backpressure. One
  channel subscription per socket; authorize every catch-up batch and send. REST
  history supplies the initial view; resume after its cursor. Deduplicate replay by
  channel sequence/message ID. WebSocket send uses the same idempotent store as REST.
- Redis Pub/Sub carries update hints between server/worker processes; PostgreSQL
  stores messages and event history only, without LISTEN/NOTIFY or a chat queue.
  Each server rechecks authorization before delivering catch-up batches. Periodic
  reconciliation repairs commit-to-publish gaps and lost Redis signals; browser
  reconnect also resumes from the last event. No exactly-once network claim.
- /chat connects using existing development credentials kept in memory, lists joined
  workspaces/channels, creates/joins channels, sends/replies, and shows live agent
  activity. Explicit task request/approval invokes installed agents through existing
  task APIs; the separate worker handles the mock connector.

## Boundaries

No new login system, external-agent credentials, uploads, rich-text persistence,
message edits/deletes, reactions, presence, direct messages, auto-agent routing or
control commands. Human text is rendered as text, not HTML. Plain text is the stored
contract for this slice. No browser-side polling for chat delivery.

## Execution

- [x] Add contract/API/socket tests proving persistence, isolation, idempotency,
  threads, agent identity, cross-process delivery, reconnect and revocation.
- [x] Add migration 005, contracts, ChatStore, event triggers and Redis signal adapter.
- [x] Add Socket.IO handlers and HTTP chat routes and safe connection lifecycle; wire shared auth.
- [x] Build connected React chat using existing UI, reliable retry/reconnect and
  explicit agent task controls; test client event handling and interactions.
- [x] Verify backend/frontend builds and tests, real multi-client WebSocket flow,
  agent result delivery, migration compatibility; review and document limits.


## Verified outcome

- `pnpm test`: 56 backend tests, 46 shared UI tests, 6 web tests passed.
- `pnpm typecheck` and `pnpm build` passed. Existing Vite bundle-size / dependency
  directive warnings remain; no build failures.
- Frozen-lockfile install and Compose configuration validation passed.
- Read-only review findings fixed: long-thread pagination, independent Redis delivery
  tests, and retryable server disconnect recovery.
- Browser smoke: human message → agent request → owner approval → mock result in the
  same thread; history survives reload. Narrow 390px and desktop layouts inspected.
- Local demo on port 5174 uses `.env.chat-demo`; no credentials are committed.

Run details and delivery limits: `../architecture/realtime-chat.md`.
