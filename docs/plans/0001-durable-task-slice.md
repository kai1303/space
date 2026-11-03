# Durable task slice implementation plan

Goal: a no-model-key API/CLI demonstration with approval, persisted task events,
mock invocation, thread result, and restart recovery.

Scope update (2026-11-03): the owner requested a small-module breakdown. See
`docs/architecture/module-roadmap.md` for module ownership and delivery slices.
This implementation plan covers only S01–S04. Feature expansion is paused while
the decomposition is reviewed; the mock milestone is still in progress.

1. Contracts and policy: define separate definition/installation/task/session/execution/
   control objects, bounded request/event parsers, connector interface and transition
   checks. Add contract tests first; run with `pnpm test:contracts`.
2. Persistence: add a versioned SQL migration, transactional task creation/approval,
   scoped reads, append-only events, hashed credentials, separate sessions/executions,
   outbox leases/fencing/retry/dead letters and authenticated event ingestion.
   First write real-Postgres tests for approval, isolation, replay and recovery.
3. Worker and mock: invoke through the common connector contract with idempotency key,
   advertised unsupported controls, timeout and failure handling. Test a crash between
   completion and acknowledgment and reclaim an expired delivery using a new pool.
4. HTTP API and driver: authenticate bearer tokens, reject unknown fields and oversized
   bodies, expose create/approve/reject/read/events/thread/installation endpoints.
   Test HTTP auth and request validation; run the CLI against separate live processes.
5. Contributor experience: Docker Compose, build, migrations, explicit demo bootstrap,
   README, security notes and CI. Run typecheck, build, all tests and the live demo.

Files: `packages/contracts/index.ts`, `packages/core/{policy,ports,worker}.ts`,
`adapters/postgres/{store,migrate}.ts`, `adapters/postgres/migrations/001_initial.sql`,
`adapters/mock/connector.ts`, `apps/{server,worker}/*.ts`, `scripts/*.ts`, `tests/**`,
`compose.yaml`, `Dockerfile`, root package/TypeScript config and contributor docs.

Acceptance: unapproved work cannot execute; concurrent approvals create one execution;
unauthorized workspace/channel reads fail; result returns once to origin; replay and
expired leases recover; revocation blocks dispatch; retries exhaust visibly; malformed
and stale agent events fail; all checks run against real PostgreSQL.
