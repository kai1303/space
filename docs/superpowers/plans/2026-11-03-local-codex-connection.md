# Local Codex Connection Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the isolated connector task; root integrates the server and UI and reviews the result.

**Goal:** A workspace member pairs a local Codex connector, authorizes ChatGPT locally, and sees the agent in the workspace member directory without choosing repositories or channels.

**Architecture:** Browser-created, ten-minute, single-use pairing codes bind an owned installation to a connector-generated secret. PostgreSQL stores hashes only. A separate Socket.IO `/agents` namespace carries authenticated status heartbeats; no task dispatch or channel access is implicitly granted. A local TypeScript connector stores credentials privately, implements the documented Sign in with ChatGPT OSS flow, and verifies the installed Codex App Server handshake over stdio without starting an inference turn.

**Tech Stack:** Existing Fastify, Drizzle/PostgreSQL, Socket.IO, React/UI. Connector uses Node, socket.io-client and jose for OIDC verification.

## Scope and contracts

- POST `/v1/workspaces/:workspaceId/agent-pairings` body `{name?}` → `{id,code,expires_at}`. Default name comes from owner's display name. Authenticated active workspace membership required. New pairing replaces the owner's earlier unclaimed pairing in this workspace.
- POST `/v1/agent-pairings/claim` body `{code,credential}` → `{installation_id,workspace_id}`. Credential is 32 random bytes in base64url (43 chars), generated and saved locally before claim. Code is 24 random bytes in base64url (32 chars). Same-code/same-credential retry returns the same installation; other reuse fails. Expired and invalid codes fail identically.
- POST `/v1/agent-pairings/:id/cancel` body `{}`: owner only; cancels an unclaimed pairing.
- GET `/v1/workspaces/:workspaceId/participants` → `{items:[{id,kind:'human'|'agent',name,owner_id?,status?,auth_status?}]}`. Active human members and non-revoked connected-agent identities share the directory. Agent status is online only when a live connection heartbeat is recent and local auth reports ready.
- POST `/v1/agents/connections/:installationId/revoke` body `{}`: installation owner only, invalidates credential and connection.
- Socket.IO `/agents`, websocket transport, handshake auth `{token}`. `agent.heartbeat` body `{auth_status:'required'|'ready'|'error'}` with `{data:{installation_id}}` or `{error}` ack. Every heartbeat checks current owner membership, enablement and revocation. Session IDs fence stale connections/disconnects. No OpenAI token, email, repository or message content is sent to Space.
- Agent appearance represents an installation's workspace membership, not a synthetic human account. No channels/grants are created. The existing mock task path remains unchanged and new connections advertise no executable skills until async dispatch is implemented.
- Connector CLI: `pnpm connector --url <origin> --connect`. Prompts for a code if omitted; subsequent starts reuse saved connection. `--login` reauthorizes local ChatGPT; `--logout` clears local OpenAI credentials. Default credential directory `~/.config/space-connector`, 0700 directory/0600 atomic files. Never print credentials. HTTPS required except loopback development.
- ChatGPT auth uses official dynamic OSS registration, PKCE/state/nonce, JWKS signature/issuer/audience/expiry checks and granted plan-usage scope. Tokens remain local. No browser automation of user login. Documentation distinguishes local/OSS from hosted-service onboarding requirements.

## Tasks

- [x] Write pairing/namespace integration tests first: foreign workspace denial, one-time and same-credential retry, expiry, cancellation, owner-only revocation, hashed storage, no grants/channels, shared member listing, current membership checks, namespace separation, stale connection fencing.
- [x] Add migration 008, Drizzle mappings, `AgentConnectionStore`, routes and namespace. Use existing parent/workspace locks for pairing/offboarding serialization; install definition and installation in the claim transaction. Hash and bound secrets at the boundary.
- [x] Implement connector package with tests for OAuth validation, private persistence, server URL validation, claim/reconnect, Codex initialize handshake, failure/offline behavior and cleanup. No inference or personal login performed automatically by the coding agent.
- [x] Add shared member dialog and Connect Local Codex form to chat using existing UI components. Show code/expiry and connector command, then poll member state; clear timers on close/workspace change. Display human/agent identities together, auth-required/offline/online states, owner revoke, errors and retry. No repository/channel fields.
- [x] Test UI onboarding, expired/cancelled requests, member statuses, cross-workspace reset and failure handling.
- [x] Run targeted suites, full backend/UI tests, typecheck/build, and browser-check desktop/mobile. Use a fixture connector for network proof; verify real Codex handshake without requesting model work or account changes.
- [x] Document setup, scope, account boundary, revocation, and remaining task execution work. Reconcile relevant backlog entry. Leave existing untracked work intact; do not bulk stage or commit the repository.

## Acceptance

A registered user can create a code in their current workspace; an independently running connector claims it and appears as an agent member; auth state and disconnect/reconnect are visible; revocation blocks reconnect. No repo/channel selection occurs. Account credentials never reach Space. Tests demonstrate access isolation and replay behavior. Live personal-account sign-in remains user-operated and must not be claimed verified by synthetic tests.

## Verification result — 2026-11-03

- Final `pnpm typecheck`, `pnpm build` and `pnpm test` succeeded: 197 tests across backend, storage, connector, UI and web.
- Real local API/Vite browser check: create pairing, claim using an independent fixture process, authenticated agent socket, sign-in-required directory entry, owner revoke and server rejection. Smoke-test installations were revoked afterward.
- Desktop and 390×844 mobile member dialog checked; mobile document width remained 390px with no horizontal overflow.
- Installed Codex 0.146.0 initialize/initialized handshake passed without login or inference.
- Spec and quality reviews passed after fixing repeat pairing, graceful server reconnect, and stale pairing success after revocation.
- Initial implementation checks did not perform personal OAuth or inference. A subsequent user-authorized live run verified both; see `docs/real-codex-e2e-qa.md`.
- Migration 009 and asset changes from concurrent work were preserved; migration/history tests pass with both features. No bulk staging or commit.
