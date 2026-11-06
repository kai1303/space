# Agent-native workplace: module roadmap

Updated: 2026-11-06
Status: Current implementation and next delivery slices. The original S-series
below records the foundation sequence; it is not a list of remaining work.
[Small-module backlog](../plans/module-backlog.md), W01–W34, retains the original
work breakdown. Current feature boundaries and follow-up priorities are listed here.

## How we will work

Choose one small delivery slice at a time. Before coding it, define its inputs, outputs,
permission rules and acceptance tests. Finish and demonstrate that slice before opening
the next. Keep unresolved product decisions explicit. A module is a code ownership
boundary; it does not automatically need a package, service or deployable.

Space now has a modular API, asynchronous worker, event bridge, React web app,
macOS shell, local agent connectors, and a separate outbound MCP gateway.
Contracts, authorization, persistence, audit records and tests grow with each slice.
Do not pre-create all folders, abstract interfaces or database tables in the handoff.

## Modules

| ID | Module | Owns | Does not own | Depends on |
| --- | --- | --- | --- | --- |
| M01 | Workspace and access | Human identity, workspace/channel membership, deterministic access checks | Intent detection, agent execution | Versioned identity contracts |
| M02 | Conversations | Channels, threads, messages and authorized history | Task state, external agent calls | M01 |
| M03 | Agent registry | Agent definitions, owned installations, capabilities, connection status, scoped grants and revocation | Executing tasks, granting itself authority | M01 |
| M04 | Tasks and approvals | Task/session/execution records, approval decisions, lifecycle, event log, outbox and recovery | Model inference, transport details | M01, M02 origin reference, M03 grants |
| M05 | Agent gateway | Connector registration, invocation, authenticated event normalization, delivery receipts | Deciding whether someone has authorized work | M03, M04 contracts |
| M06 | Human controls | Authorized steer/follow-up/cancel commands, target execution/version, receipt lifecycle | Claiming unsupported actions succeeded | M01, M04, M05 |
| M07 | Navigator | Scoped observation, filtering, capability matching, task proposals, configurable rules/providers and evaluation | Approval, credentials, direct execution | M01–M05 |
| M08 | Workplace interface | Conversation view, onboarding, agent directory, task cards/activity, controls and settings | Duplicating backend authorization or lifecycle logic | Relevant APIs from M01–M07 |
| M09 | Personal outbound integrations | Personal connection configuration, encrypted credentials, catalogs, exact tool grants, scoped gateway access and call metadata | Inbound events, shared workspace credentials, provider login or integration-specific APIs | M01, M03, M04, M05 |
| M10 | Channel huddles | Authorized room lifecycle, media access, participant controls and discovery | Transporting media through chat or storing recordings | M01, M02, event delivery, optional LiveKit |

Shared contracts are introduced when a module needs them. Event envelopes, errors,
IDs and schemas are shared; provider SDK types stay inside adapters. Operational work
(migrations, deployment, observability, security and documentation) is included in each
module's completion criteria rather than deferred into one final hardening project.

## Dependency graph

Arrows mean "requires an interface from"; this is not a network deployment diagram.

```text
Conversations --------> Workspace/access
Agent registry -------> Workspace/access
Tasks/approvals ------> Workspace/access + conversation origin + registry grants
Agent gateway --------> Registry + task/execution contracts
Human controls -------> Workspace/access + tasks + gateway
Navigator ------------> Authorized conversation events + registry + task proposal API
Workplace interface --> APIs for whichever feature is being delivered
```

Tasks and gateway communicate through ports: tasks authorize and enqueue dispatch;
the gateway emits execution events; the task engine alone persists lifecycle changes.
Neither module imports a concrete runtime SDK.

## Small delivery slices

These are sequential demonstrable increments, not a demand to finish every module
before seeing anything work. Seeded identity/thread/installation fixtures are allowed
only in the first mock slice and must remain clearly labeled.

### S01 — Define the task and connector contracts

Scope: M04/M05 boundary only.

- Define Task, Session and Execution separately.
- Define bounded invocation and normalized agent event payloads.
- Define supported capability/control declarations and versioning rules.
- Write contract and invalid-transition tests.

Done: a connector author can understand the invocation/event interface without a
Codex, framework, model provider or database dependency. Contracts are provisional
until tested against independent local and cloud runtimes.

### S02 — Persist a proposed task

Scope: M04 with seeded M01/M02/M03 fixtures.

- Save a task against one explicitly authorized thread and installation.
- Append a proposal event in the same transaction.
- Read it back using deterministic workspace/channel access checks.
- Support request idempotency and reject conflicting reuse of a key.

Done: the proposal survives a new application/database connection; unauthorized reads
and writes fail. No agent is invoked.

### S03 — Approve and queue work

Scope: M04 policy and outbox.

- Permit only the current installation owner with channel access to approve for now.
- Atomically create approval audit, session, execution and outbox record.
- Reject a proposal without creating an execution.
- Serialize concurrent approval and keep grant revocation effective before dispatch.

Done: an unapproved/rejected task cannot dispatch, and concurrent approvals produce
one execution. Collaborator approval policy is a separate future decision.

### S04 — Invoke the mock and return a result (historical foundation slice)

Scope: M05 mock adapter plus M04 event ingestion.

- Admit an exact durable delivery attempt; do not introduce a renewable ownership lease.
- Invoke the mock through the common connector interface.
- Validate installation identity, event IDs, execution sequence and lifecycle.
- Save progress and completion; insert one result reply in the originating thread.
- Bound discovery/invocation time, retries and dead-letter behavior.

Done: the CLI shows proposal → owner approval → progress → result. Deadline and
completion-before-acknowledgment recovery must not replay uncertain provider work
or produce duplicate replies.
This is the first end-to-end milestone; no full chat UI or paid API is needed.

### S05 — Replace seeded workspace access

Scope: M01.

Add real user authentication and workspace/channel membership management with tests
for private-channel and cross-workspace isolation. Choose an authentication approach
before implementation. Done: real users can establish the scopes used by S02–S04.

### S06 — Add minimal conversations

Scope: M02.

Create channels/threads, post human messages and read scoped history. Add authorized
realtime delivery separately once durable messages work. Done: the task result can
appear alongside actual conversation messages in its original thread.

### S07 — Register and revoke an owned agent

Scope: M03.

Replace seeded installations with operator/user onboarding, ownership verification,
credential references and channel/skill grants. Done: revoked or out-of-scope agents
cannot receive new work. Endpoint and transport-specific verification belongs with
the corresponding adapter; pasting a URL does not prove ownership.

### S08 — Add one independent cloud connector

Scope: M05, one transport only.

Choose a custom HTTPS webhook or actual A2A after a focused protocol spike. Add
credential verification, replay defense, endpoint/SSRF protections and asynchronous
progress/completion. Reuse S01–S04 conformance tests. Done: core task/policy code is
unchanged. A custom HTTP API must never be labeled A2A.

### S09 — Add an outbound local connector

Scope: M05, then a Codex-specific adapter.

First establish authenticated outbound connection/reconnect and cursor recovery.
Then connect a supported Codex programmatic runtime after checking official schemas.
Done: local invocation works without an inbound public port and passes the same
applicable conformance tests as the cloud agent.

### S10 — Add one human control at a time

Scope: M06.

Separate tasks: capability negotiation, queued follow-up, cancellation and native
active steering. Each needs authorization, execution/version targeting, persisted
receipts and tests. Done per operation: unsupported behavior is explicit; delivered
and applied are distinct; a stale command cannot affect another run.

### S11 — Prove rules-only Navigator suggestions

Scope: M07.

Start with off/observe/suggest, authorized thread context, deterministic rules,
capability matching and replay fixtures. Suggestions create proposals only. Add
provider configuration, budgets and optional model adapters in later independent
slices. Done: an unmentioned agent can be suggested from a conversation, while
inference cannot approve or execute the proposal.

### S12 — Add the workplace interface incrementally

Scope: M08.

Deliver separate screens: conversations; agent directory; proposed-task approval;
execution activity/result; supported controls; Navigator settings. Task inspection
can be built earlier against S04 if a visual demo becomes the immediate priority.
Done per screen: use working APIs, show loading/error/empty states and test accessible
interaction. A polished full workspace is not required to validate S04.

## Current implementation snapshot

“Implemented” means present in the application source with development validation;
it does not mean deployed, production-ready, or verified against every real provider.

| Area | Implemented | Remaining boundary |
| --- | --- | --- |
| Workspace and conversations | Accounts, roles, channel/thread chat, DMs, files, notifications, search, Markdown memory and scoped memory MCP | Production operation, remaining access/concurrency migration work and additional collaboration features |
| Agent registry and sessions | Paired Codex/Kiro/Claude, owner-scoped conversation access, approvals, persistent sessions, streamed text/tools, Stop, starred sessions and opt-in project tools | Native shell and interactive tool approvals; wider provider conformance |
| Direct Codex execution | Authenticated immediate handoff for managed sessions, admission limits, saved attempts and no replay of uncertain inference | Production failure/capacity validation; other delivery paths retain their own protocol |
| Navigator | Rules/provider configuration, suggestions, session orchestration and observe mode | Evaluation and production behavior for each configured model; inference does not grant authority |
| Personal outbound MCP | Connections UI, multiple accounts per endpoint, separate gateway, encrypted bearer tokens, discovery, exact tool grants, active-request authorization, revocation and call metadata | Operator setup and real-account validation; OAuth, stdio upstreams and inbound integration are deferred |
| Onboarding and navigation | Focused account/workspace setup, returning-user flow, launch page and workspace navigation | Continued accessibility/device checks and product refinement |
| Channel huddles | Start/join, persistent room panel, audio/video/screen sharing, authorized discovery and durable cleanup | Optional LiveKit configuration, target-network TURN/device validation; no recording/transcripts |

Key implementation guides:

- [Local providers](local-agent-providers.md), [agent sessions](agent-sessions.md), and [direct Codex execution](direct-codex-sessions.md).
- [Personal outbound MCP](outbound-mcp.md): migration 058, separate gateway startup, credential/key handling and current test boundaries.
- [Channel huddles](channel-huddles.md): migration 059, LiveKit configuration and media verification boundaries.
- [Architecture principles and remaining gaps](principles.md): no polling or new explicit/distributed locks; bounded work and durable recovery.

## Next delivery slices

### N01 — Activate and validate outbound MCP v1

- Configure the gateway URL and dedicated encryption/signing key in the API and gateway.
- Apply migrations and run the gateway alongside the API/event services.
- Connect a real HTTPS Streamable HTTP server, discover tools and grant a small tool set.
- Verify each supported agent against actual account permissions, expiry, revocation and failure behavior.

Done: a real account works through Space with recorded evidence for the chosen
provider. Current synthetic database/HTTP/provider tests and the installed Codex
transport check remain development evidence, not that real-account acceptance.

### N02 — Add OAuth connections

Design consent, callback/state validation, token storage, refresh, revocation and
recovery before adding OAuth-only providers. Preserve personal ownership and
explicit tool grants. This is deferred; bearer/no-auth v1 does not imply OAuth support.

### N03 — Revisit inbound connections and personal events/messages

Deferred until outbound use is established. Define webhook/subscription delivery,
sender authentication, deduplication, personal event/message storage, authorization
and durable recovery. Evaluate integration reuse separately; no n8n integration
framework or inbound event service ships with outbound v1.

### N04 — Complete deployment and reliability work

- Replace remaining explicit locks/coordination identified in the principles guide while preserving correctness.
- Validate gateway failure/restart behavior and real provider cleanup; never retry uncertain writes automatically.
- Verify huddles on target networks and physical devices, including TURN and permission flows.
- Provision backups, monitoring, independent failure domains and measured capacity before production claims.

These priorities do not authorize adding scope to an already selected slice.
Choose the next slice explicitly and keep its acceptance evidence separate from
existing foundation tests. The project license and core stack are already selected;
future decisions concern provider consent, deployment boundaries and product behavior.
