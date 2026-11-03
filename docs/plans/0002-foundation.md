# Foundation: W01–W04

Status: implemented and locally verified, 2026-11-03.

Validation: 23 tests passed against real PostgreSQL, typecheck/build passed, compiled
migrations and the foundation demo passed. Read-only review found no significant
foundation issues. No real remote agent or production authentication is claimed.

Scope: versioned runtime-neutral contracts, reusable scoped access checks, a durable
agent catalog, and owner-managed channel/skill grants. Existing task-flow code is a
compatibility consumer; no new task, transport, Navigator or UI features are added.

## Decisions

- Keep the current single TypeScript project and PostgreSQL adapter.
- Export schema version 1.0 and strict parsers for capabilities, catalog inputs,
  invocation, session and execution records. Unknown controls are rejected; absent
  controls mean unsupported. Catalog metadata never grants authority.
- Definitions are immutable trusted operator entries. Installing one requires current
  workspace membership; owner is always the authenticated actor, never request data.
- New installations have no grants. Owners see their own installations; collaborators
  see only installations granted into a channel they can access.
- Only the installation owner with current workspace membership can manage it. Granting
  also requires membership in the same-workspace channel and a declared skill.
- Revoke and disable remain possible after loss of channel membership. They serialize
  against dispatch eligibility checks through installation row locks. In-flight work
  is not implicitly canceled; cancellation belongs to W24.
- Repeated grant/revoke/enable calls are idempotent. Successful changes append an audit
  entry transactionally. Definition authoring is a trusted operator API, not public
  endpoint ownership verification. Secret storage and network onboarding are W17.
- Share access checks with the existing task store so private-thread reads retain
  their current deny-by-default behavior.

## Work and checks

1. Add failing parser and real-PostgreSQL foundation tests.
2. Implement contract validation and centralized workspace/channel/thread checks.
3. Implement catalog/install/list, owner authorization, grant/revoke/enable and audit.
4. Adapt existing consumers to shared checks; run existing task-flow regression tests.
5. Document contracts, local setup and the foundation APIs; update module status.

Acceptance: two owners can install one definition independently; forged ownership,
foreign channels, undeclared skills and non-owner mutations fail; private installs
are hidden; revocation prevents subsequent approved dispatch; concurrent duplicate
grants produce one row/audit entry; all state survives a new database connection.
