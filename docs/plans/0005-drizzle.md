# Drizzle ORM adoption

User selected Drizzle. Use the stable node-postgres driver integration in @space/postgres.

- Introduce typed table mappings for existing tables and one database/pool module.
- Convert access, catalog, grants, bootstrap and task CRUD to typed builders.
- Use Drizzle transactions; retain tagged SQL for advisory locks, atomic outbox claims
  and event sequencing where PostgreSQL-specific behavior is intentional.
- Keep existing SQL files and schema_migrations history authoritative for DDL. Run them
  through Drizzle transactions; do not reset databases or introduce a second ledger.
  Table mappings are for queries; Drizzle Kit generation/push is outside this migration.
- Preserve store constructors that accept a Pool for caller/test compatibility.
- Centralize pool creation for production apps/scripts; pg remains the driver.
- Verify rollback, pool reuse, bound values, existing migration replay/data preservation,
  all lifecycle/security regressions, typecheck/build and Docker.

Status: implemented. All 28 backend tests, scoped Turbo build/typecheck and frozen
install passed. Existing development database migrated without reset; compiled
foundation demo passed. Docker build, container migration/demo/API health and clean
shutdown passed. Read-only review found no significant issues. Concurrent frontend
work was excluded from the backend checks.
