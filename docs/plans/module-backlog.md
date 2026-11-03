# Small-module backlog

Date: 2026-11-03
Status: Foundation W01–W04 implemented and locally verified on 2026-11-03.
U01–U04 workspace/user backend is implemented. The current hierarchy is Workspace → Channels; the earlier parent-organization model is superseded.

This is the actionable breakdown of the product handoff. The eight areas in
`../architecture/module-roadmap.md` remain architectural boundaries. The work modules
below are smaller units we can specify, implement, test and review individually.
A work module does not imply a separate package, service, database or deployment.

## Working agreement

- Work on one selected module at a time.
- Before implementation, write its short specification: inputs/outputs, owned state,
  allowed operations, failure behavior, acceptance tests and explicit exclusions.
- Implement only that scope, with a runnable demonstration or focused integration test.
- Review the result and update its status before selecting the next module.
- Introduce abstractions, tables and dependencies only as their module needs them.
- Existing code is provisional input for review, not evidence that a module is complete.

**W01–W04: implemented and locally verified** (see `0002-foundation.md`).
**W05–W34: planned / not accepted as full milestones**. U01–U04 below implement
the selected profile/workspace/member portion of W14 ahead of real login.
Some task-flow code is provisional and is
covered by regression tests, but its milestone has not been completed.

## A. Shared foundation

| ID | Work module | Concrete deliverable | Depends on | Completion check |
| --- | --- | --- | --- | --- |
| W01 | Core contracts | Versioned task, session, execution, invocation and event schemas; capability declarations | — | Valid examples parse; malformed and authority-bearing fields fail; no runtime SDK dependencies |
| W02 | Access checks | Deterministic workspace/channel authorization using seeded principals initially | W01 | Cross-workspace and private-channel access are denied |
| W03 | Agent catalog | Definition and installation records with owner, capabilities and connector type | W01, W02 | Two installations can share a definition while retaining distinct owners and scope |
| W04 | Agent grants | Channel/skill grants, enable/disable and revocation decisions | W02, W03 | Capability claims cannot grant access; revoked installations cannot receive new dispatches |

## B. First task flow

| ID | Work module | Concrete deliverable | Depends on | Completion check |
| --- | --- | --- | --- | --- |
| W05 | Task proposals | Persist and retrieve a proposed task with origin, requester, goal and idempotency key | W01, W02, W04 | Proposal survives restart; repeated key returns the same task; changed content conflicts |
| W06 | Task event history | Append-only, ordered, scoped events and cursor-based reads | W05 | State/event writes are atomic; unauthorized readers see no events |
| W07 | Human approval | Approve/reject a proposal using a deterministic owner policy | W04–W06 | Agent text cannot approve; duplicate approval creates one authorization; rejection prevents dispatch |
| W08 | Sessions and executions | Distinct session mapping and execution-attempt records with guarded transitions | W05–W07 | Execution IDs differ from session/task IDs; terminal or stale runs cannot mutate current state |
| W09 | Durable dispatch | Transactional outbox, worker claims, leases and acknowledgment fencing | W06–W08 | Approved execution and dispatch are committed together; competing workers cannot own the same live lease |
| W10 | Mock agent gateway | Connector interface implementation with discovery, invoke and normalized progress | W01, W04, W08, W09 | Mock runs through the gateway without model keys or runtime-specific core logic |
| W11 | Result delivery | Validate completion and persist one result against the origin thread reference | W06, W08, W10 | Duplicate completion creates one result; wrong installation and invalid sequence are rejected |
| W12 | Recovery and failures | Bounded timeouts/retries, expired-lease recovery and dead letters | W09–W11 | Restart before acknowledgment does not duplicate the result; exhausted delivery visibly fails |

W05 introduces the minimal persistence needed for its own state. W06 extends those
transactions with durable audit events. W07 persists approval only; dispatch becomes
available only when W08/W09 can create the execution and outbox record atomically.
No intermediate module exposes an unsafe partial execution path.

First milestone: **propose → approve → invoke mock → progress → result**, demonstrated
by CLI/API with seeded users, thread and installation. It is complete only after W12
and a live end-to-end check. Full workplace UI is a later milestone.

## C. Real workplace data

The owner selected workspace and user management before agent integration on 2026-11-03.
The current workspace-only model is documented in `../architecture/workspace-users.md`.
Earlier plans `0006-organization-users.md` and `0007-organization-hierarchy.md` are
historical; their parent-organization hierarchy is superseded:

| ID | Work module | Deliverable | Status |
| --- | --- | --- | --- |
| U01 | User profiles | Own profile read/update; operator development-user provisioning | Implemented; locally verified |
| U02 | Workspaces | Independent workspaces with create/list/read/rename | Implemented |
| U03 | Membership roles | Workspace roles, bounded directory, add/change/remove | Implemented |
| U04 | Member offboarding | Workspace removal, preserve history, disable agents, last-owner protection and audit | Implemented |

The initial channel and realtime chat slice is implemented and locally verified; see
`0008-realtime-chat.md`. It covers Socket.IO/Redis, human messages/threads and mock-agent
task activity. This does not complete W13 or the full workplace milestone.

Better Auth email/password login and cookie sessions (initial W13 scope) are now
implemented; see `0009-better-auth.md`. Next: email verification/reset delivery,
invitations, and connected workspace/user management screens.

| ID | Work module | Concrete deliverable | Depends on | Completion check |
| --- | --- | --- | --- | --- |
| W13 | User authentication | Real login/session identity replacing seeded human tokens | W02; authentication decision | Unauthenticated requests fail; revoked/expired sessions stop working |
| W14 | Workspace membership | Workspace/channel creation and membership management | W02, W13 | Membership changes immediately affect allowed reads and actions |
| W15 | Threads and messages | Create threads, post messages and retrieve bounded authorized history | W06, W14 | Two users can discuss an issue and see the task result in its actual origin thread |
| W16 | Live conversation view | Small channel/thread screen with authenticated live updates and reconnect | W13–W15 | Authorized updates appear once; reconnection catches up without leaking private messages |

Choose native chat versus integrating an existing backend before W14/W15. These
modules specify product outcomes; they do not preselect a chat implementation.

## D. Real agent integrations

The initial local Codex enrollment slice is implemented: workspace pairing,
owned credentials, local account authorization, connection status and revocation.
See [connection architecture](../architecture/local-codex-connection.md). Onboarding
does not select repositories or channels. W19/W20 task dispatch and recovery remain
pending; readiness alone does not complete these milestones.

| ID | Work module | Concrete deliverable | Depends on | Completion check |
| --- | --- | --- | --- | --- |
| W17 | Agent onboarding | Connect/disconnect flow, ownership proof and installation credentials; channel membership happens later | W03, W04, W13, W14 | A user can register and revoke an owned agent; a pasted URL alone is insufficient |
| W18 | Cloud webhook connector | One independent HTTPS agent with authenticated async progress/results | W10–W12, W17 | Same task flow works remotely; invalid signatures, replays and unsafe endpoints fail |
| W19 | Outbound local connection | Authenticated local bridge with heartbeat, reconnect and event cursor | W10–W12, W17 | A local mock works behind NAT and resumes after disconnect |
| W20 | Local Codex adapter | Map the verified supported Codex runtime API onto the connector contract | W19 | Local Codex and the cloud agent pass the same applicable task-flow tests |
| W21 | A2A adapter | Discovery and task/event translation for a selected, verified A2A version | W10–W12, W17 | An independent A2A agent works using actual A2A wire types |

W17 first supports a controlled enrollment flow; transport-specific endpoint proof,
credential binding and SSRF protection ship with W18/W19/W21 before those transports
become available. W18/W20 establish local/cloud parity; A2A is a subsequent adapter.
The connector contract must evolve for asynchronous receipts before remote integration.
Do not assume the current mock's synchronous completion contract is sufficient.

## E. Human control

| ID | Work module | Concrete deliverable | Depends on | Completion check |
| --- | --- | --- | --- | --- |
| W22 | Control commands | Authorized command records, execution/version targets and receipt lifecycle | W04, W06, W08, W18 or W20 | Stale or unauthorized commands fail; delivery is distinguished from application |
| W23 | Queued follow-up | Persist and deliver instructions at the next supported checkpoint | W22; one capable adapter | Follow-up is visibly queued and applied to the intended execution/session only |
| W24 | Cancellation | Request cancellation and track confirmed, failed or unsupported outcome | W22; one capable adapter | Gateway acceptance alone never marks the task canceled |
| W25 | Active steering | Mid-execution instructions through one genuinely capable runtime | W22, W20 or another capable adapter | Intended active turn changes; a finished/replaced turn rejects the stale command |

Pause/resume is a later independent module only after a reference runtime can support
and verify it. Control ownership beyond the agent owner must be decided before W22.

## F. Navigator

| ID | Work module | Concrete deliverable | Depends on | Completion check |
| --- | --- | --- | --- | --- |
| W26 | Rules-based intent detection | Authorized message filtering, batching and no-key candidate detection | W02, W15 | A request without an agent mention becomes a candidate; ordinary chatter can be ignored |
| W27 | Agent selection and proposals | Capability matching against eligible installations, proposal deduplication | W04, W05, W26 | Candidate becomes an approvable task; inference cannot grant permission or dispatch |
| W28 | Navigator configuration | Off/observe/suggest settings, effective scope precedence and limits | W26, W27 | Lower scopes cannot expand permission or exceed operator limits |
| W29 | Optional model provider | One replaceable provider adapter with consent, credentials references and budget accounting | W28 | Rules-only operation remains available; malformed provider output and exhausted budgets are handled |
| W30 | Navigator evaluation | Replay fixtures with labels, false-positive/missed-intent metrics and cost reporting | W26–W28; W29 for model comparisons | The same sample conversations can compare provider/rule behavior without executing work |

Auto-execution is deferred until constrained mandates and evaluation justify it.
Subscription-based follow-up routing is a later small module depending on W15/W23;
it should route authorized updates without repeated Navigator inference.

## G. Product screens

These remain separate small modules rather than one large "build the UI" task.

| ID | Work module | Concrete deliverable | Depends on | Completion check |
| --- | --- | --- | --- | --- |
| W31 | Task activity panel | Proposal approval, progress, failures and result display | W07, W11, W12, W13 | User can complete the mock task flow through the UI with honest error/loading states |
| W32 | Agent directory screen | Owned agents, status, capabilities, scopes and connection flow | W17 | Owner can inspect an installation and revoke it |
| W33 | Task controls screen | Capability-aware follow-up/cancel/steer actions and receipts | W22 plus each supported control, W31 | Unsupported controls are explicit and no false "applied" state is shown |
| W34 | Navigator settings screen | Profile editor and dry-run evaluation view | W28, W30 | User can inspect effective settings and preview suggestions without dispatch |

W31 can be pulled forward after W12/W13 for a visual demo. W16 delivers conversation
UI separately. Screens use backend authorization and never duplicate permission rules.

## Work that accompanies every module

Include its migration, focused tests, public contract changes, relevant audit/metrics,
run instructions and any ADR needed for a meaningful decision. Do not postpone these
into a final cleanup phase. Record what was verified and its limitations.

Separate later backlog: artifact upload/storage and safe rendering; data retention;
SDK packaging; operational usage dashboards; production rate limits and load tests;
release automation, license/governance and contributor distribution. These need
focused specs before public beta, but do not block the first mock milestone.

## Current checkpoint

The owner selected a **frontend-first design system** on 2026-11-03. `packages/ui`
provides shared React tokens/components; `apps/web` is the standalone interactive
gallery. See [the design-system guide](../design-system.md) and
[verification](../design-system-qa.md). This frontend foundation uses synthetic,
in-memory examples and does not mark W16 or W31–W34 complete. That frontend checkpoint remains independent of the later U01–U04 backend work.

Foundation W01–W04 is implemented: strict contracts, shared access checks, independent
owned installations, scoped grants, revocation, enablement and transactional audit.
Verification: 23 contract/integration tests passed against real PostgreSQL; TypeScript
typecheck/build passed; the compiled migration and foundation demo ran successfully.
An independent read-only review reported no significant foundation findings.

Current selected priority: **workspace and users before agent integration**.
U01–U04, the initial Socket.IO chat slice, and Better Auth email/password login and
sessions are implemented and locally verified. Email verification/reset delivery
and invitations are next authentication modules. W05 task-flow acceptance remains pending.
