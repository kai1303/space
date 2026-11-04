# Space project guidance

## Architecture principles

- **No polling.** Do not repeatedly fetch API resources, scan database tables or check work queues on a fixed timer. Use event-driven delivery with durable recovery. Heartbeats, deadlines, debounce and bounded retries of failed operations are distinct from polling; do not hide recurring resource scans inside them.
- **No explicit database locks.** Do not introduce `SELECT FOR UPDATE`, `FOR SHARE`, `SKIP LOCKED`, PostgreSQL advisory locks or explicit table locks. Use constraints, atomic conditional writes and optimistic concurrency where appropriate. Normal database transactions and PostgreSQL's internal write locks still exist; never describe these operations as physically lock-free.
- **No distributed locks.** Do not introduce Redis/Redlock, external mutex services or exclusive ownership leases as a replacement for a distributed mutex. Review existing lease-based coordination against this rule rather than assuming that renaming a lock makes it compliant.
- **Scalable and reliable.** Bound connections, subscriptions, queues, payloads, retries and concurrency. Preserve authorization, idempotency, durable state and recovery. Prove concurrency and failure behavior with tests; make performance claims only with measurements.

These rules guide all new work. Existing violations are migration work, not precedents or implicit exceptions. Preserve correctness while replacing them; do not simply delete locks, polling or recovery mechanisms.

See [architecture principles and current gaps](docs/architecture/principles.md).

## Frontend structure

- Keep application composition and navigation in `apps/web/src/app`, product behavior in `features`, infrastructure in `shared`, and demonstrations in `gallery`.
- Colocate feature tests and styles. Production features must not import from `app` or `gallery`; `shared` must not import application features.
- Keep reusable presentation in `packages/ui`. Consume it through declared `@space/ui/*` exports rather than cross-package relative paths.
- Preserve the signed-in realtime session owner and feature cleanup when extracting components or hooks.

See [frontend ownership and development](docs/architecture/frontend.md).

## CodeGraph

Use the configured CodeGraph MCP for structural questions: definitions, signatures, callers/callees, impact and focused code context. For architecture questions, start with `codegraph_context`, then one `codegraph_explore` if needed. Answer directly without delegating exploration or rechecking indexed structure with grep. Use native search for literal strings/comments or details inside an already opened file.

Use `codegraph_files` for project structure. If CodeGraph reports this project is not initialized, ask before running `codegraph init -i`. Do not query immediately after edits; allow the watcher to catch up.
