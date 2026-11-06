# Personal outbound MCP implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for isolated implementation and review tasks. Preserve the working snapshot and stage only this feature's changes.

**Goal:** Let each Space user connect remote HTTP MCP servers and grant selected tools to their own agents through a separate gateway.

**Architecture:** Space owns personal connection records, encrypted credentials, grants, invocation capabilities and audit data. A separate MCP gateway owns upstream discovery and dispatch; local agents receive invocation-scoped gateway access. Initial authentication supports bearer tokens and unauthenticated upstream servers.

**Tech Stack:** TypeScript, existing MCP SDK 2.4, Fastify, PostgreSQL, React, Node test runner, Vitest.

## Execution

Use the isolated working snapshot at `/Users/kai/.config/superpowers/worktrees/space/personal-outbound-mcp`. The original snapshot is retained beside it for a conflict-aware transfer back to the application checkout. CodeGraph structure is queried from the original indexed project; concrete files in the snapshot can be read directly.

### 1. Contracts and persistence

Files: `packages/contracts/outbound.ts`, contract index exports; `adapters/postgres/outbound.ts`, `outbound-security.ts`, migration `058_personal_outbound_mcp.sql`, migration registry and package exports; `tests/contracts/outbound.test.ts`, `tests/integration/outbound.test.ts`.

- [x] Write and run failing tests for HTTPS endpoint/auth validation, tool limits and credential encryption bound to owner/connection.
- [x] Implement shared types: `OutboundConnection`, `OutboundTool`, `OutboundGrant`, `OutboundAgent`, `OutboundCall`, `OutboundAccess` and validated inputs.
- [x] Write and run failing database tests for user isolation, concurrent connection limits, catalog changes, grants and revision conflicts.
- [x] Implement persistence using parameterized SQL, serializable bounded retries and atomic conditional writes. Keep secrets out of returned records.
- [x] Add signed capabilities bound to owner, installation, execution and audience; revalidate active execution and ownership on every gateway operation.
- [x] Test durable call reservation, duplicate-call rejection and uncertain outcomes without repeating writes.

### 2. Gateway transport and execution

Files: `apps/mcp-gateway/package.json`, `tsconfig.json`, `main.ts`, `gateway.ts`, `remote.ts`, `network.ts`, and colocated tests.

- [x] Write failing tests for blocked network destinations, redirects, bounded reads, discovery pagination and tool-name mapping.
- [x] Implement pinned DNS resolution and HTTPS transport with TLS verification; local server injection exists only in test constructors.
- [x] Connect with the MCP client SDK, initialize, list tools and call tools; close bounded clients after operations. Preserve upstream state for each individual operation.
- [x] Expose the MCP server with permission-filtered discovery and invocation-time grants. Authenticate internal discovery requests separately.
- [x] Bound concurrent work, arguments, catalogs, responses and deadlines; persist dispatch intent and terminal audit metadata. Never retry uncertain tools.
- [x] Exercise the gateway against a real synthetic MCP HTTP server, including two accounts, revocation, malicious destinations, errors and duplicates.

### 3. Personal settings UI and management API

Files: `apps/server/outbound.ts`, API registration/main configuration; `apps/web/src/features/connections/Connections.tsx`, tests/styles; existing `features/profile/UserProfile.tsx` account menu.

API contract (all owner inferred from session):

```text
GET  /v1/me/connections                         -> { items: OutboundConnection[] }
POST /v1/me/connections                         -> OutboundConnection
PATCH /v1/me/connections/:id                    -> OutboundConnection
DELETE /v1/me/connections/:id                   -> { deleted: true }
POST /v1/me/connections/:id/discover            -> OutboundConnection
PUT  /v1/me/connections/:id/grants              -> OutboundConnection
GET  /v1/me/connection-agents                   -> { items: OutboundAgent[] }
GET  /v1/me/connection-calls                    -> { items: OutboundCall[] }
```

- [x] Write failing management API and UI tests before implementation.
- [x] Implement create/edit/delete, discovery, grant selection, status/error handling and recent metadata. Secret updates are write-only; endpoint/auth changes reset grants.
- [x] Reuse the signed-in session and primitives. Load on opening; refresh after mutations and actor-scoped realtime changes, with no recurring fetch.
- [x] Test reconnect/reload persistence, duplicate endpoint accounts, isolation, unavailable gateway and auth errors.

### 4. Agent invocation binding

Files: contracts invocation parser/type; server delivery/capability attachment; connector `outbound-tools.ts` and provider adapters/tests.

```typescript
interface OutboundAccess { url: string; token: string; tools: string[] }
// InvocationRequest.outbound?: OutboundAccess
```

- [x] Write failing synthetic-provider tests demonstrating the current turn gets only its own outbound configuration.
- [x] Issue access only for active executions owned and requested by the connection owner, with at least one tool grant.
- [x] Configure Codex, Kiro and Claude with one gateway endpoint and exact allowed gateway tool names. Keep upstream credentials on the server.
- [x] Clear/replace capabilities at turn boundaries, preserve saved conversation/session identity, and retain existing project-tool behavior and tool activity rendering.
- [x] Test stop, failure, cleanup, stale capabilities and a later turn with different grants.

### 5. Verification and delivery

- [x] Run contract, gateway, persistence/API, provider and UI tests plus affected package builds/typechecks.
- [x] Obtain separate spec compliance and code quality review; resolve identified defects.
- [x] Document environment keys, startup, transport/auth limits and synthetic-versus-live verification in `docs/architecture/outbound-mcp.md`.
- [x] Transfer only the feature delta back to the original checkout with three-way conflict detection against the retained snapshot; preserve unrelated concurrent changes.
- [x] Report verified behavior and any live provider configuration still required. Do not claim production deployment or real-account proof from synthetic tests.

## Verification evidence

Affected builds/typechecks passed. Connector suite: 108 tests; Connections/profile: 17 tests; gateway: 9 tests; focused contract/database/API tests: 13 tests. Database tests use isolated schemas; API event tests use a disposable NATS instance. Installed Codex MCP authentication/filtering was also checked without model inference. Live external accounts and a full browser/CDC deployment remain outside this proof.

Original checkout concurrently changed migration version parsing; preserve that edit during transfer. Its draft specification was removed, so do not restore it. The implementation guide is `docs/architecture/outbound-mcp.md`.
