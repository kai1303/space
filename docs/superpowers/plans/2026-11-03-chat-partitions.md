# Chat Partitioning Implementation Plan

> Use the subagent-driven-development workflow for implementation and independent review.

**Goal:** Physically partition durable messages by channel while preserving existing history, identifiers, authorization, retries, attachments, and realtime replay.

**Architecture:** PostgreSQL hash partitioning with 16 fixed channel buckets. A narrow unpartitioned message identity registry preserves global UUID/task uniqueness and workspace-wide client-message idempotency, which cannot be enforced by partition-local indexes alone. Existing HTTP/Socket.IO contracts and immutable sequence values stay unchanged. Keep Redis as the notification transport and retain history indefinitely.

**Scope:** Partition `messages` and the corresponding `channel_events` replay log by the same channel key. Do not change UI, retention, or agent execution.

- [x] Add failing integration tests for partition metadata/routing, migration preservation, cross-partition uniqueness, attachment integrity, and query pruning.
- [x] Add migration 018. Copy rows under transactional maintenance locks; preserve all foreign keys/checks/indexes and rebuild row-type-dependent payload functions/triggers. Do not emit duplicate history events during backfill. Verify copies before removing old storage.
- [x] Maintain registry and message consistency transactionally. Keep global IDs, task-result uniqueness, and workspace/user/client retry keys; prevent identity/routing mutations and orphan registry rows. Preserve same-channel `ON CONFLICT DO NOTHING`; reject cross-channel global collisions.
- [x] Update Drizzle mappings and query routing. Ensure history, source-message lookup, and retry queries include or resolve the partition key.
- [x] Run backend tests and obtain spec then quality review. Use `EXPLAIN` to demonstrate one-partition history/replay access without claiming an unmeasured speedup.
- [x] Back up the local database, stop writers for the maintenance migration, apply it, compare message/event counts and content fingerprints, restart the server, and exercise real HTTP/Socket.IO behavior.
- [x] Run the full test suite, typecheck and build; document operational requirements and the limitation that a single hot channel stays in one partition.

The migration is a transactional copy/swap for the current local dataset, not an online production migration. Increasing the partition count later requires a planned redistribution. No commit or push is included.

## Local verification

- Migration 018 completed in 856 ms with writers paused. All 681 existing messages, 687 events, 18 channels and their counters retained identical content fingerprints; there were zero attached assets in this local dataset. Asset preservation is covered by the migration integration fixture.
- Both parent tables report `HASH (channel_id)` and 16 child partitions. Registry consistency check found zero missing or mismatched rows.
- Live HTTP/Socket.IO QA created 14 messages, verified a concurrent retry returns the same ID, a conflicting cross-channel retry returns 409, backward pages contain no duplicates, independent thread history works, and reconnect receives the missed event once.
- Live `EXPLAIN (ANALYZE, BUFFERS)` queries read `messages_p11` and `channel_events_p11` respectively. These small-dataset observations are pruning evidence, not a throughput benchmark.
- Final full suite: **376 tests passed** (124 backend, 131 web, 79 shared UI, 22 server, 20 connector), with 12 successful Turbo tasks. Build: 11 successful tasks. Typecheck: 19 successful tasks. Spec and quality reviews passed after fixing transactional registry delete/reinsert drift.
- Backup and reports: `/Users/kai/.codex-artifacts/space-partitions-2026-11-03/` (`before-partitions.dump`, `migration-verification.json`, `live-qa.json`). API and worker restarted successfully.
