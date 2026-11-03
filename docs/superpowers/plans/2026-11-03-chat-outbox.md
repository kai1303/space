# Chat transactional outbox implementation plan

**Goal:** Replace post-commit RedisChatSignals publishing with an atomic PostgreSQL outbox and the Socket.IO Redis adapter.

**Architecture:** Channel-event inserts enqueue delivery work in the same transaction. Membership and credential invalidations also enqueue work. API instances claim bounded outbox batches with `FOR UPDATE SKIP LOCKED`, use acknowledged Socket.IO adapter inter-server events to schedule authorized local replay, and delete only the successfully published batch. Each instance runs the small publisher in-process. PostgreSQL cursors, idempotent sends, bounded client acknowledgments and reconciliation stay authoritative; no LISTEN/NOTIFY or separate publisher service.

**Scope:** Preserve existing PDF edits. Work in the current checkout because it contains the current integration state; do not commit unrelated work. No external deployment or live schema migration.

- [x] Add failing integration coverage for commit/rollback, restart recovery, publication failure, concurrent publishers, cross-instance adapter delivery and revocation.
- [x] Add migration 019: pending delivery rows and transactional triggers; retain event history unchanged.
- [x] Add a PostgreSQL batch relay and a Socket.IO Redis adapter connection owner. Replace API/worker post-commit publishing and remove the old hook.
- [x] Keep publication failures pending, limit concurrent relay work and drain safely on shutdown. Preserve per-batch authorization and recoverable handshake errors.
- [x] Update deployment dependencies, tests and chat documentation.
- [x] Run focused PostgreSQL/Redis, authentication, UI recovery tests and type/build checks. Review the final diff for unrelated changes and delivery gaps.

Verification: `pnpm test` passed, including 135 contract/integration and 133 frontend tests plus the other package suites. `pnpm typecheck`, `pnpm build` and `git diff --check` passed. Independent review found and verified a fixed Redis adapter promise-rejection race; its child-process regression now passes. Migration tests use disposable schemas; no live schema was migrated.
