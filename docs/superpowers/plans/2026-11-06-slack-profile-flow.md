# Slack profile flow implementation plan

**Goal:** Use a shared, non-modal right-side profile panel for people and agents, preserving the current conversation and draft.

**Approved design:** The user approved the Slack flow inspected in this chat. Directory cards, message names/avatars, mentions, DM headers and agent headers open the same panel. People show identity, status, local time, contact information and Message. Agent profiles show identity, owner and availability; Message prepares an existing permitted conversation without sending anything. Connection management remains separate. Slackbot-specific reminders are not part of Space's agent model.

**Architecture:** A workspace-scoped feature provider owns one selected profile and renders a Motion SidePanel. A point-read API returns explicit public profile fields after active membership and guest visibility checks. Existing workspace events refresh the open panel; cleanup cancels stale requests. Existing DM and mention workflows handle messaging.

**Tech stack:** React, Motion, shared @space/ui, Fastify, PostgreSQL, Vitest and node:test.

- [x] Add API integration tests for current profile fields, cross-workspace denial, guest visibility, inactive membership, revoked agents and credential exclusion. Run with `pnpm --filter @space/tests exec tsx --test integration/member-profiles.test.ts` using the local test database; expect missing-route failures first.
- [x] Add a discriminated WorkspaceProfile contract and workspace-scoped UserStore point reads. Register `/v1/workspaces/:workspaceId/profiles/:kind/:id`; return 404 when either participant is not authorized. Run integration tests again.
- [x] Add profile panel tests for focus restoration, Escape, switching profiles during pending reads, revocation, retry, Message and agent-owner actions. Implement the provider and panel under `features/profile`, reusing profile styles and SidePanel.
- [x] Wire shared message identity buttons, mention clicks, directory cards, DM/agent headers and member lists. Preserve conversation-details menu actions and existing self-account editing.
- [x] Verify scoped frontend tests, API tests, type checks, production builds and `git diff --check`. Inspect the live browser at desktop and narrow widths. Review the final diff against pre-existing changes.

No deployment or unrelated desktop/chat-layout changes are included. Current dirty files are preserved in the working checkout.

## Verification

- Profile API: 3 integration tests passed against an isolated PostgreSQL schema. The fixture uses production routes without starting the unrelated event broker.
- Frontend: 74 focused feature tests and all 81 Chat integration tests passed. The mention integration test now asserts the shared panel; focus restoration waits for its scheduled animation frame.
- Shared UI: 204 tests passed. Web, server, and integration-test type checks passed; contracts, PostgreSQL adapter, UI, server, and web production builds passed. Vite reports existing large-chunk and Motion module-directive warnings.
- Browser: verified person and agent panels, directory and message entry points, unsent agent mention preparation, and 390px layout. Cleared the verification draft and restored the normal viewport.
- Final diff review and whitespace check passed. Existing desktop and timeline edits remain untouched.
