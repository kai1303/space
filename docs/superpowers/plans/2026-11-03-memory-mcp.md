# Memory MCP implementation plan

> **For agentic workers:** Execute inline. The user requested this MCP extension.
> Preserve unrelated concurrent work and do not commit the user's unborn repository.

**Goal:** Agents and Navigator can read context and persist extracted knowledge
through a standard, authenticated MCP connection using any registered memory provider.

**Architecture:** Shared provider registry for UI and MCP; channel-scoped token store
reuses current PostgreSQL authorization/locking. Official MCP stateless HTTP SDK
exposes six tools. Human UI manages named keys and provides connection configuration.

**Tech Stack:** Existing Fastify/Drizzle/React plus official MCP TypeScript v2 SDK.

- [x] Write real HTTP MCP acceptance tests first; verify failure on missing key routes.
- [x] Add validated MCP key/knowledge contracts and migration 012; add locked token
  creation/list/revoke/auth operations to MemoryStore with per-channel key limits.
- [x] Extract the shared provider registry; implement six MCP tools and strict
  key-only endpoint authentication, Origin/Host validation and bounded input/output.
- [x] Add source-backed knowledge sections, stable retry conflict handling, and
  live permission checks on every tool call, including clients kept open across changes.
- [x] Test then implement a separate `MemoryConnections` UI inside the Memory panel.
- [x] Document the tools, generic client config, revocation, provider reuse and
  agent-vs-server extraction boundary; update migration fixtures.
- [x] Run focused checks, full tests/typecheck/build, review, migrate local API and
  verify live readiness. Record results and limitations.
