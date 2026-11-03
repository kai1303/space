# Local Codex connection

Local Codex enrollment shows an owned agent alongside human workspace members.
After the owner explicitly enables it for a channel, the connector can claim
approved `codex.run` tasks and return streamed responses. Pairing grants no channel
access. Repository selection is absent from this chat integration.

## Setup

Apply migrations with `pnpm migrate`, build with `pnpm build`, and run the existing
API, Redis and web app. Open **Members → Connect Local Codex** in chat. Run the
displayed `pnpm connector --url <web-origin> --connect` command from this checkout;
the local machine needs Node 22+ and the Codex CLI on PATH. Enter the code at the
terminal prompt, then open the connector's Continue with ChatGPT URL yourself.
Keep the connector running. Subsequent `pnpm connector` starts reuse the saved pairing.

The connector's [guide](../../apps/connector/README.md) documents local credential
storage, login/logout, lock recovery and the OSS versus hosted-service boundary.
Personal ChatGPT authorization remains local; Space never receives OpenAI tokens.

## Connection sequence

```mermaid
sequenceDiagram
  participant User as Workspace member
  participant API as Space API
  participant Local as Local connector
  participant Codex as Codex App Server
  User->>API: Create pairing in current workspace
  API-->>User: Ten-minute code
  User->>Local: Enter pairing code
  Local->>API: Claim with generated connector credential
  API-->>Local: Owned installation identity
  Local->>API: Authenticated Socket.IO /agents connection
  User->>Local: Complete local ChatGPT authorization
  Local->>Codex: initialize / initialized over stdio
  Local->>API: Readiness heartbeat
  API-->>User: Agent status in Members
```

## Ownership and state

- Pairing requires current workspace membership. A new code cancels
  the same owner's previous unclaimed code in that workspace. The owner can cancel it.
- Claiming is transactional. Space stores SHA-256 hashes of codes and connector
  credentials. Retrying the same code and credential returns the same installation;
  a different credential cannot replay a claimed code.
- An installation has a human owner and a Local Codex definition, with the `codex.run`
  capability and no channel grants. It is not a synthetic human login.
- The separate `/agents` namespace accepts connector credentials only. Human chat
  sockets and HTTP user sessions do not accept them. Heartbeats recheck membership,
  revocation and the current connection generation; stale sockets cannot overwrite
  a replacement connection's status.
- Heartbeats occur every ten seconds; the directory treats a connection older than
  45 seconds as offline. Local auth reports required, ready or error. Ready requires
  OAuth validation and Codex initialization, not proof of successful inference.
- Owner revocation disables the installation and clears its credential. Active
  sockets are rejected on heartbeat or periodic revalidation within ten seconds.
  Workspace offboarding also prevents further authenticated use.
- Transient transport loss and graceful server restart reconnect with bounded
  backoff. A rejected credential requires a fresh pairing.

## Interfaces

| Interface | Purpose |
| --- | --- |
| `POST /v1/workspaces/:id/agent-pairings` | Create code, optional display name |
| `GET /v1/agent-pairings/:id` | Owner reads pending/claimed/expired/cancelled state |
| `POST /v1/agent-pairings/:id/cancel` | Owner cancels unclaimed code |
| `POST /v1/agent-pairings/claim` | Public, rate-limited code exchange |
| `GET /v1/workspaces/:id/participants` | Paginated human and agent directory |
| `POST /v1/agents/connections/:id/revoke` | Owner disconnects installation |
| `/agents`, `agent.heartbeat` | Authenticated readiness updates |
| `GET /v1/channels/:id/local-codex` | Owner's paired agents and channel enablement |
| `POST /v1/agents/connections/:id/channels/:channelId` | Owner enables or disables the channel grant |
| `/agents`, `agent.task.claim/event/renew/finish/fail` | Scoped task delivery and persisted event acknowledgements |

Local task claims exclude every other installation, and ordinary workers exclude
`codex.local`. A current ready socket can hold one 30-second lease, renewed during
a maximum two-minute model turn. Event acceptance rechecks installation, task,
channel access, grant, socket generation, and live lease. Disconnects and expired
leases fail visibly; uncertain claims are never automatically invoked again.
The connector uses an ephemeral tool-free runtime with isolated home and working
directories, and denies unsupported tool or approval requests.

PostgreSQL persists enrollment, status, tasks, events, and responses. Socket.IO carries heartbeats directly;
PostgreSQL is not a message broker. Existing Redis chat distribution is unchanged.

## Verification boundaries

Integration tests cover tenancy, replay/concurrent claims, expiry/cancellation,
hashed storage, no implicit grants, current membership, stale socket fencing and
revocation. Connector tests use synthetic OAuth responses, signing keys, loopback
callbacks, child processes and real Socket.IO connections. UI tests cover polling,
claim/expiry, cancellation, errors and workspace/unmount isolation.

Real ChatGPT authorization, installed Codex 0.146.0 initialization and a completed
model turn were verified on 2026-11-03. The runtime returned the exact smoke-test
response using `gpt-5.6-sol`, with no tool use. Restarting the production connector
reused and refreshed saved authorization, and Space returned to Online.
See [real Codex E2E evidence](../real-codex-e2e-qa.md). That historical prompt test used the
connector's runtime directly. The chat dispatch path is covered separately by
`tests/integration/local-codex.test.ts` and connector task tests; real browser
verification must be recorded separately from these synthetic checks.
