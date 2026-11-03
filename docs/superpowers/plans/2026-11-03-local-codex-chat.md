# Local Codex chat implementation plan

**Goal:** Allow a paired Local Codex to answer approved tasks in a channel through Space.

**Architecture:** Reuse the existing agent namespace, task approval, delivery queue, event validation, and response UI. The connector pulls only its installation's jobs and renews a bounded lease. Explicit owner channel enablement grants `codex.run`; pairing alone grants nothing.

**Tech stack:** TypeScript, PostgreSQL/Drizzle, Socket.IO, Codex App Server, React, node:test, Vitest.

- [x] Add regression coverage proving local work is excluded from ordinary workers, channel grants are required, and only an authenticated current connector can claim and publish its task events.
- [x] Add a `codex.run` capability migration and owner-authorized channel enablement. Keep pairing and channel access separate.
- [x] Add local-only delivery claims, renewable leases, generation fencing, persisted acknowledgements, bounded duration, and failure on disconnect or uncertain started execution rather than rerunning it.
- [x] Extend the stdio runtime with correlated JSON-RPC requests, text notifications, terminal status, cancellation, and safe denial of unsupported approvals. Use an isolated read-only environment with no repository selection.
- [x] Have the connector poll approved work, stream bounded response snapshots, renew its lease, and abort on disconnect/revocation/runtime failure.
- [x] Add channel enablement in the existing agent request panel; show the paired agent's name and preserve existing owner approval.
- [x] Run connector/runtime, store/socket, task-flow and UI regression tests, build/typecheck changed packages, then restart the local services and run a real browser task to completion.

Validation is test-first for each nontrivial boundary. Preserve unrelated pending emoji and CI edits. Do not commit, push, or deploy this work.

## Verification result

Completed 2026-11-03. Relevant server/store/task-flow/Navigator/AG-UI tests: 51 passed. Connector tests: 36 passed. Agent request, members, and chat UI tests: 39 passed. Workspace typecheck and changed backend package builds passed; frontend production build passed with existing dependency/bundle warnings. `git diff --check` passed.

Live browser verification in `kai-test`, channel `hi`: enabled the paired agent, sent `@kai-s-codex Reply with exactly SPACE_AGENT_OK. Do not use tools.`, and observed a real Local Codex response. A second message asked what token it had just returned without supplying the token; the agent replied correctly. Both executions persisted as completed and both outbox entries are done. The screenshot is stored with this chat's visualization artifacts. API, worker, and connector remain running.

Review found and closed two connector lifecycle races with test-first regressions: claims before acknowledged readiness, and queued renewals following terminal persistence. No commits or pushes were made.
