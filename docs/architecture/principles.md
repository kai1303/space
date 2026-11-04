# Application principles

The project's constraints are: no polling, no explicit database locks, no distributed locks, and a scalable, reliable design. The operational definitions are maintained in the root `AGENTS.md`.

## Event-driven migration status

Migration032 replaces the runtime outbox publisher, worker queue scans, Navigator claims, server reconciliation and global connection/upload cleanup scans with committed PostgreSQL WAL → NATS JetStream → targeted push handlers. Business changes and event records commit together. WAL checkpoints advance after durable broker publication. Native broker scheduling holds deadlines outside handler concurrency slots. Reconnect reattaches realtime delivery before catch-up; idle browser and connector tests assert no recurring resource/queue reads.

Task acceptance uses a conditional pending-to-delivering transition. Attempt tokens reject stale writes; deadlines terminate uncertain attempts and never permit another worker to take them over. Navigator uses serializable transactions, watermark comparisons and unique inference reservations. A duplicate ready event leaves a healthy execution untouched. Inference with an unknown outcome is not automatically repeated.

This completes the runtime worker/outbox migration, not an application-wide lock removal.

| Remaining gap | Evidence | Required direction |
| --- | --- | --- |
| Explicit authoring/access locks | Message sends now use serializable transactions, bounded retries and conditional attachment writes. Channel administration/reactions, workspace/channel membership, unread/mention mutations, asset operations and thread checkpoints retain explicit locks; migrations retain an advisory lock. | Preserve authorization, sequence allocation, quotas and retry identity while replacing each remaining guarantee with constraints, conditional writes or optimistic revisions. |
| Asset coordination | Asset preview/finalization still uses processing tokens with expiry/renewal and bounded busy retries. Targeted deadline cleanup reuses that existing coordination. | Redesign storage operation ownership and attachment/deletion races; removing the token alone would lose correctness. |
| Shared memory storage | Markdown memory retains a filesystem lock. | Assess a durable storage ownership model before sharing that directory between instances. |
| Production availability and capacity | Development PostgreSQL/NATS remain single instances. Production stream configuration requires at least three replicas; an isolated three-node fault rehearsal and two-API deployment example are provided. Broker storage exhaustion retains scheduled work; NATS2.15.2 needs space freed and a broker restart to resume schedules that fired while full. | Follow the [deployment and recovery runbook](realtime-deployment.md); provision external HA PostgreSQL, backups, independent failure domains and monitoring. Local restart/failure tests do not prove production throughput or HA. |

Protocol heartbeats, operation deadlines and retries of a specific failed operation remain. They do not repeatedly discover resource state or scan work queues. PostgreSQL and NATS still perform their own internal coordination.

## Realtime admission and fanout

Migration049 includes resource dependency keys in committed change hints. Each API indexes local subscriptions by workspace/channel/task/thread/actor; a task progress event no longer authenticates or reads unrelated metadata subscriptions. Credential changes target their actor, including sockets without view subscriptions. Legacy hints, broker sequence gaps and reconnection still cause full catch-up so rolling upgrades cannot drop recovery. Connector authorization checks use the same scoped keys.

Each API defaults to 1,000 Engine.IO connections, eight browser sockets per actor, four concurrent realtime database operations and 512 queued operations. `REALTIME_MAX_CONNECTIONS`, `REALTIME_MAX_ACTOR_CONNECTIONS`, `REALTIME_WORK_CONCURRENCY` and `REALTIME_WORK_QUEUE` configure these budgets. The queue rotates socket owners and cancels disconnected owners; stream wakeups coalesce. Browser ACK waits do not occupy database slots. Each socket retains one channel, one unread stream and at most 64 resource subscriptions. Limits bound work; they are not measured capacity promises. Overload disconnects clients for backoff/replay, and bounded send contention returns `409 session_conflict` with no partial writes. Retry the same `client_message_id` for the same send.

`/healthz` checks database liveness. `/readyz` performs demand-driven, coalesced checks of broker connectivity, consumer attachment, active CDC slot and oldest unpublished event (15-second cutoff), and exposes queue/connection/ACK-timeout and database waiting counters. Slot/WAL metrics are routing diagnostics, not backup or failover proof. Consumer protocol heartbeats detect failed delivery attachments; cleanup errors cannot poison reattachment. Redis is optional for transient typing and attaches when available; it does not gate chat startup or durability.

The November 4, 2026 local fanout smoke test used two API instances and 24 sockets (12 matching recipients and 12 unrelated). Ten sequential sends produced 120 intended deliveries, zero unrelated authentication checks and no duplicate deliveries; the final suite run observed send-to-recipient p50 of 36.17 ms and p95 of 72.82 ms. This is a modest local correctness/latency measurement, not a capacity ceiling or production benchmark. Reproduce with `tests/integration/realtime-load.test.ts` against isolated PostgreSQL/CDC, NATS and Redis test services.

## Meaning of database locking

The constraint prohibits explicit application-level lock acquisition. PostgreSQL still takes internal locks for ordinary writes, including conditional updates. Optimistic concurrency reduces explicit coordination; it does not mean the database acquires zero locks. See [PostgreSQL locking documentation](https://www.postgresql.org/docs/current/explicit-locking.html).

## Acceptance for future changes

- No new recurring resource-read loops or explicit/distributed locking mechanisms.
- Durable recovery remains correct without depending on periodic reconciliation.
- Concurrent operations preserve access boundaries, retry identity and state transitions.
- Work and memory remain bounded; latency, throughput and recovery claims include measured evidence.
