# Typesense message search implementation plan

The user approved dedicated Typesense search and requested E2E verification. Implement in the existing working tree, preserving concurrent unrelated changes.

**Goal:** Search all accessible workspace message history and open results in context.

**Architecture:** PostgreSQL remains authoritative. A message trigger assigns a search revision and writes a small transactional `search.message` outbox event. The existing WAL bridge publishes to a durable JetStream consumer. Typesense documents have immutable revision IDs; database hydration rejects stale revisions/deletions and checks membership on every query. Search does not introduce polling or explicit locks.

**Tech stack:** Existing TypeScript/Fastify/React, PostgreSQL, JetStream, Typesense HTTP API.

- [x] Add real-service integration tests for search, isolation, edits/deletes, retry/replay, and backfill; run failing first.
- [x] Add migration, search store, Typesense client, consumer and bounded explicit backfill. Register lifecycle and API; configure self-hosted Typesense.
- [x] Add `GET /v1/workspaces/:workspaceId/search?q=...&channel_id=...&cursor=...`. Response `{items:[{id,channel_id,channel_name,channel_kind,thread_id,text,created_at,author:{id,name},is_reply}],next_cursor:string|null}`. Preserve `in:`, `from:`, `has:link`, `is:thread`; bound queries/pages/candidates and fail closed when unavailable.
- [x] Replace production browser-only search with workspace and channel scoped remote search, accessible loading/error/empty states, cancellation, pagination, and result navigation through existing context APIs. Keep gallery local-search examples working.
- [x] Run browser E2E against real API/PostgreSQL/JetStream/Typesense, plus focused regression tests and build/typecheck.
- [x] Review correctness and document operation, recovery, and measured limitations.

## Concurrency and recovery

Use immutable document IDs derived from message ID and numeric revision. Never let older writes overwrite a newer revision. On reads only return candidates whose revision matches the current DB row and whose actor still has channel and workspace membership. Upsert the current row, purge strictly older revisions, and recheck after writing to clean races. A late timed-out request can leave an unreachable historical document; it remains invisible and a collection rebuild removes it. No exact total/facet counts are exposed. Bound candidate scanning and document the limit.

Register the durable consumer on the dedicated Interest-retention SEARCH stream before activating a durable paginated backfill. Migration installs unconditional invalidation triggers and an initial-backfill marker; it does not scan existing messages into the outbox. The first consumer atomically updates the marker and enqueues a backfill job. Rebuild commands enqueue the same bounded job; the API never performs whole-table scans during requests. Search retries use delayed negative acknowledgements, preserving the original durable obligation.

## E2E acceptance

Create isolated test workspaces/users/channels; send more messages than the loaded history window; find an older message and navigate to it. Find a message in a second accessible channel and a thread reply. Confirm unauthorized private channels/DMs and a separate workspace are absent. Confirm edits remove old matches, deletion/revocation hide results even with a deliberately stale index, and worker restart consumes pending changes. Use real Typesense rather than a mocked search endpoint.

## Verification — 2026-11-04

The exact search-only staged snapshot was exported and installed independently with the frozen lockfile, excluding unrelated concurrent work.

- Full build and typecheck: all 28 tasks passed.
- Chat and search UI regression tests: all 77 passed.
- Search contracts/integration and existing event-stream, chat-outbox and partition regressions: all 17 passed against real services.
- Real Chromium E2E passed against the authenticated API, PostgreSQL, WAL CDC, JetStream and Typesense: older history, cross-channel navigation, thread replies, access isolation, channel scope and pagination.
- Final read-only correctness review found no blockers. Local migration applied; Typesense and restarted API/CDC are running, with 51 existing messages indexed at verification.
- No production capacity or HA validation was performed.
