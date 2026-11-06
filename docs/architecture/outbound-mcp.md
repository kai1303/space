# Personal outbound MCP connections

Users open **Connections** from their personal account menu, add an MCP endpoint, test it to discover tools, and choose tools for each of their own paired Codex, Kiro, or Claude agents. Unpaired and worker-delivered integrations are not offered in this release. Connections can share an endpoint while storing different account credentials. No tool is granted automatically.

V1 supports Streamable HTTP at public HTTPS endpoints with a bearer token or no authentication. OAuth, local stdio upstreams, legacy SSE-only endpoints, inbound integrations, and provider-specific connectors are deferred. Endpoint URLs cannot contain credentials, query strings, or fragments.

## Running the gateway

The API and gateway share PostgreSQL and a dedicated secret. Apply migrations using the normal `pnpm migrate` workflow before starting either service. Set these variables in both processes:

```text
DATABASE_URL=postgresql://...
OUTBOUND_MCP_KEY=<64 hexadecimal characters from openssl rand -hex 32>
OUTBOUND_MCP_URL=https://mcp.example.com/mcp
```

Keep this key in a secret manager and back it up with the database. Losing or replacing it prevents decryption of saved connection tokens; users must re-enter their credentials. Do not reuse a login/session secret. The API is usable without outbound configuration; Connections then reports that the gateway is unavailable. Partial or invalid configuration fails startup.

Build/start the separate service from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm mcp-gateway
```

As with the existing server command, provide environment variables to the process. To load a local `.env` explicitly after building:

```sh
pnpm exec turbo run build --filter=@space/mcp-gateway
node --env-file=.env apps/mcp-gateway/dist/main.js
```

`MCP_HOST` defaults to `127.0.0.1`, `MCP_PORT` to `3001`. Local development can use `OUTBOUND_MCP_URL=http://127.0.0.1:3001/mcp`; production requires HTTPS. Route the public host to the gateway, preserve the Host header, and configure only the actual TLS proxy addresses in `TRUSTED_PROXY_CIDRS`. The server checks HTTPS and the configured host. Browser origins are rejected. The API must also reach the configured gateway URL for authenticated `/internal/discover` requests.

The gateway keeps one PostgreSQL LISTEN connection for permission-change events. Losing that connection aborts active operations and fails subsequent requests closed; restart the gateway to restore service. Run it under the same supervised restart/health monitoring policy as other services. It does not scan tables or poll for changes.

## Authorization and lifecycle

Management APIs derive the owner from the signed-in session. A gateway capability lasts 150 seconds and binds the owner, agent installation, execution and audience. The connector's invocation deadline is 120 seconds. Every gateway list/call rechecks the current execution, requester, agent ownership, workspace/channel membership, connector state, enabled connection and exact tool grant. Another user's request through the owner's agent cannot use these personal connections.

Upstream credentials are encrypted with AES-256-GCM and identity-bound associated data. They never go to the connector or management responses. Endpoint/token changes discard the catalog and grants. Rediscovery removes grants for removed or changed definitions. Gateway tool aliases include a hash of connection/tool identity and fit provider naming limits.

Each remote operation owns its MCP client, session, pinned network connection and deadline. Normal cleanup sends a best-effort session DELETE; cancellation closes local transports. Codex, Kiro and Claude receive the current turn's gateway access, preserve native conversation identity, and discard that access afterward. No capabilities are saved in provider configuration files.

Permission changes trigger revalidation of active work. Revocation aborts local upstream requests where possible and discards unauthorized results. Cancellation cannot undo a remote side effect already performed.

## Bounds and failure handling

- 20 connections per user; 100 tools and 256 KiB per catalog.
- Four concurrent calls per owner; 32 active upstream operations per gateway process. Overload is rejected.
- 256 KiB argument bodies; 1 MiB cumulative upstream response bytes; 30-second operations.
- Schema validation runs in a worker with memory/CPU bounds. Remote schema references do not fetch data.
- DNS answers must all be public addresses. The selected address is pinned for the operation while TLS hostname verification remains enabled. Redirects are rejected.
- Dispatch intent and a request fingerprint are recorded before network calls. Reusing an execution/request ID never repeats a dispatched operation. Unknown outcomes remain **uncertain**, including after a gateway restart.
- Audits contain names, status, duration and timestamps, without arguments/results/tokens. The API pages 100 records at a time using `?before=<next_cursor>`. Completion prunes records beyond 1,000 only after their capability/replay window and execution have ended.

The UI loads initially, after mutations, and on actor-scoped realtime invalidation/reconnect. No health or resource polling was added. A displayed connection status is the last observed discovery outcome.

## Verification boundary

Tests exercise real PostgreSQL and synthetic MCP HTTP servers, owner isolation, account separation, optimistic concurrency, encrypted credentials, duplicate reservation, revocation/cancellation, argument bounds and provider lifecycle. UI behavior is covered by component tests. Installed Codex was also exercised against a synthetic gateway without model inference. Real third-party account behavior and Kiro/Claude live outbound calls require configured accounts and remain separate from this evidence. No service has been deployed by this change.
