# Realtime availability and recovery

The root `compose.yaml` is a development stack. A single Docker host, PostgreSQL instance, NATS node, API process, load balancer or disk is not an HA deployment. The files in `deploy/realtime` provide a repeatable broker failure rehearsal and an API topology example; they do not provision production infrastructure or certify its availability.

## Run the isolated broker rehearsal

Requires Docker Compose, Node 22+ and the installed workspace dependencies:

```sh
pnpm --filter @space/events build
node deploy/realtime/fault-rehearsal.mjs
```

The script creates a uniquely named Compose project with three NATS 2.15.2 nodes, separate file-storage volumes, cluster routes, random loopback client ports and `sync_interval: always`. It uses the actual `EventBus` to create file-backed CHAT/WORK streams with `NATS_REPLICAS=3` and publish/subscribe. It kills the stream leader, checks persisted messages and a durable consumer's acknowledged cursor, replays unacknowledged delivery, bootstraps with an unavailable seed, and publishes while one broker is down. After replicas catch up it kills all three processes and verifies message and consumer state after restart. Its `finally` block removes only its own project and volumes. An externally interrupted run may need manual cleanup of the printed `space-ha-test-*` project; never run cleanup against the development or production project.

This tests process loss and restart on one host. It does not simulate power failure, storage corruption, zone loss, latency under load, or a PostgreSQL failover. Explicit per-write sync is a durability choice with a throughput/latency cost; benchmark the actual disks. NATS documents both [file-storage synchronization](https://github.com/nats-io/nats.docs/blob/master/nats-concepts/jetstream/README.md) and [R3 quorum behavior](https://docs.nats.io/learn/topologies/jetstream-in-a-cluster). R3 tolerates one unavailable replica; it cannot keep publishing after losing two.

## Production topology and required inputs

Use `deploy/realtime/compose.api.yaml` as an application-tier example. It runs two API processes behind HAProxy and one supervised CDC bridge. It deliberately requires external PostgreSQL, NATS and S3-compatible storage values. It neither creates nor migrates a database. Apply migrations once using the same application image before admitting traffic. Worker services remain a separate deployment responsibility.

```sh
# Load secrets from your deployment secret store into the process environment.
# SPACE_IMAGE must refer to the built application image, preferably by digest.
docker compose -p space-api -f deploy/realtime/compose.api.yaml config --quiet
docker compose -p space-api -f deploy/realtime/compose.api.yaml up -d
```

Required configuration:

| Input | Requirement |
| --- | --- |
| `SPACE_IMAGE` | Immutable image built from the approved source and migrations. |
| `DATABASE_URL` | HA PostgreSQL primary endpoint, TLS, logical replication enabled, application/CDC grants and an explicit connection budget. |
| `NATS_URL` | Comma-separated reachable seed URLs, e.g. `tls://user:password@nats-a:4222,tls://user:password@nats-b:4222,tls://user:password@nats-c:4222`; URI-encode credentials. Use a managed secret and the platform CA trust configuration. |
| `NATS_REPLICAS` | The example pins `3`. Runtime accepts `1`, `3`, `5`; production requires at least `3`. Verify existing streams finish replica catch-up before continuing rollout. |
| `BETTER_AUTH_SECRET` | A strong shared secret on all API replicas, retained across restarts. |
| `BETTER_AUTH_URL`, `AUTH_TRUSTED_ORIGINS` | Actual public HTTPS URL and an explicit comma-separated allowlist of HTTPS browser origins. |
| `TRUSTED_PROXY_CIDRS` | Only controlled load-balancer source addresses; never a public-wide range. |
| `ASSET_STORAGE_*` | External durable S3-compatible service, HTTPS public endpoint, bucket, credentials and browser CORS rules. Local SeaweedFS demo credentials are not a production configuration. |
| `REDIS_URL` | Optional shared typing transport; chat durability does not depend on it. Use private authenticated/TLS Redis when enabled. |

A production scheduler must place the API replicas on different failure domains and maintain at least one available during rollouts. Run three NATS servers on separate failure domains with independent durable disks and stable server names, client advertisements and routes. Each must have authenticated/TLS client and route connections; keep monitoring and administrative ports private. `deploy/realtime/nats.conf` is an unauthenticated isolated test fixture, not a public production broker configuration. Size file-store budgets and disks for the expected outage and recovery window. WORK streams preserve outstanding work rather than evicting it; when broker storage fills, new writes fail and PostgreSQL retains the unpublished outbox/WAL backlog. Provision headroom and alert before that boundary.

The example's HAProxy listener binds to loopback and expects an HTTPS edge in front of it. Supply redundant load balancers or a managed regional load-balancer service, TLS certificates and DNS failover; the single example proxy is another single-host rehearsal component. Do not expose port 8080 directly to the public network. The proxy overwrites forwarded headers and sets the public scheme to HTTPS; an external edge must provide a separately designed trusted client-IP chain if client-IP preservation is required.

## Readiness, bounded connections and draining

HAProxy supports the [WebSocket upgrade and tunnel timeout](https://www.haproxy.com/documentation/haproxy-configuration-tutorials/protocol-support/websocket/) directly. The example uses `/readyz` for [active health routing](https://www.haproxy.com/documentation/haproxy-configuration-tutorials/reliability/health-checks/), not merely process liveness. Its periodic infrastructure probes are health checks; application message delivery and recovery remain event-driven. `/readyz` fails when the API's required delivery dependencies are unavailable or stale. Readiness failure removes a backend from **new** routing; existing WebSockets are not magically migrated.

The proxy caps total connections at 2,000, each API backend at 1,000 and each backend queue at 128 with a 2-second queue deadline. APIs also cap realtime connections, actor connections and concurrent/queued authorization work. These are conservative example limits, not measured capacity claims. Budget HTTP, WebSocket, worker and CDC PostgreSQL connections together, including spare capacity during rolling updates. A saturated WebSocket process can still need HTTP capacity; tune the proxy and runtime limits together after a mixed-traffic load test. Monitor overload refusals, queue wait, disconnects, slow-client closures and reconnect bursts, not just successful requests.

For a rollout, put one backend in maintenance using the protected HAProxy admin socket (`set server space_api/api-1 state maint`) or the equivalent target-deregistration API of the managed load balancer. Keep the other replica ready. Allow a bounded drain interval, then send SIGTERM; the API closes realtime connections and clients reconnect/replay through the remaining backend. The example allows 45 seconds before forced termination. Restore the backend to `ready` after replacement and wait for `/readyz` success before touching the second replica. Do not configure automatic request retries for non-idempotent writes. No sticky sessions are required for WebSocket-only realtime transport; do not enable Socket.IO long-polling without revisiting affinity and failover behavior.

## PostgreSQL, CDC and restore runbook

The database operator must own multi-zone primary failover, backup encryption/retention, continuous WAL archiving, PITR, and regular isolated restore exercises with measured RPO/RTO. Replication is not a backup. Supply a PostgreSQL endpoint that supports the actual logical replication protocol; a transaction-pooling endpoint is insufficient for the CDC connection. Verify the database connection budget against API/worker count, CDC and migrations.

The CDC bridge has one active logical replication connection. The example supervises one process with `restart: unless-stopped`; it is not active-active CDC and does not provide cross-host rescheduling. The production supervisor must restart/reschedule it while preserving the original logical slot identity, database and schema. Provision and test that recovery before accepting availability objectives. Deploying several bridge processes against the same slot is not a substitute for a tested failover mechanism.

The current default slot name is derived from the schema and is cluster-global. Two databases in one PostgreSQL cluster using the same schema/wildcard bridge can collide; isolate their database clusters unless the runtime supplies a distinct, stable slot namespace. Changing the namespace on an existing deployment creates a new replay boundary and requires a controlled migration.

PostgreSQL 16 development configuration does **not** establish automatic failover-slot preservation. Require the managed operator to prove logical slot continuity on promotion, or implement and rehearse controlled reconstruction from the retained outbox before reopening traffic. PostgreSQL's [logical decoding documentation](https://www.postgresql.org/docs/current/logicaldecoding-explanation.html) describes slot persistence, duplicate delivery and the additional configuration required for failover slot synchronization on versions that support it; enabling those database features alone does not prove this application's slot was created/configured for failover.

On an outage:

1. Remove unhealthy API targets from new routing; preserve PostgreSQL, NATS volumes and outbox rows. Do not drop a slot to silence a disk alert, acknowledge an unconfirmed publication, or recreate an empty stream over lost state.
2. Restore broker quorum/network/disk capacity and restart the CDC supervisor against the original database/slot. Confirm published outbox rows are retiring, the slot is active with advancing confirmed LSN, replica lag closes, and `/readyz` recovers.
3. If PostgreSQL failed over, inspect slot presence, database identity, `wal_status`, restart LSN and confirmed LSN before resuming. If the slot or required WAL is lost, stop the bridge and keep traffic unavailable while an operator follows a tested outbox replay/rebuild procedure. No automatic slot-loss recovery guarantee is claimed here.
4. If restoring PostgreSQL via PITR, isolate the restored environment from the original NATS cluster and live clients until database/outbox, broker streams, consumer ACK state and application idempotency have been reconciled. A database restore and a newer broker snapshot are not automatically consistent. Validate history/read state and a known event's replay before reopening.

Monitor broker health, quorum/replica lag, publish failures and latency, disk usage and file-store limits, consumer pending/ack-pending/redelivery, and API `/readyz`. Monitor PostgreSQL `pg_replication_slots` including `active`, `wal_status`, `restart_lsn`, `confirmed_flush_lsn`, retained WAL bytes, free disk and oldest outbox age. Alert on stale outbox age before the readiness cutoff, and on retained WAL growth before storage exhaustion. Readiness is a routing signal, not a replacement for those metrics or a restore test. The external monitoring system owns its collection interval; no resource polling is added to the application.

## Remaining app-wide HA boundaries

This topology addresses realtime broker replication and API process redundancy. It does not make asset processing/coordination, workers, connector executions, email delivery, or the filesystem-backed portions of the application highly available. Channel Markdown documents use revision-checked writes in the shared Space PostgreSQL database. External object storage protects objects, but does not prove the asset-processing pipeline survives every failure. Require separate deployment/recovery validation for those capabilities before claiming whole-application HA.
