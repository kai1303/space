# Message history and infinite scrolling

Approved scope: PostgreSQL remains authoritative, with indexed message history and no physical partitioning yet. Retain history indefinitely. Redis and Socket.IO remain the realtime transport.

1. Add immutable per-channel message sequences, backfill existing rows, and index channel/thread history. Preserve message IDs, attachments, author identity, idempotency, and the append-only event log.
2. Add message-table keyset endpoints for channels and threads (50 messages by default, maximum 100). Return chronological pages, older/newer boundaries, and a separate reconnect watermark. Preserve existing event and compatibility endpoints.
3. Load history automatically near either end of a bounded 500-message window. Virtualize variable-height messages, preserve the visible anchor, follow new messages only when at the bottom, and offer a jump to latest. Threads paginate independently.
4. Test pagination boundaries, concurrent sends, authorization, migration, cache eviction, stale requests, live replay, and browser scrolling. Back up the local database before applying the migration. Run typechecks, build, and relevant integration/UI suites.

No agent execution changes, physical partitioning, retention deletion, or broker changes.

## Implementation and verification

- Implemented migration 016 and both message history routes. Spec and quality reviews completed; fixed bootstrap watermark ordering, initial-fetch retry, StrictMode cleanup, and live messages racing a newer-page response.
- Local migration applied after a `pg_dump` backup; all 29 existing messages and 35 event rows retained, every message backfilled. Schema is now version 16.
- Backend suite: 112 passing tests. Web suite: 119 passing tests. Typecheck: 19 successful tasks. Build: 11 successful tasks.
- Browser: seeded 650 messages with variable heights; verified automatic older loading, independent thread paging, roughly 13–19 mounted message rows, cache-window navigation and jump to latest. Sending while reading older history kept the same visible message at exactly 44px; sending at the end left a 0px bottom gap. Browser console had no warnings/errors.
- Final full parallel `pnpm test`: **346 tests passed**, 12 successful Turbo tasks. To make the suite reliable under shared-machine load, both DOM suites now use at most two workers; two long chat journeys have a 15-second whole-test deadline, with their individual assertions unchanged. Earlier runs exposed the existing highlighter timing assertion and five-second journey deadlines; the final complete run passed all of them.
- No production load benchmark or physical partition migration is claimed. Changes remain local and uncommitted.
