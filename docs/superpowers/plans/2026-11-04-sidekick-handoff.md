# Private agent handoff implementation plan

**Goal:** Select messages or a whole thread and discuss a saved copy privately with an owned connected agent.

**Architecture:** Reuse managed agent sessions, anchored to a new thread in the user's self-DM. Ordinary DM agent grants remain forbidden. An explicit sidekick session authorizes only its owner's selected installation, with a bounded, immutable context snapshot. No source-channel subscription or grant is added. Existing session delivery, retries, stop/end controls and realtime subscriptions remain in use.

**Tech stack:** React, TypeScript, Fastify, PostgreSQL/Drizzle, existing Socket.IO delivery.

- [x] Add contract and integration tests for input bounds, chronological snapshots, whole threads, privacy, retry identity and delivery context.
- [x] Add a nullable snapshot and request hash to agent sessions; validate and capture source messages server-side in a serializable transaction. Reuse the self-DM or create it atomically. List the owner's handoffs with bounded pagination.
- [x] Add narrow task authorization for owned sidekick sessions, keeping ordinary DM grants forbidden. Include the snapshot in invocation context and validate it in the connector contract.
- [x] Add message selection and whole-thread actions. Add a private sidekick panel with agent selection, a separate selected-message section, existing session conversation and a list for reopening saved discussions.
- [x] Add frontend tests for handoff submission, retries, selection, empty agent lists and revocation. Run targeted integration/UI tests, typecheck and build.

## Product choices

Use the only eligible agent automatically; show a picker when more than one is available. Each handoff starts a new session. Creating it does not execute work: the user first writes to the agent in the session composer. Selected source text is quoted context, not authorization to act. Attachments are identified by name only; no files or access grants are copied. Capture at most 50 messages and 24,000 UTF-8 bytes of snapshot JSON; larger threads return an explicit error asking the user to select fewer messages. Captured context remains a private copy when the source changes; later replies are not included automatically. Session history can be reopened from My sidekick. Publication back to the channel remains an explicit user action using the existing composer.

## Validation

Agent sessions reuse the DM conversation heading, date separators, message rendering and fixed composer. Session details, agent activity and approval controls remain available, and selected messages render as normal message rows in a separate section at the start of the scrollable conversation. Triggering Sidekick creates and opens the session immediately when exactly one eligible agent/skill is available; multiple choices require the picker. A failed create waits for an explicit retry with the same request identity.

Integration tests must prove other participants cannot read/send/control/subscribe to the private conversation or its tasks, normal DM tasks remain forbidden, concurrent duplicate creates return one session, source access and agent ownership are checked, and source edits/later replies cannot alter delivered context. Frontend tests cover selection and the connected-agent handoff. Existing agent-session tests protect stop/end and realtime behavior.

## Verification record

Targeted contract/integration tests passed, including cross-user HTTP and realtime denial, immutable captured context, task invocation parsing, concurrent retries, input limits and ownership. Existing managed-session integration tests and chat/session frontend suites also passed during implementation. Migration 052 was applied to the local database. The local API was restarted with its existing command after confirming there were no running or queued tasks. Browser inspection verified message selection and the connected-agent picker; it did not invoke the user’s real agent.

### Workspace session sidebar

- Add a collapsible Agent sessions group immediately after Direct messages. Use the existing sidebar rows, filtering, selection and keyboard navigation.
- List managed sessions in the current workspace whose backing channel the viewer can access, including their own private Sidekick handoffs. The API returns twenty newest-created sessions per page with an authorized cursor; older pages replace the current page to bound the sidebar.
- Reuse AgentSessions for opening conversations and the existing per-session draft/attempt storage. Keep preview/files/changes and access-loss cleanup.
- Session creation, title/state changes and deletion enqueue durable workspace invalidation. Streamed turns retain thread-scoped delivery. No timer-based fetching.
- Checked the session composer wrapper: its computed background is transparent, and it shares the conversation surface. No composer background change was needed.
