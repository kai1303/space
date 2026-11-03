# ADR 0001: First durable task slice

Date: 2026-11-03
Status: Accepted for Increment A; framework and public API stability remain provisional.

## Inventory and gap assessment

The supplied workspace was empty: no source, Git metadata, package manifest, database,
tests, or CodeGraph index. There is no existing dependency graph. The full workplace
is unimplemented. This increment establishes task execution, not chat or Navigator.
The owner requested skipping CodeGraph initialization.

## Decision

Use one TypeScript project with logical modules, two Node.js processes (HTTP API and
worker), PostgreSQL, and a built-in mock connector. Use pnpm for dependency management.
Start with Node's HTTP server to avoid choosing a product backend framework on the
strength of four endpoints. No framework, model, protocol, or runtime SDK enters the
contracts or policy code. Do not create empty packages for the full roadmap.

A human proposes a task against a seeded thread and installation. Only the installation
owner with current channel membership may approve or reject it. Approval creates a
separate Session, Execution, audit event and outbox delivery in one transaction.
The worker claims a lease using SKIP LOCKED, rechecks current access, invokes a connector
with execution ID as idempotency key, and ingests normalized events. Completion stores
the result and a reply in the originating thread in one transaction. Events are
append-only in the application and ordered per task. Agent event sequence is separate.

At-least-once delivery is explicit. A connector must deduplicate invocations by
execution ID and replay stable event IDs/sequences. PostgreSQL deduplicates ingress.
A crash after completion but before outbox acknowledgment must not run completed work
again. Expired leases can be reclaimed; acknowledgment is fenced by a lease token.
Retries use bounded exponential delay; exhausted deliveries become dead letters and
fail unfinished executions/tasks. Invocation has a timeout. This does not promise
exactly-once external side effects or cancellation of arbitrary external runtimes.

Bearer credentials are random bootstrap secrets stored only as hashes. Human and
installation authentication are separate. There are no public agent callbacks, custom
URLs, or endpoint onboarding in this slice. Trusted built-ins only. Authorization is
deterministic and checked at HTTP access, approval, and dispatch. Agent text cannot
approve tasks. Events from the wrong installation, stale execution, or out-of-order
sequence are rejected. Grants carry exactly one harmless `demo.echo` skill for now.

## Dependency graph (arrows mean imports)

```text
apps/server -> core task ports + postgres adapter
apps/worker -> core worker -> contracts + task ports
            -> postgres adapter + mock adapter
postgres adapter -> core policy/state rules + contracts + pg
mock adapter -> contracts
core policy/state rules -> contracts
contracts -> no third-party dependencies
```

## Explicit limitations and departures

- No web UI, full identity/onboarding, Navigator, real adapters, artifacts or controls.
- Task, session, execution and control contracts are separate; only invoke/progress/
  completion/failure are executable. Unsupported controls are reported, never faked.
- Capabilities and grants are seeded by an operator; only a mock connector is enabled.
- Poll event history using a cursor; WebSockets/SSE can be added after interoperability.
- Node HTTP is a reversible Increment A choice, not resolution of Fastify vs NestJS.
- One root TS project precedes separately published workspace packages/SDKs.
- No license selected or third-party implementation copied. Do not imply OSS licensing
  has been settled merely because the project is intended to become open source.
- Tests use a real isolated PostgreSQL database, not an in-memory substitute.

## Open decisions

Chat backend/protocol, project name/license/governance, production authentication,
collaborator approval mandates, retention/provider consent, third-party connector
isolation, Navigator inheritance/evaluation, artifact storage, control conformance,
and real local/cloud transport versions all remain unresolved. Before M2, verify
current official Codex/A2A APIs and validate the same connector suite against both.

## References consulted

- https://node-postgres.com/features/transactions (one client per transaction)
- https://www.postgresql.org/docs/current/sql-select.html (SKIP LOCKED queue claims)
- https://nodejs.org/api/http.html (HTTP server boundary)
