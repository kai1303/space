# Realtime chat

Implemented locally on 2026-11-03. Authentication is now provided by Better Auth;
see [authentication setup](authentication.md) for required environment variables and
account/session behavior. The original development-token login has been replaced. Fastify + Socket.IO over WebSocket; Redis Pub/Sub
carries update notifications. PostgreSQL + Drizzle stores permanent messages, threads
and channel history. No Centrifugo or PostgreSQL LISTEN/NOTIFY is used for chat.

```mermaid
flowchart LR
  UI[React chat] <-->|Socket.IO / WebSocket| API[Fastify API]
  UI -->|History, channels, task approvals| API
  API -->|Drizzle transactions| DB[(PostgreSQL history)]
  API -->|Committed update hint| Redis[(Redis Pub/Sub)]
  Worker[Agent worker] -->|Trusted agent events| DB
  Worker -->|Committed update hint| Redis
  Redis -->|Wake subscribed API instances| API
  API -->|Authorize and read newer history| DB
```

## Run locally

```sh
pnpm install --frozen-lockfile
docker compose up -d postgres redis
export DATABASE_URL=postgres://workplace:local_demo_only@127.0.0.1:55438/workplace
export REDIS_URL=redis://127.0.0.1:56380
pnpm migrate
# Set BETTER_AUTH_SECRET / BETTER_AUTH_URL as described in authentication.md
pnpm server                     # terminal 1
pnpm worker                     # terminal 2, export the same URLs
pnpm web                        # terminal 3; open /chat
```

Register or sign in at `/chat` using email/password. The browser sends an HttpOnly
session cookie to both HTTP and Socket.IO. Reload restores the session. New accounts
can create their own workspace and channel. Legacy operator demo tokens require
an explicit development-only flag and are no longer entered through the UI.

The Vite dev server proxies `/v1` and `/socket.io` to port 3000. Restart Vite if it was
running before the proxy configuration was created. `/workspace` remains the design
preview. The mock-agent bootstrap is an operator demo; it does not automatically
link its legacy users to new Better Auth registrations.

Send a message, open its reply action, expand **Ask an agent**, choose `demo.echo`,
and request a task. The installation owner can approve it; the worker runs the mock
connector and posts an explicitly labeled agent result into the originating thread.
A channel grant is required. The bootstrap supplies one for its general channel;
new channels do not automatically inherit agent grants.

## Contract

HTTP uses Better Auth session cookies and the existing JSON error conventions:

| Endpoint | Behavior |
| --- | --- |
| `GET /v1/workspaces/:id/channels` | Visible public/member channels; existing `after`/`limit` pagination |
| `POST /v1/workspaces/:id/channels` | `{name, private}`; creator joins |
| `POST /v1/channels/:id/join` | `{}`; public self-join |
| `POST /v1/channels/:id/members` | `{user_id}`; channel creator or member with workspace owner/admin role |
| `DELETE /v1/channels/:id/members/:userId` | Leave yourself, or manager removes member |
| `POST /v1/channels/:id/messages` | `{client_message_id, text, thread_id?, document?}`; returns saved message |
| `GET /v1/channels/:id/messages?before=sequence&limit=50` | Message-table history; optional `before` **or** `after`, limit 1–100 |
| `GET /v1/threads/:id/history?after=sequence&limit=50` | Independently paginated message-table history for one thread |
| `GET /v1/channels/:id/history?before=sequence` | Latest 100 events in ascending order, `cursor`, `oldest_cursor`, `has_more` |
| `GET /v1/threads/:id/messages?before=messageId` | Latest 200 messages in ascending order; use the first message ID to retrieve older pages until a short/empty page |

Socket.IO connects at its default `/socket.io` path, with `transports: ['websocket']`
and `withCredentials: true`. Browser origins must appear in the configured
`BETTER_AUTH_URL` / `AUTH_TRUSTED_ORIGINS` list. Non-browser clients may omit Origin.
Authentication and authorization are required regardless of Origin.

| Event | Payload / acknowledgment |
| --- | --- |
| client → `channel.subscribe` | `{channel_id, after: "0"}`; ack `{data: {channel_id, cursor}}` or `{error}` |
| client → `message.send` | `{channel_id, client_message_id, text, thread_id?, document?}`; ack `{data: ChatMessage}` or `{error}` |
| server → `chat.events` | `{channel_id, events, cursor}`; client must acknowledge after accepting the batch |
| server → `chat.error` | `{error}`; fatal stream/auth error followed by disconnect |

One channel subscription per socket. Switching channels in the UI closes the old
socket and clears its displayed history while retaining its unsent draft. Every command and replay batch checks identity;
replay also checks active workspace and channel membership. Human sends
cannot supply their own author identity. Agent messages can only come through the
trusted task-event acceptance path.

A root message creates a thread. Replies reference a thread in the same channel.
Retries reuse the original client message ID; conflicting content returns 409.
The UI preserves a failed draft and its retry ID within the mounted composer.
Unsent drafts survive in-app channel/workspace/thread navigation but are not persisted across reload.

## Message storage and scrolling

Migration 016 adds an immutable bigint `messages.sequence`. A database trigger locks
the channel counter before allocating the sequence; the message's `message.created`
event uses that same sequence in the same transaction. Human sends and trusted agent
results use this path. Existing messages are backfilled from their original events,
without changing message IDs or rewriting the append-only event log. Task events and
conflict retries can leave gaps; sequences are ordered, not contiguous.

History queries read `messages`, using indexes on `(workspace_id, channel_id, sequence)`
and `(workspace_id, channel_id, thread_id, sequence)`. `before` selects the nearest
older messages; `after` selects the nearest newer messages. Both return ascending
order, default to 50 messages, and reject limits above 100. Their response is:

```ts
{
  messages: ChatMessage[], // sequence is a decimal string
  older_cursor: string | null,
  newer_cursor: string | null,
  has_older: boolean,
  has_newer: boolean,
  event_cursor: string
}
```

Each page and its event watermark share a repeatable-read snapshot. The browser keeps
the Socket.IO reconnect cursor separate from history boundaries. Initial task activity
comes from the existing event endpoint; subscribing from the earlier of both snapshot
watermarks avoids missing intervening activity. Old replay payloads can use their
enclosing event sequence when the message payload predates migration 016.

Channel and thread views independently load near the top or bottom. TanStack Virtual
measures variable-height rows and preserves the visible message on prepends. Each view
retains at most 500 messages, evicts the far end when paging, and can fetch evicted
messages again. Live messages follow the viewport only when it is at the bottom;
otherwise the reader keeps their position. A historical window offers **Jump to latest**.
Search covers the currently retained messages. Initial network failures expose a retry;
revocation clears cached history and ignores in-flight responses.

History is retained indefinitely. Migration 018 now places both `messages` and
`channel_events` in 16 hash partitions by channel, with a separate identity registry
preserving global uniqueness and attachment integrity. History and replay queries prune
to the relevant partition; message IDs, cursors, and the Redis transport stay unchanged.
See [chat partitioning](chat-partitioning.md) for the schema, migration procedure,
maintenance requirements, and limits.

The full composer sends an optional structured `document: {ops: [{insert, attributes?}]}` alongside text. Supported attributes include links, inline emphasis/code, ordered/bullet lists, quotes and code blocks. The server accepts string inserts only, rejects unknown fields/embeds and unsafe link protocols, and requires the document's trimmed text to equal `text`. Documents are bounded to 10,001 UTF-16 characters including the editor newline, 20,000 operations and 32 KiB of serialized UTF-8 data. `RichContent` renders allowed React elements without injecting HTML. Migration 007 stores nullable JSONB and includes documents in newly created channel events; old messages/history remain valid plain text. Document contents participate in retry identity and server request hashes.

## Delivery and failure behavior

- Message/task writes and channel history are committed in the same PostgreSQL
  transaction. A per-channel locked counter makes cursor order match commit order.
- Redis carries only a generic wake-up hint. Every API instance reads the authorized
  history for its connected subscribers. The worker publishes after committed task
  mutations. This is a small initial deployment design, not a large-scale benchmark.
- Redis Pub/Sub is not durable. Server reconciliation every 10 seconds repairs lost
  hints and commit-to-publish crashes. Reconnection resumes after the last accepted
  cursor. PostgreSQL is the history source, not the realtime message broker.
- Network delivery is not exactly-once. Clients deduplicate channel sequence values;
  message IDs and client request IDs prevent duplicate durable sends. Sequence values
  are decimal strings to preserve bigint precision in JavaScript.
- Catch-up pages contain at most 100 events, with one acknowledged page in flight.
  A client that does not acknowledge within 5 seconds is disconnected with `ack_timeout`.
  The browser reconnects with bounded backoff, preserves its history, and resumes
  from its accepted cursor; authorization failures remain terminal. Payloads are
  limited to 128 KiB for inbound socket frames and HTTP message bodies (other HTTP bodies remain 32 KiB); plain text to 16,000 characters; sockets accept at most 30 commands/s
  with one command executing at a time.
- HTTP membership changes notify connected servers. Direct database changes, lost
  notifications and credential deletion are caught on the next reconciliation or
  command. Already delivered content cannot be recalled from a client.
- Migration 005 preserves and backfills old result messages. Earlier task activity
  remains available through the task-event API; it is not invented in chat history.

The existing experimental **agent dispatch outbox** still lives in PostgreSQL. It
is separate from chat transport and was not migrated in this slice. A future durable
job-queue decision should address that worker independently.

## Scope and verification

```sh
export TEST_DATABASE_URL="$DATABASE_URL"
export TEST_REDIS_URL="$REDIS_URL"
pnpm test:chat
pnpm test
pnpm typecheck
pnpm build
```

Chat integration tests use a disposable schema and unique Redis topic. They cover
cross-tenant access, private membership, idempotency, trusted agent authors,
Redis-only cross-instance delivery, missed-notification reconciliation, reconnect
replay, >200-message history, malformed commands, Origin checks and revocation.
UI tests cover event deduplication, bigint ordering, retry IDs, offline sends,
channel-switch isolation and history clearing on revoked access. Browser smoke checks
cover a human send, agent task approval/result, saved history after reload and a
390px layout. These are local checks, not production load or security certification.

Message-history verification additionally covers migration preservation, equal-timestamp
ordering, bidirectional pages, thread isolation, concurrent sends, sequence gaps,
snapshot/replay races, cache eviction, StrictMode startup and fetch retry. A local
650-message browser fixture verified independent thread scrolling, virtualized rows,
stable reader position on live arrivals, and following the latest message at the bottom.

Email verification/reset delivery, external agent enrollment/transport, presence, DMs,
message edits/deletes and auto-agent routing remain later modules. The frontend supports
stored rich documents with a plain-text fallback and uses the mock connector.
For production, serve the frontend and Socket.IO behind a TLS reverse proxy supporting
WebSocket upgrade; the Vite proxy is development tooling.

Private chat attachments now use self-hosted SeaweedFS. See [asset storage](assets.md) for setup, API contracts, limits and verification.
