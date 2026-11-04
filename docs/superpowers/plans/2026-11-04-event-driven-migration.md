# Event-driven backend migration

**Goal:** Replace runtime outbox/worker/reconciliation scans with committed WAL events and durable broker consumers, without application-managed database or distributed claim locks.

**Architecture:** PostgreSQL stores business changes and append-only event_outbox records transactionally. A Node CDC service uses pg-logical-replication's native pgoutput decoding and acknowledges committed WAL only after NATS JetStream acknowledges all events. Push consumers deliver targeted chat, Navigator, task and deadline events. API instances independently receive realtime invalidations; worker groups divide job delivery. Conditional state transitions and deduplication reject duplicates/stale executions. Deadline messages replace periodic expiry scans. Socket.IO remains the browser/connector transport.

**Preserve:** Current auth/access boundaries, shared socket protocol, session work from the parallel task, idempotent sends, durable message history and bounded buffering. Normal PostgreSQL write locks and broker internal delivery bookkeeping remain; no new explicit application locks or exclusive timeout mutexes.

- [x] Add the event adapter, CDC service, logical-WAL/NATS Compose configuration and event-outbox migration; verify commit/rollback, publisher outage and resume against real services.
- [x] Replace worker loops with targeted durable subscriptions. Replace delivery/Navigator claim scans with conditional writes and event IDs; preserve crash recovery and reject uncertain/stale results.
- [x] Replace API outbox drain/reconciliation timers and queue scans with subscriptions and reconnect catch-up. Replace connection/delivery/upload expiry scans with targeted deadline events.
- [x] Validate duplicate delivery, restarts, independent API fanout, revoked access, idle no-scan behavior and bounded backpressure. Update affected tests, CI and docs.
- [x] Run build/typecheck and relevant full suites; audit remaining polling/explicit locks honestly. Cut over local runtime only after durable publication/recovery tests pass.

Event contract: {id,schema,kind,aggregate_id,data,available_at?}; subjects <streamName(schema)>.<kind>.<aggregate_id>, with a hashed schema prefix. Consumers acknowledge only after durable effects. Broker-native schedules hold future deadlines outside AckPending; a retry publishes a durable scheduled copy before acknowledging its source. CDC is one publisher per replication slot; PostgreSQL replication-slot exclusivity is infrastructure ownership, not an application distributed mutex. Startup/bootstrap reads are allowed once to cover pre-slot work; no periodic resource scans.


## Verification and local cutover

- Full contract/integration suite:285 passed,0 failed, with file concurrency bounded to4.
- UI suites:100 component tests and226 web tests passed. Connector suite:51 passed.
- Build and typecheck:27 tasks passed. Compose validation and diff whitespace checks passed.
- Failure coverage includes commit/rollback visibility, retained WAL during a broker outage, duplicate task targets, exact deadline fencing, worker restart, native future retries, API reconnect after ephemeral-consumer expiry, realtime sequence-gap catch-up, and idle resource/queue reads.
- The100-event CDC test with50ms injected broker latency delivered in723ms; this is a scoped local result, not a production throughput benchmark.
- Local migration032 applied. API health returnedok, worker subscriptions became ready, the existing local connector reconnected, and public CHAT/WORK consumers were present.
- Local NATS storage-path correction preserved old and new stream directories; the original replication slot remained intact. Storage-capacity recovery was verified in a separate disposable broker. Production HA/load behavior and remaining authoring/asset/filesystem coordination gaps are documented in docs/architecture/principles.md.
