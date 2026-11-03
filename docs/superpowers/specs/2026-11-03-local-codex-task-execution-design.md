# Local Codex task execution

Status: implemented and locally verified after the user requested the communication fix.

## Outcome

A workspace member can enable their paired Local Codex agent for a channel, request a task through Space's existing agent flow, approve it as the agent owner, and receive a real streamed response and saved final message in the same thread. Existing ChatGPT credentials remain in the connector's local state.

## Approach

Use the existing authenticated `/agents` Socket.IO connection and PostgreSQL task queue. The connector claims approved work for its own installation, invokes Codex App Server, and forwards validated execution events. This avoids an additional HTTP bridge service and reuses task approval, history, response rendering, and reconnect behavior.

Alternatives considered: an AG-UI HTTP bridge could reuse the existing adapter but introduces another local service and still needs longer-running delivery support; replacing the task pipeline would duplicate existing authorization and persistence.

## User flow

1. Reconnect or pair Local Codex through the existing Members flow.
2. The owner explicitly enables the agent for a channel they can access. Pairing alone grants no channel access.
3. Use the existing Ask an agent flow and supported mention routing to create a `codex.run` task.
4. The agent owner approves the task using the existing approval UI.
5. Space displays live assistant text and progress; a successful final response persists in the task's thread. Offline, authorization, timeout, and interrupted execution states are visible failures.

## Server and persistence

- Expose owner-authorized channel enablement for Local Codex, reusing existing grants and membership checks.
- Keep local connector work separate from the ordinary mock/AG-UI worker so one cannot consume the other's jobs.
- Claim work only for the authenticated, enabled installation and current socket generation. Recheck owner membership, channel grant, task approval, and readiness before dispatch.
- Use a renewable execution lease suitable for model turns, with an explicit bounded run duration. Reject stale lease holders, expired claims, cross-installation events, and events after revocation.
- Validate all inputs and output snapshots using the existing contract limits. Serialize event acceptance and acknowledge only persisted events.
- Preserve idempotency through stable execution/event identities. A lost connection must not silently rerun a model turn that may already have started. Interrupted attempts fail visibly; a fresh execution requires a user retry.

## Connector and Codex runtime

- Extend the existing stdio JSON-RPC runtime beyond initialization with request correlation, bounded messages, turn notifications, cancellation, child-exit handling, and cleanup.
- Execute only server-issued, approved `codex.run` tasks. Neither browser input nor task text can choose a local executable, working directory, credential, or server endpoint.
- Run the first version in an isolated connector-managed directory and HOME/CODEX_HOME with a read-only sandbox and tools disabled. The installed Codex 0.146.0 protocol does not support filesystem read-root restrictions; do not claim an OS read-root jail. Do not expose a repository or load arbitrary local tools. Unsupported runtime approval requests are denied and reported rather than hanging.
- Convert assistant deltas and terminal turn status into Space's existing agent-response events. A truncated stream, failed or interrupted turn, and nonterminal process exit cannot count as success.
- Keep one active run per connector initially. Refresh, shutdown, revocation, and loss of an execution lease interrupt active work.
- Preserve the existing OAuth storage, renewal, and account ownership boundaries. The integration uses the connector's ChatGPT authorization, without introducing an API-key setup.

## Scope

This slice delivers real chat task execution. Repository selection, file modification, arbitrary command execution, browser tools, additional model-provider configuration, and mid-run approval UI are separate work. Manually requested tasks receive the entered goal. Existing Navigator mention and subscription tasks receive its bounded authorized thread context of up to 16 messages; the connector does not independently fetch channel history or memory.

## Verification

- Contract and store tests for local-only claiming, grants, owner approval, tenant isolation, lease renewal/expiry, replay, generation fencing, revocation, and terminal state.
- Connector tests using a synthetic App Server for initialization, deltas, completion, cancellation, malformed/oversized messages, unsupported approval requests, process exit, and reconnect without duplicate execution.
- An integration test through the real API/socket/store pipeline, with a synthetic runtime, verifies the response is persisted in the correct thread.
- Relevant UI interaction tests, workspace typecheck, and package builds.
- After implementation, reconnect the saved local connector if its pairing belongs to the running database. If needed, use the normal pairing flow. Verify one explicitly scoped real model turn through Space; report whether real-account execution was possible separately from synthetic checks.

## Current evidence

The initial connector only initialized Codex and reported readiness, and pairing advertised zero executable skills. The implemented local path uses authenticated task transport with a renewable 30-second delivery lease and a two-minute model turn limit, leaving the existing generic worker deadline unchanged. The current workspace pairing was reused. Real browser mention and contextual follow-up both completed on 2026-11-03; see the implementation plan verification result.
