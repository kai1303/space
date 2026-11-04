# Application principles

The project's constraints are: no polling, no explicit database locks, no distributed locks, and a scalable, reliable design. The operational definitions are maintained in the root `AGENTS.md`.

## Event-driven migration status

Migration032 replaces the runtime outbox publisher, worker queue scans, Navigator claims, server reconciliation and global connection/upload cleanup scans with committed PostgreSQL WAL → NATS JetStream → targeted push handlers. Business changes and event records commit together. WAL checkpoints advance after durable broker publication. Native broker scheduling holds deadlines outside handler concurrency slots. Reconnect reattaches realtime delivery before catch-up; idle browser and connector tests assert no recurring resource/queue reads.

Task acceptance uses a conditional pending-to-delivering transition. Attempt tokens reject stale writes; deadlines terminate uncertain attempts and never permit another worker to take them over. Navigator uses serializable transactions, watermark comparisons and unique inference reservations. A duplicate ready event leaves a healthy execution untouched. Inference with an unknown outcome is not automatically repeated.

This completes the runtime worker/outbox migration, not an application-wide lock removal.

| Remaining gap | Evidence | Required direction |
| --- | --- | --- |
| Explicit authoring/access locks | Chat sends, workspace/channel membership, unread/mention mutations, assets and thread checkpoints still acquire row/advisory locks; migrations retain an advisory lock. | Preserve authorization, sequence allocation, quotas and retry identity while replacing each guarantee with constraints, conditional writes or optimistic revisions. |
| Asset coordination | Asset preview/finalization still uses processing tokens with expiry/renewal and bounded busy retries. Targeted deadline cleanup reuses that existing coordination. | Redesign storage operation ownership and attachment/deletion races; removing the token alone would lose correctness. |
| Shared memory storage | Markdown memory retains a filesystem lock. | Assess a durable storage ownership model before sharing that directory between instances. |
| Production availability and capacity | Local PostgreSQL/NATS use single instances. Broker storage exhaustion retains scheduled work; NATS2.15.2 needs space freed and a broker restart to resume schedules that fired while full. | Provision/monitor storage and retained WAL, alert before capacity exhaustion, and use replicated production infrastructure. Local restart/failure tests do not prove production throughput or HA. |

Protocol heartbeats, operation deadlines and retries of a specific failed operation remain. They do not repeatedly discover resource state or scan work queues. PostgreSQL and NATS still perform their own internal coordination.

## Meaning of database locking

The constraint prohibits explicit application-level lock acquisition. PostgreSQL still takes internal locks for ordinary writes, including conditional updates. Optimistic concurrency reduces explicit coordination; it does not mean the database acquires zero locks. See [PostgreSQL locking documentation](https://www.postgresql.org/docs/current/explicit-locking.html).

## Acceptance for future changes

- No new recurring resource-read loops or explicit/distributed locking mechanisms.
- Durable recovery remains correct without depending on periodic reconciliation.
- Concurrent operations preserve access boundaries, retry identity and state transitions.
- Work and memory remain bounded; latency, throughput and recovery claims include measured evidence.
