# Thread Working Memory Implementation Plan

**Goal:** Give agents permission-checked short-term thread context through MCP and the same context during invocation/navigation.

**Architecture:** Keep conversations authoritative. Build bounded root/recent-message snapshots, optionally augmented by agent-written Markdown memories with source IDs and sequence watermarks. Thread-scoped MCP keys are separate grants on the existing transport and do not enable channel memory.

**Tech stack:** TypeScript, PostgreSQL, Drizzle, Fastify, existing MCP SDK.

- [x] Add real MCP integration tests for memory-off thread grants, original request preservation, paginated evidence, memory revision conflicts, isolation, read-only grants and revocation. Run to observe missing-route failure.
- [x] Add migration 026 for thread-scoped connections and revisioned memories; retain existing channel-key behavior.
- [x] Add shared thread-context reader and memory writer with bounded fields, same-thread evidence validation, sequence snapshots and optimistic concurrency.
- [x] Register human context/grant routes and thread-only MCP tools on `/mcp/memory`. Keep channel tools unavailable to thread keys.
- [x] Include working memory in agent invocation and Navigator without changing the target pending message; preserve strict contract validation.
- [x] Build affected packages; run MCP, Navigator, invocation contract and delivery tests. Review changes and document use and limitations.

Integration command: `TEST_DATABASE_URL=postgres://workplace:local_demo_only@127.0.0.1:55438/workplace pnpm --filter @space/tests exec tsx --test integration/memory-mcp.test.ts`.

Do not commit or push this feature as part of implementation; preserve concurrent workspace edits.

Verification: typecheck (19 tasks) and build (11 tasks) passed. All 551 tests passed across package checks (215 backend/contracts, 178 web, 93 UI, 36 connector, 29 server). UI test runs used `NODE_OPTIONS=--no-experimental-webstorage` to avoid the Node 25 global localStorage conflict. The backend suite was rerun after updating the v17 preservation fixture for defaulted reactions/storage fields. Migration 26 applied to the local development database. Scoped independent review found one Unicode boundary issue; its failing regression test and fix are included, and review confirmed no remaining findings.
