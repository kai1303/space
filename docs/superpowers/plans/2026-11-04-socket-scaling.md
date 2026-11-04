# Socket.IO scaling hardening

The user approved fixing all five findings in the preceding architecture review.

**Goal:** Target realtime work, bound process resources, remove explicit locks from message sends, and make delivery health and deployment durability explicit without polling or distributed locks.

**Architecture:** Keep transactional PostgreSQL events and cursor replay. Add scoped WAL notification payloads and local subscription indexes, with a bounded FIFO database scheduler that does not hold slots while awaiting browser ACKs. Preserve global catch-up on reconnect/gaps. Use serializable message transactions and conditional attachment writes. Surface broker/CDC readiness and support replicated JetStream streams.

## Work and verification

- [x] Targeted fanout: migrate delivery payloads to include workspace, resource and actor scope; index subscriptions by dependency keys. Test unrelated workspace/task isolation, revocation, scope changes and replay after gaps.
- [x] Process budgets: bound admitted connections, per-actor connections, concurrent reads/commands and queued work; cancel stale queued work. Test overload and fairness and slow-client isolation.
- [x] Message send concurrency: preserve retry identity, sequence, membership and attachment guarantees using serializable transactions/conditional writes without explicit send-path locks. Run chat, authorization and attachment race tests.
- [x] Delivery health/durability: expose consumer readiness, demand-driven CDC lag checks and saturation counters; make transient Redis failure nonfatal to chat startup; configure explicit stream replicas. Test broker failures and startup degradation.
- [x] Deployment: provide validated multi-API/load-balancer and replicated-broker configuration plus external HA PostgreSQL, backup/restore and CDC recovery requirements. Never label a single-host rehearsal production HA.
- [x] Run affected integration suites, build/typecheck, browser recovery tests and a bounded multi-client measurement. Review correctness, authorization and scope before completion.

The user selected "Prepare deployment files only." Deployment artifacts are prepared and validated locally; production provisioning and production load/failover verification are outside this task's authorized deployment scope.

## Verification recorded November 4, 2026

- Backend build/typecheck and tests typecheck passed. The final serialized 20-file run passed 160 tests, with zero skips; a subsequently added total-transport admission test passed separately (161 relevant tests in total).
- Browser transport, invalidation and history tests passed: 21 tests.
- Actual EventBus on three isolated NATS nodes passed leader SIGKILL, durable ACK/replay, unavailable seed and complete cluster SIGKILL/restart. Native NATS/HAProxy config validation and both Compose render checks passed.
- Two-API/24-socket smoke measurement: 120 intended deliveries, zero duplicates/unrelated authentication checks, p50 36.17 ms / p95 72.82 ms. This does not establish production capacity.
- Spec and code-quality review passed after fixing old-consumer cleanup rejection recovery. Existing primary-owner and historical-notification test fixtures were corrected without weakening their assertions.
- Production provisioning and PostgreSQL failover/PITR verification remain external deployment work. Migration049 was exercised only in isolated test schemas; the development database was not migrated or restarted.
