# Agent-native workplace: module roadmap

Date: 2026-11-03
Status: Architecture overview. The actionable work breakdown is now
[Small-module backlog](../plans/module-backlog.md), W01–W34.
The product handoff is an epic, not one implementation task.

## How we will work

Choose one small delivery slice at a time. Before coding it, define its inputs, outputs,
permission rules and acceptance tests. Finish and demonstrate that slice before opening
the next. Keep unresolved product decisions explicit. A module is a code ownership
boundary; it does not automatically need a package, service or deployable.

Start with a single modular backend, an asynchronous worker and eventually a web app.
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
| M08 | Workplace interface | Conversation view, agent directory, task cards/activity, controls and settings | Duplicating backend authorization or lifecycle logic | Relevant APIs from M01–M07 |

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

### S04 — Invoke the mock and return a result

Scope: M05 mock adapter plus M04 event ingestion.

- Claim a durable delivery with a lease.
- Invoke the mock through the common connector interface.
- Validate installation identity, event IDs, execution sequence and lifecycle.
- Save progress and completion; insert one result reply in the originating thread.
- Bound discovery/invocation time, retries and dead-letter behavior.

Done: the CLI shows proposal → owner approval → progress → result. Recovery from
an expired lease and completion-before-acknowledgment produces no duplicate reply.
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

The initial workspace was empty. A provisional scaffold now covers S01–S04 with seeded
access/registry/thread records, PostgreSQL, mock worker and a small HTTP API. The last
verification ran 13 passing tests plus TypeScript typecheck/build. This is limited
local evidence, not production readiness or proof of real-agent interoperability.

The live CLI/Compose demonstration, contributor documentation and final review are
still unfinished. S01–S04 are therefore **in progress**, not a completed milestone.
No implementation of S05–S12 should be inferred from the seeded tables or contracts.
The owner requested module decomposition before further feature expansion.

## Decisions to resolve at the appropriate slice

- Before public distribution: license, project naming and contribution/governance policy.
- Before S05/S06: authentication and native versus existing chat backend.
- Before S07/S08: secret storage, ownership verification and third-party consent/retention.
- Before S08/S09: actual protocol/runtime versions, async receipt semantics and isolation.
- Before S10: who can control another owner's agent and cancellation guarantees.
- Before S11: Navigator configuration ownership, languages and evaluation targets.

The S-series above describes milestone outcomes, not individual work items.
Use the W-series in the small-module backlog for task selection. Recommended next
module after the completed foundation: W05 task proposals. W01–W04 are now
implemented and locally verified; see `foundation.md` and ADR 0002. Other modules
remain unselected. The earlier implementation snapshot above describes the initial
scaffold, before foundation completion.
