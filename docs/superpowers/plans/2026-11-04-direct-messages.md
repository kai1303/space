# Direct Messages Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development for the bounded backend task and independent review. The user approved the design in `docs/architecture/slack-direct-messages-research.md` by asking to build it.

**Goal:** Ship same-workspace one-to-one and self-DMs with a Slack-grounded recipient flow, durable messaging, unread state, and hide/reopen.

**Architecture:** Retain channels as the existing transport identity; add a direct conversation kind and canonical participant pair, with participant-only access and per-user hidden state. Reuse existing messages, threads, files, unread subscriptions, and resource-update events. No new polling or explicit/distributed locks.

**Tech Stack:** React, TypeScript, Fastify, PostgreSQL, Drizzle, Socket.IO and the existing event service.

The existing dirty working tree includes dependencies for this feature and concurrent unrelated work. Preserve those changes, edit narrowly, and do not commit or push unrelated files.

- [x] Trace Slack's inbox → new message → recipient → existing history → conversation controls without sending messages. Extend the research note with observed transitions and remaining unknowns.
- [x] Add backend tests first for reciprocal concurrent opens, self-DMs, tenant/nonparticipant access, blocked channel membership mutations, send retries, hide/reopen, incoming-message restoration, and unread delivery.
- [x] Implement migration 039 (or next unused number), contracts, store and API. Proposed contract: `GET /v1/workspaces/:workspaceId/direct-messages?after=&limit=&q=`; `POST` same path with `{user_id}` opens/resumes; `PATCH /v1/channels/:channelId/direct-message` with `{hidden:boolean}`. Returns `DirectMessageSummary extends ChannelSummary` with `kind:'direct'`, `participants`, `hidden`, and `last_message`. Participant search uses bounded `GET /v1/workspaces/:workspaceId/direct-message-people?q=`. Channel summaries include optional `kind` for backward-compatible fixtures. DM `name` is viewer-relative, with `(you)` for self.
- [x] Add failing UI tests for recipient search, resume, errors, unread filtering, and hide. Implement a dedicated DM inbox and recipient dialog, DMs rail action, and direct sidebar entries. The selected DM renders the existing `ChannelRoom` with DM-specific heading and controls. Do not show channel administration, memory, or agent configuration on a DM.
- [x] Verify real PostgreSQL concurrency and access checks, event-driven updates, existing channel regressions, focused UI tests, typecheck and production build. Use a local browser to exercise the implemented flow if the development environment is available.
- [x] Review spec coverage and code quality independently, fix findings, update docs and report verification limits.

Essential checks: two actors opening each other at once get the same ID; unrelated workspace members cannot discover/read/send/search/download; no caller can add/remove DM participants through channel APIs; closing does not remove membership/history; incoming messages restore inbox visibility; read state remains per-user and monotonic; reconnect recovers events. Group membership/history transfer and external invitations remain separate increments as described in the approved research design.
