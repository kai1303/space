# Opt-in agent integrations and memory implementation plan

**Goal:** Make agent enrollment/session grants capability-based and channel-memory access explicit per installation.
**Architecture:** Extend the existing contracts, registry injection, authorization stores and provider interface. Keep delivery event-driven and default permissions empty.
**Tech stack:** TypeScript, Fastify, PostgreSQL/Drizzle, React, Node test runner, Vitest.

- [x] Add regression tests for non-Codex pairing, channel skill grants, persistent sessions, routing and backward-compatible defaults. Run tests and confirm current hard-coded behavior fails.
- [x] Implement trusted paired-connector descriptors, pairing selection, generic channel agent API and capability-based session checks. Update the SQL ready-event routing and claiming consistently. Use bounded serializable retry for touched mutations. Verify backend tests.
- [x] Add memory permission and installation-bound MCP tests, including denial and concurrent revocation/provider I/O. Confirm failures before implementation.
- [x] Add migration/schema for memory grants and bound keys. Add manager settings APIs and live grant checks. Expose contribute-only MCP tools separately from full-write tools.
- [x] Supply bounded channel memory during authorized dispatch through the existing selected provider, with I/O outside transactions and access rechecks. Wire both local API and remote worker paths. Validate invocation context and preserve untrusted-data semantics.
- [x] Update agent selection/session UI and memory access controls with accessible inputs, request failure behavior and scoped tests.
- [x] Run affected integration/UI/connector tests, full build/typecheck, and review changed code for opt-in isolation and concurrency. Document actual behavior and remaining limits.

Work directly on main at the user’s explicit request while preserving the existing working-tree edits. Do not commit or deploy unrelated work. Tasks are implemented in this chat; the accepted review and user request authorize execution.

## Verification results

- Build: 13 tasks successful. Full typecheck: 23 tasks successful; final test-fixture typecheck also passed.
- Shared UI: 104 tests passed. Web: 257 tests passed. Connector: 66 tests passed. Server: 29 tests passed.
- Memory and MCP integration: 15 tests passed, including permission revocation during provider reads, no writes after revoked evidence retrieval, and concurrency bounds.
- Generic connector integration includes trusted registration, explicit skills, sessions, routing, and concurrent stale-pairing definition protection. Final targeted connector/connection/local-runtime API checks: 21 tests passed.
- Broad backend run had 251 passing tests plus failures from omitted TEST_REDIS_URL, stale historical migration fixtures, and a WAL delivery timeout. Corrected the test environment and historical fixtures. Reran all failed suites serially: 60/61 passed, with one further historical unread fixture mismatch. Corrected that fixture and reran its complete suite: 7/7 passed. No backend failures remain from that run; a second full monorepo run was not performed.
- Spec and code-quality reviews completed. Working tree remains on main, uncommitted. No live connector invocation, production load test, deployment, or running-database migration was performed.
