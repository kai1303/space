# Message search

Space searches accessible workspace conversations through Typesense. PostgreSQL remains authoritative for message content, revision and access. The top search button searches across channels and direct messages without leaving the current view; a conversation's search button fixes the scope to that conversation. Results include older history and ordinary thread replies. Selecting a result uses the existing source-message API, which checks access again, and opens the thread for a reply.

Agent-session messages are excluded. Search covers up to 32,000 characters of message text and rich-text link targets per indexed document. It does not extract attachment contents or search channel memory. Semantic/vector search, relevance customization and result highlighting are not implemented. The production UI uses remote search; gallery demonstrations retain their local examples.

## Query syntax

`GET /v1/workspaces/:workspaceId/search?q=...&channel_id=...&cursor=...` requires an authenticated actor. `channel_id` is optional and intersects with any `in:` filter. The response contains `items` and `next_cursor`; each item includes message ID, channel ID/name/kind, thread ID, text, creation time, author ID/name and `is_reply`. There is no total count or facet response.

| Input | Meaning |
| --- | --- |
| `release checklist` | Search message text using Typesense token matching. Prefix matching, typo tolerance and token dropping are disabled. |
| `"release checklist"` | Quoted phrase, passed to Typesense as a phrase. |
| `in:general` or `in:#general` | Exact channel name, compared case-insensitively. Quoted names may contain spaces. |
| `from:me` | The current actor's messages. |
| `from:"Jamie Chen"` | Exact current human display name or agent-definition name, compared case-insensitively. Multiple matching authors are included, up to 100. An optional leading `@` is accepted. |
| `has:link` | Indexed text or rich-text link targets contain an HTTP, HTTPS or mailto link. |
| `is:thread` | Messages whose ordinary thread has another message; includes its root and replies. |
| `before:2026-11-04` | Created strictly before midnight UTC on that date. |
| `after:2026-11-01` | Created at or after midnight UTC on that date. |

Filter names are case-insensitive; the literal values `link` and `thread` are lowercase. Repeating a channel, author or date filter uses its last value. Filters can be combined without text; the engine then receives `*`. Unknown filters, invalid dates, unmatched quotes, control characters, empty queries and queries longer than 500 characters return `invalid_search`. HTTP/HTTPS URLs and quoted text are treated as text rather than filter names.

## Indexing and authorization

[Migration 050](../../adapters/postgres/migrations/050_message_search.sql) adds one `search_revision` and an immutable, sequence-assigned `search_order` per message. A trigger advances it when text, rich document, attachments or agent-session association changes; reaction-only updates do not rebuild the search document. Insert, relevant update and delete operations enqueue a small `search.message` outbox event in the same transaction. The migration creates an initial-backfill state bit set to false; it does not scan messages into the outbox. Message triggers always emit events, including before a search consumer is configured.

The existing WAL CDC bridge publishes committed events to a dedicated schema-scoped `SEARCH` JetStream stream with Interest retention. With no durable consumer, published search events are not retained as a broker backlog. Configured API processes share the durable `message-search-v1` consumer and queue, with four pending deliveries. After subscribing, the first configured consumer atomically changes the initial-backfill state bit and enqueues a durable `search.backfill` job. This job walks message identities in keyset pages of 500, emitting message events and a continuation in the same bounded transaction. Re-delivering a page is safe. The state bit records initial activation; it does not gate message triggers. Each message event reloads the current row from PostgreSQL. A document ID combines the message ID and revision, so an older write cannot overwrite the newer revision. The consumer upserts the current document, removes strictly older revisions, then rechecks the row and removes its own document if the revision changed or the row disappeared. A missing or excluded message removes its indexed revisions. Failed operations use a five-second delayed negative acknowledgement of the original durable delivery; completed operations are acknowledged. Search does not use scheduled retry subjects. A stopped process leaves its durable consumer in place, so unfinished search work remains recoverable.

Search first resolves the actor's current channel memberships and active workspace membership in PostgreSQL. This includes joined channels and participating DMs, not every discoverable public channel. Typesense receives only that scope. Candidate IDs and revisions are then hydrated from PostgreSQL with a second membership check. Deleted messages, excluded agent-session messages and stale revisions are discarded. Text, names, timestamps and reply metadata in the response come from these current rows, not an engine snippet.

There is no periodic queue scan, synchronous startup table scan or explicit database/distributed lock in this search path. Transactions still use PostgreSQL's normal internal write locks. Indexing is eventually consistent: newly written or edited messages may be absent until their durable event is processed. Stale revisions are hidden even during that delay.

## Bounds and pagination

- Queries are limited to 500 characters and 2,048 accessible channels. A larger scope returns `search_scope_too_large`; narrow it with a channel filter.
- The API admits at most 16 simultaneous searches per process and two per actor per process; excess requests return `search_busy`.
- Each request reads batches of 50 engine candidates, at most five batches, and returns at most 20 hydrated results. An empty page may still have a continuation when stale candidates consumed the work budget.
- Pagination stops after 5,000 scanned candidates. The browser retains at most 500 results and asks the user to refine the query thereafter.
- Engine requests time out after ten seconds. The UI debounces query changes, aborts superseded requests, ignores late responses and supports explicit retry and load more; it does not poll.

Results sort by creation time descending, immutable `search_order` descending, then revision descending. A cursor binds the actor, workspace, original query and optional channel to the last candidate's creation time/order, a scanned-candidate count and the first request's time cutoff. Each continuation selects keys strictly below the previous candidate rather than skipping an offset, so deleting an earlier result does not skip the next result. It is still not a database or index snapshot: edits, membership changes and delayed indexing can change which messages match or become available during traversal. The UI deduplicates displayed message IDs. Do not treat a search traversal as an export or exhaustive audit.

## Local setup and upgrades

[Compose](../../compose.yaml) pins Typesense **30.2**, stores its data in `typesense_data`, and binds its API to `127.0.0.1:58108`. Host-run processes use the values in [.env.example](../../.env.example):

```dotenv
TYPESENSE_URL=http://127.0.0.1:58108
TYPESENSE_API_KEY=space_local_search
# TYPESENSE_COLLECTION=space_messages_v1
```

Use a private deployment key outside local development. The browser receives no Typesense key and calls only the authenticated Space API. The current configuration has one server-side key for reads and indexing; separate read/write key configuration is not implemented. Without both URL and key, search is disabled and returns `search_unavailable`; supplying only one fails configuration. With no collection override, the API derives a collection name from the database schema's event stream.

From the repository root, export the configured `.env`, build current packages, start Typesense and apply migrations:

```sh
set -a
. ./.env
set +a
pnpm build
docker compose up -d typesense
pnpm migrate
```

Restart the CDC bridge and API using the new build, each in its own terminal with the same environment:

```sh
pnpm events
```

```sh
pnpm server
```

The existing PostgreSQL and NATS services must also be running. Restarting current CDC code matters because search events now use their own Interest-retention stream. The API consumer starts with the API; no separate search-worker command is needed. Engine unavailability produces an explicit search error, not a fallback to loaded browser messages.

## Backfill and recovery

The first configured consumer schedules the initial durable backfill. For an explicit repair or backfill after the updated consumer is running:

```sh
DATABASE_URL='postgres://workplace:local_demo_only@127.0.0.1:55438/workplace' pnpm --filter @space/server search:backfill
```

Substitute the intended database URL and preserve any schema configuration. This command runs built `dist/search-backfill.js`, so build first. It enqueues one `search.backfill` job and exits; the consumer performs the bounded pages of 500 and their durable continuations. Its success message confirms enqueueing, not completed indexing. Repeating the command is safe for revision-based indexing; it may add duplicate work. It is an operator action, not an automatic recurring scan. Run it while the durable search consumer exists: Interest retention discards search work published without a consumer.

Normal outages after activation recover through retained WAL/outbox events and durable JetStream delivery. Deleting the search durable consumer discards its Interest-retained obligations; after recreating it, enqueue an explicit backfill because the activation bit is already set. Keep the CDC bridge, JetStream storage and the API's search consumer healthy; see [realtime deployment and recovery](realtime-deployment.md). Restore engine connectivity to allow retries to complete. Do not delete the PostgreSQL replication slot or broker data to repair search.

An ambiguous timed-out engine write can leave an unreachable old revision after cleanup. PostgreSQL hydration hides it, but it consumes index space and candidate work. Backfilling the same collection is not a guaranteed orphan cleanup. A fresh collection rebuild removes these historical documents.

Collection rebuild and cutover are manual. Choose a new `TYPESENSE_COLLECTION`, configure every API/indexing process consistently, restart them, and enqueue the backfill against the intended database. Searches of that new collection are temporarily partial while it fills. Retire the old collection only after verifying the replacement. There is no automated dual-write, alias cutover or zero-downtime rebuild workflow; any externally managed alias strategy needs separate design and verification.

Typesense is a derived store, but it contains private message text and needs private networking and protected storage. The local single-node Compose service is not an HA deployment. No production capacity, latency, HA or failover claim is established by these bounds or local checks.

## Implementation

- [Search API and durable consumer](../../apps/server/search.ts)
- [Typesense HTTP client and schema](../../apps/server/typesense.ts)
- [Query parser](../../apps/server/search-query.ts)
- [Database hydration and backfill](../../adapters/postgres/search.ts)
- [Browser search dialog](../../apps/web/src/features/search/MessageSearch.tsx)
