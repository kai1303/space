# ADR 0005: Drizzle ORM over node-postgres

Date: 2026-11-03
Status: Implemented following the owner's Drizzle selection.

Use stable drizzle-orm 0.45.4 with its node-postgres integration in @space/postgres.
The connection driver remains pg. Production processes/scripts call createPool from
the shared database module, with bounded connection acquisition and sanitized idle
connection error reporting. Each process owns and closes its pool. Store constructors
still accept a Pool so tests can provide isolated schemas and existing callers remain
compatible. Creating a Drizzle handle on a pool does not create a second pool.

Access checks, catalog/grants, bootstrap and task CRUD now use typed query builders.
Transactions use Drizzle's transaction API. Preserve FOR UPDATE/FOR SHARE targets and
retain parameterized tagged SQL for the atomic SKIP LOCKED outbox claim, advisory lock,
event sequence calculation and JSONB equality. These are PostgreSQL behavior, not
reason to duplicate transaction or connection management ourselves.

Existing SQL migrations and schema_migrations remain authoritative. The migration
runner uses a Drizzle transaction and advisory lock, applies only absent versions and
preserves the current data/history. sql.raw is restricted to reviewed SQL files loaded
from the package, never input. Drizzle Kit generation/push is not configured: schema.ts
is a typed query mapping and deliberately does not duplicate every composite foreign
key, check, index or trigger from the DDL. Do not use it to generate replacement DDL.
When generated migrations are desired, first reconcile complete schema metadata and
baseline the existing history in a separate migration-tooling change.

The HTTP health route calls the repository health method rather than accessing the
pool directly. pg is now a direct application dependency only in the database adapter
(and integration tests for setup/inspection), not in API, worker or tools packages.
The backend Docker image builds only its own workspace dependency graph.

Verification includes the existing security/lifecycle suite, transaction rollback and
pool reuse, binding hostile-looking text as data, applying migrations twice without
losing rows, and concurrent worker claims. Frontend code being added in parallel is
outside this change and is not part of the backend verification result.

References:
- https://orm.drizzle.team/docs/get-started-postgresql
- https://orm.drizzle.team/docs/transactions
- https://orm.drizzle.team/docs/migrations
