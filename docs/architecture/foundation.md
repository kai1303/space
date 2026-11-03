# Foundation guide: W01–W04

## W01 — Contracts

`packages/contracts/index.ts` exports runtime-neutral types and strict parsers.
`SCHEMA_VERSION` is `1.0`. Events and invocation requests carry this version explicitly.
Unsupported versions, unknown fields, invalid IDs, unbounded text and malformed
capability flags are rejected with `AppError(400, code)`.

- `TaskInput`: workspace/thread/installation, goal and skill; no authority fields.
- `Task`: objective and approval/lifecycle state.
- `AgentSession`: context mapping to an installation and origin thread.
- `Execution`: one attempt with a separate ID and event sequence.
- `AgentDefinition`: immutable metadata and declared capabilities.
- `AgentInstallation`: a workspace owner's connection to a definition.
- `AgentGrant`: one installation/channel/skill authorization.
- `ControlCommand`: provisional type reserved for W22; no control execution yet.

Definitions and skills are descriptive. Missing control flags mean unsupported.
Declaring a skill, confidence value or approval-like text never grants permission.

Example invocation:

```json
{
  "schema_version": "1.0",
  "task_id": "00000000-0000-4000-8000-000000000001",
  "session_id": "00000000-0000-4000-8000-000000000002",
  "execution_id": "00000000-0000-4000-8000-000000000003",
  "idempotency_key": "00000000-0000-4000-8000-000000000003",
  "goal": "Review paid-customer churn",
  "skill": "demo.echo"
}
```

Event IDs are stable across replay. Agent sequence starts at 1 per execution and must
be contiguous. Platform audit sequence is separately ordered per task. Event dates
must be actual calendar timestamps in UTC with milliseconds. The event receiver takes
installation identity from its trusted transport context, never from event text.

The current mock connector completes before its invocation promise resolves. Its
receipt does not yet model asynchronous acceptance/polling. W18/W19 must extend and
conformance-test that boundary before introducing real remote agents; the foundation
makes no claim of validated A2A or Codex interoperability.

## W02 — Access

`hasWorkspaceAccess`, `hasChannelAccess`, `hasThreadAccess` and
`requireWorkspaceAccess` live in `adapters/postgres/access.ts`. They query persisted
active workspace membership rather than trusting caller-provided booleans. Private channels always
require explicit membership. Thread access requires both workspace and channel access.
The existing task store uses the same thread-access function.

Actor IDs are supplied by trusted application authentication. Foundation tests and
demo use seeded users; real identity/session management is W13. Cross-workspace and
unknown resource operations return 404. A known same-workspace installation owned by
someone else returns 403 for management operations. All SQL parameters are bound.

## W03 — Catalog

Create `new FoundationStore(pool)` from `adapters/postgres/foundation.ts`.

| Method | Caller/context | Behavior |
| --- | --- | --- |
| `publishDefinition(input)` | Trusted deployment operator | Validate and persist immutable public metadata; no credentials or endpoint verification |
| `install(actor, input)` | Authenticated workspace member | Set owner to actor, reference existing definition, begin with zero grants |
| `list(actor, workspace)` | Workspace member | Return owned installations plus installations shared into accessible channels; bounded to 200 entries |

Installation input: `{ workspace_id, definition_id, connector_id }`. Connector ID is
an identifier, not a URL or executable module path. Registration alone never loads
code or makes a network call. An unconfigured connector cannot execute through the
existing worker. Paginated catalog browsing can be added when the UI requires it.

Two users may install one definition with distinct installation IDs, ownership and
grants. Changing one installation never changes the definition or another installation.
No public definition-editing endpoint is included.

## W04 — Grants and enablement

| Method | Rule |
| --- | --- |
| `grant(actor, installationId, { channel_id, skill })` | Current owner/workspace member; same-workspace channel membership; declared skill |
| `revoke(actor, installationId, { channel_id, skill })` | Current owner/workspace member; removal allowed after channel access is lost |
| `setEnabled(actor, installationId, boolean)` | Current owner/workspace member; does not add or remove grants |

Repeated identical operations are idempotent. Mutations lock the installation row
and append `foundation_events` in the same transaction. Duplicate grants under
concurrency produce one row and one audit entry. Audit entries cannot be updated or
deleted by ordinary SQL; database administrators remain trusted.

Task proposal/approval/dispatch require the installation to be enabled, a matching
grant, a declared skill, and current requester/owner channel membership. Revocation
committed before dispatch authorization is therefore effective even for already
approved tasks. Revocation after invocation does not cancel in-flight work. Owner
workspace removal blocks management until an operator restores/reassigns ownership;
workspace membership/offboarding is now U03–U04; see `workspace-users.md`.

## Checks

`pnpm test:foundation` exercises contract validation, isolation, two-owner reuse,
strict ownership, invalid skills/scopes, concurrent duplicate grants, durable reload,
revocation and disablement, and immutable audit. `pnpm test` also runs the existing
mock task-flow regressions. No production or independent-agent verification is implied.
