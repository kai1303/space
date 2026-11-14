# Channel and message latency

November 14, 2026 · local macOS ARM64 · Node v25.2.1 · PostgreSQL 16 · NATS JetStream

Authenticated loopback clients used the API and its PostgreSQL WAL-to-NATS event bridge. Each run started with 100 messages in the shared channel. A separate authenticated user received realtime messages. The single-sender run had 20 waves. The four-sender run had 20 waves of four distinct users sending to the same channel. Channel creation, membership and archive operations used fresh channels. History reads requested 50 messages.

The threshold is strictly below 200 ms for every observed operation. Each percentile is computed separately per operation from successful observations using the nearest rank. Maxima and breach counts include the first wave. HTTP timings include body transfer. Peer latency ends when the matching message arrives over the recipient’s subscribed socket. These measurements exclude rendering, WAN transit and attachment traffic.

## Shared PostgreSQL WAL tuning

Two consecutive runs used the same shared `workplace` database (cluster identifier `7703863166444404769`), four users split two per API process, and a fifth user receiving messages on the first API. Both runs completed all 80 workflows. Each recorded 80 samples for every one of the 14 message operations and 10 channel operations. All 3,840 timings were below 200 ms, with zero errors or incomplete workflows.

| Run | Message timings below 200 ms | Slowest message operation | Max (ms) | Remove reaction max (ms) |
|---|---:|---|---:|---:|
| 1 | 1,120 / 1,120 | Socket send to peer | 160.5 | 109.8 |
| 2 | 1,120 / 1,120 | HTTP send to peer | 152.0 | 61.3 |

The shared development instance now compresses full-page WAL images with LZ4 and skips zero-filling new 16 MiB WAL segments. Its autovacuum cost limit is 50 with the existing 2 ms delay, reducing competition for storage while catalog vacuuming continues. These changes were applied with a configuration reload. Synchronous commit, fsync, full-page writes, and logical replication stayed enabled. The local Compose service carries the same tuning for newly created containers. The lower vacuum budget can lengthen cleanup, and the oldest replication slot still retained about 25 GB of WAL at verification time. [PostgreSQL WAL settings](https://www.postgresql.org/docs/16/runtime-config-wal.html) · [Vacuum cost settings](https://www.postgresql.org/docs/16/runtime-config-resource.html#RUNTIME-CONFIG-RESOURCE-VACUUM-COST)

Over the full workflow including setup and teardown, cluster counters recorded 36.5 MB of WAL and 5.60 s of cumulative WAL sync time in the control, then 24.0 MB / 4.41 s and 24.9 MB / 4.46 s after tuning. These counters include other database activity. The control also passed the latency gate, consistent with the intermittent stalls seen earlier. A separate diagnostic run on the tuned database recorded 3,302 successful explicit commits across both API processes. P95 was 4.3 ms and the maximum was 127.3 ms. That instrumentation covers client-observed explicit commits and excludes implicit commits.

The raw samples and before/after cluster counters are under `tests/test-results/operations/chat-4-2api-wal-tuned-{1,2}/`. The separate commit timings are in `tests/test-results/operations/chat-4-2api-wal-commit-trace/commits.json`. Reproduce each benchmark with `PERF_API_INSTANCES=2 PERF_CONCURRENCY=4 pnpm test:performance`.

## Shared-database verification after tracing the spikes

Both runs used the shared `workplace` PostgreSQL database and local JetStream. Each started two API processes and assigned senders to instances 1, 2, 1, 2. The receiver used instance 1. All 80 sender workflows completed in each run. Each message operation has 80 samples, including the first wave. The benchmark and database durability settings were unchanged.

| Run | Message timings <200 ms | Slowest message timing | Remove reaction max | Client-visible errors |
|---|---:|---|---:|---:|
| 1 | 1113 / 1120 | Reply in thread, 381.9 ms | 71.6 ms | 0 |
| 2 | 1120 / 1120 | Add reaction, 179.4 ms | 67.6 ms | 0 |

The first wave of run 1 had two HTTP peer deliveries over budget. In wave 12 three replies, one single-message read and one thread read exceeded 200 ms. All 1,600 channel measurements across the pair passed.

| Message operation | Run 1 p95 (ms) | Run 1 max (ms) | Run 1 ≥200 ms | Run 2 p95 (ms) | Run 2 max (ms) | Run 2 ≥200 ms |
|---|---:|---:|---:|---:|---:|---:|
| Add reaction | 53.2 | 122.1 | 0 | 104.1 | 179.4 | 0 |
| Delete | 74.4 | 123.5 | 0 | 76.4 | 123.4 | 0 |
| Edit | 58.5 | 131.6 | 0 | 86.4 | 150.2 | 0 |
| HTTP send to peer | 51.5 | 224.1 | 2 | 87.6 | 156.4 | 0 |
| Mark read | 18.3 | 48.0 | 0 | 24.4 | 46.3 | 0 |
| Read channel messages | 56.3 | 116.4 | 0 | 64.1 | 110.9 | 0 |
| Read one message | 11.7 | 216.9 | 1 | 15.5 | 19.0 | 0 |
| Read thread | 11.8 | 260.8 | 1 | 20.3 | 29.2 | 0 |
| Remove reaction | 38.0 | 71.6 | 0 | 52.8 | 67.6 | 0 |
| Reply in thread | 78.7 | 381.9 | 3 | 68.4 | 176.0 | 0 |
| Retry same send | 24.6 | 29.0 | 0 | 32.7 | 49.2 | 0 |
| Send (HTTP) | 49.1 | 179.8 | 0 | 59.9 | 150.5 | 0 |
| Send (socket ACK) | 47.9 | 116.6 | 0 | 54.7 | 93.5 | 0 |
| Socket send to peer | 57.6 | 149.2 | 0 | 69.3 | 100.9 | 0 |

The 1906.6 ms removal from the earlier run had only a client timing. In a separate pre-fix trace, a 451 ms removal reached `BEGIN` after 371 ms. The reaction row deletion took 0.8 ms and commit took 16.7 ms. Time before the transaction includes admission to the per-channel write queue and connection acquisition. The trace also recorded a send spending 931 ms waiting for its commit response. Another delete spent 328 ms in notification cleanup.

A reaction now changes the row, updates its revision, writes its notification and replay event, and produces the response in one database call inside the transaction. Message deletion batches independent cleanup and can use a message-ID index across notification kinds. New channel roots avoid computing a reply aggregate for a thread created in the same transaction. The event bridge buffers up to 16 events and 64 KiB in memory before spilling to disk. It publishes after commit and advances its replication checkpoint after acknowledged delivery.

A separate instrumented run on the final build captured a 554.8 ms delete. Its commit response took 479 ms. Two channel edits waited 482 ms and 490 ms for commit in the same interval. PostgreSQL reported four concurrent commits waiting on WAL sync or write while autovacuum read a system catalog. The independent database observer took 376 ms to return one sample. The local shared database reported roughly 7.1 million dead rows in `pg_attribute`, 12.8 million in `pg_depend`, and 25 GB of WAL retained by its oldest slot. The trace establishes a shared commit stall in that interval. It cannot attribute each breach from the uninstrumented runs to vacuum or storage. The timing and wait samples for the interval are in `tests/test-results/operations/chat-4-2api-shared-trace/commit-window.json`.

Intermediate pairs are retained under `tests/test-results/operations/chat-4-2api-spikes-{1,2}` and `chat-4-2api-spikes-final-{1,2}`. Their counts of message timings over budget were 0 / 35 and 7 / 0, respectively. The table above uses the two consecutive final-build reports under `tests/test-results/operations/chat-4-2api-shared-send-{1,2}/latency.json`.

## Cross-instance verification after the sequencing change

Four authenticated senders were pinned two per API process. Each of 20 waves started all four on the same channel. The subscribed recipient was on the first API. The benchmark, first-wave measurements and strict 200 ms gate were unchanged. The first pair used the usual shared PostgreSQL container. The second pair used a fresh, native PostgreSQL 16.15 cluster on the same Mac, with logical replication and default durable commits. Both used the same local NATS service and the same final API and event bridge builds.

| Database | Run | Completed workflows | Successful message timings | Message timings ≥200 ms | Slowest message operation | Maximum (ms) | Session conflicts | Overall gate |
|---|---:|---:|---:|---:|---|---:|---:|---|
| Shared container | 1 | 80/80 | 1120 | 14 | Socket send to peer | 380.6 | 0 | Fail |
| Shared container | 2 | 80/80 | 1120 | 10 | Remove reaction | 1906.6 | 0 | Fail |
| Dedicated native | 1 | 80/80 | 1120 | 0 | HTTP send to peer | 104.9 | 0 | Pass |
| Dedicated native | 2 | 80/80 | 1120 | 6 | Socket send to peer | 275.5 | 0 | Fail |

| Message operation | Shared run 1 p95 / max (ms) | Shared run 2 | Native run 1 | Native run 2 |
|---|---:|---:|---:|---:|
| Add reaction | 108.8 / 150.2 | 87.7 / 296.8 | 34.8 / 49.5 | 83.6 / 201.7 |
| Delete | 138.0 / 228.9 | 187.4 / 1621.4 | 45.9 / 78.8 | 75.6 / 222.7 |
| Edit | 103.5 / 164.2 | 109.6 / 146.8 | 33.9 / 57.8 | 55.6 / 146.4 |
| HTTP send to peer | 147.9 / 319.1 | 176.0 / 199.5 | 48.0 / 104.9 | 127.6 / 191.7 |
| Mark read | 39.1 / 87.8 | 38.9 / 280.7 | 9.4 / 17.0 | 24.0 / 28.9 |
| Read channel messages | 133.8 / 369.8 | 90.4 / 118.1 | 43.2 / 92.5 | 85.8 / 168.9 |
| Read one message | 24.2 / 37.6 | 22.8 / 37.8 | 8.9 / 14.1 | 26.0 / 56.0 |
| Read thread | 28.1 / 43.4 | 24.7 / 36.2 | 8.6 / 9.5 | 35.7 / 80.4 |
| Remove reaction | 120.8 / 168.0 | 106.0 / 1906.6 | 34.2 / 45.7 | 76.2 / 233.9 |
| Reply in thread | 102.3 / 124.1 | 68.3 / 127.6 | 24.1 / 39.1 | 60.7 / 188.5 |
| Retry same send | 70.9 / 171.9 | 78.3 / 118.7 | 16.6 / 58.5 | 49.5 / 112.7 |
| Send (HTTP) | 142.1 / 250.6 | 151.2 / 167.0 | 31.3 / 98.6 | 84.1 / 171.3 |
| Send (socket ACK) | 160.8 / 362.1 | 103.2 / 181.8 | 27.1 / 83.1 | 65.6 / 113.6 |
| Socket send to peer | 174.9 / 380.6 | 128.3 / 224.6 | 44.5 / 98.9 | 85.5 / 275.5 |

Ordinary channel writes use the atomic sequence update to establish their order across API processes. Sends verify posting rights and cancellation before commit. Edits check the expected revision. Read cursors advance on the individual member’s row. The event bridge batches cleanup only after JetStream acknowledges publication. In a separate instrumented shared-container run, individual database commits took up to 297 ms. That trace does not attribute every slow sample to a commit.

## Cross-instance baseline before the sequencing change

Both runs used two local API processes with independent database pools. Each API served two senders over HTTP and Socket.IO. The receiver subscribed on the first API. All four users sent to the same seeded channel in each of 20 waves.

| Run | Workflows completed | Successful timings | Timings ≥200 ms | Client-visible session conflicts | Peer timeouts |
|---|---:|---:|---:|---:|---:|
| 1 | 79/80 | 1899 | 64 | 1 | 1 |
| 2 | 80/80 | 1920 | 64 | 0 | 0 |

All latency figures are milliseconds.

| Operation | First p95 | First max | Repeat p95 | Repeat max |
|---|---:|---:|---:|---:|
| Send (HTTP) | 389.2 | 643.1 | 401.5 | 560.7 |
| HTTP send to peer | 390.7 | 645.3 | 412.9 | 575.1 |
| Send (socket ACK) | 142.3 | 226.3 | 282.7 | 472.0 |
| Socket send to peer | 152.5 | 237.8 | 293.4 | 475.2 |
| Reply in thread | 525.8 | 580.3 | 219.1 | 481.9 |

The strict latency gate failed in both runs. The same-channel write queue is local to each API process. Concurrent transactions from different processes can still compete for the channel event sequence and trigger serialization retries. Reproduce with `PERF_API_INSTANCES=2 PERF_CONCURRENCY=4 pnpm test:performance`.

## Four senders on one API after the fix

Two consecutive runs of `PERF_CONCURRENCY=4 pnpm test:performance` completed 80/80 workflows apiece. All 3,840 timings across the two runs were below 200 ms, including the first wave and the recipient socket. Both runs had zero request errors, peer timeouts and failed workflows.

All figures are milliseconds. Each run recorded 80 timings per row.

| Operation | First p95 | First max | Repeat p95 | Repeat max |
|---|---:|---:|---:|---:|
| Channels / Add member | 29.1 | 40.4 | 25.3 | 44.0 |
| Channels / Archive | 22.1 | 24.9 | 19.6 | 27.3 |
| Channels / Create | 37.0 | 125.3 | 19.3 | 49.5 |
| Channels / Edit topic | 24.5 | 39.4 | 19.6 | 94.7 |
| Channels / Join | 22.5 | 33.5 | 18.2 | 29.5 |
| Channels / List | 11.3 | 21.6 | 9.6 | 11.4 |
| Channels / List members | 10.0 | 14.8 | 9.5 | 13.6 |
| Channels / Open details | 13.8 | 19.1 | 10.8 | 19.0 |
| Channels / Remove member | 24.4 | 35.9 | 15.7 | 18.9 |
| Channels / Restore | 19.5 | 26.3 | 15.8 | 18.6 |
| Messages / Add reaction | 75.9 | 137.2 | 59.4 | 85.0 |
| Messages / Delete | 75.2 | 101.6 | 62.8 | 71.0 |
| Messages / Edit | 66.6 | 151.1 | 54.9 | 84.4 |
| Messages / HTTP send to peer | 69.2 | 105.1 | 73.3 | 83.2 |
| Messages / Mark read | 36.9 | 63.6 | 27.2 | 31.9 |
| Messages / Read channel messages | 69.1 | 96.4 | 45.5 | 114.7 |
| Messages / Read one message | 11.8 | 23.3 | 9.8 | 12.6 |
| Messages / Read thread | 12.8 | 25.5 | 9.2 | 11.5 |
| Messages / Remove reaction | 73.0 | 151.3 | 56.8 | 87.5 |
| Messages / Reply in thread | 58.6 | 92.6 | 43.8 | 53.9 |
| Messages / Retry same send | 46.7 | 74.2 | 38.4 | 40.6 |
| Messages / Send (HTTP) | 59.7 | 84.9 | 57.4 | 80.7 |
| Messages / Send (socket ACK) | 64.1 | 83.0 | 57.7 | 80.2 |
| Messages / Socket send to peer | 77.3 | 94.2 | 71.6 | 97.1 |

Four concurrent send transactions competed to advance one channel sequence. A four-wave diagnostic run recorded 35 serialization failures at message insertion. The old send path could sleep 1.5–3 seconds across four retries before returning `session_conflict`. The API now admits overlapping writes per channel before taking their transaction snapshots. PostgreSQL still enforces serializable sends and durable idempotency across API instances.

Message and thread projections reuse cached database plans. Unrelated channel changes can now advance a workspace subscription revision through separate counters. The subscription reads their committed sum, including the pre-migration value. This removed a second source of retries that affected message deletes while other users managed channels. A combined membership lookup and shorter bounded backoff for join and add-member requests reduced the remaining overhead.

## Baseline before the fix

| Run | Completed sender workflows | Observations | Observations ≥200 ms | Failed observations |
|---|---:|---:|---:|---:|
| 1 sender | 20/20 | 480 | 1 | 0 |
| 4 senders | 74/80 | 1806 | 171 | 9 |

## Timings in milliseconds

Each row shows an individual operation. The last column in each group counts successful samples that took 200 ms or longer. The sender response and peer delivery measure the same send from two perspectives.

| Area / operation | 1 sender n | p50 | p95 | Max | ≥200 | 4 senders n | p50 | p95 | Max | ≥200 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Channels / Add member | 20 | 10.0 | 16.5 | 16.8 | 0 | 74 | 9.7 | 17.8 | 89.8 | 0 |
| Channels / Archive | 20 | 10.7 | 13.4 | 13.6 | 0 | 74 | 10.9 | 16.4 | 25.7 | 0 |
| Channels / Create | 20 | 11.6 | 14.5 | 17.8 | 0 | 74 | 11.9 | 42.8 | 55.1 | 0 |
| Channels / Edit topic | 20 | 10.7 | 14.2 | 16.2 | 0 | 74 | 10.7 | 19.3 | 35.7 | 0 |
| Channels / Join | 20 | 7.9 | 9.6 | 14.3 | 0 | 74 | 8.0 | 17.4 | 49.1 | 0 |
| Channels / List | 20 | 5.4 | 7.3 | 7.5 | 0 | 74 | 6.0 | 14.0 | 49.5 | 0 |
| Channels / List members | 20 | 5.3 | 6.4 | 12.9 | 0 | 74 | 5.3 | 8.1 | 18.4 | 0 |
| Channels / Open details | 20 | 6.6 | 7.2 | 13.3 | 0 | 74 | 6.6 | 10.7 | 49.6 | 0 |
| Channels / Remove member | 20 | 7.2 | 13.1 | 16.9 | 0 | 74 | 7.7 | 13.8 | 24.4 | 0 |
| Channels / Restore | 20 | 9.4 | 10.2 | 13.4 | 0 | 74 | 9.8 | 16.1 | 30.3 | 0 |
| Messages / Add reaction | 20 | 43.4 | 47.8 | 64.1 | 0 | 74 | 43.6 | 62.4 | 89.3 | 0 |
| Messages / Delete | 20 | 43.8 | 50.9 | 51.6 | 0 | 74 | 46.5 | 141.9 | 348.8 | 2 |
| Messages / Edit | 20 | 50.4 | 57.3 | 57.7 | 0 | 74 | 51.0 | 268.6 | 646.3 | 4 |
| Messages / HTTP send to peer | 20 | 65.3 | 75.1 | 104.6 | 0 | 78 | 288.6 | 2473.0 | 2658.1 | 58 |
| Messages / Mark read | 20 | 10.3 | 13.5 | 17.7 | 0 | 74 | 12.0 | 49.7 | 82.6 | 0 |
| Messages / Read channel messages | 20 | 43.6 | 53.9 | 291.6 | 1 | 77 | 48.2 | 70.1 | 100.6 | 0 |
| Messages / Read one message | 20 | 22.8 | 40.4 | 132.8 | 0 | 77 | 22.8 | 29.3 | 32.8 | 0 |
| Messages / Read thread | 20 | 6.4 | 8.8 | 9.5 | 0 | 77 | 6.1 | 10.2 | 13.8 | 0 |
| Messages / Remove reaction | 20 | 39.7 | 49.2 | 67.2 | 0 | 74 | 41.3 | 75.7 | 93.3 | 0 |
| Messages / Reply in thread | 20 | 42.6 | 56.7 | 56.9 | 0 | 77 | 44.9 | 1214.3 | 2911.7 | 17 |
| Messages / Retry same send | 20 | 22.4 | 29.0 | 65.3 | 0 | 78 | 23.4 | 40.0 | 111.3 | 0 |
| Messages / Send (HTTP) | 20 | 41.0 | 49.7 | 80.1 | 0 | 78 | 254.9 | 2438.8 | 2635.0 | 54 |
| Messages / Send (socket ACK) | 20 | 40.3 | 45.9 | 47.4 | 0 | 77 | 45.4 | 1164.0 | 2345.9 | 17 |
| Messages / Socket send to peer | 20 | 66.9 | 73.1 | 74.0 | 0 | 77 | 70.5 | 1197.3 | 2375.1 | 19 |

## Errors with 4 senders

- Send (HTTP) failed 2 times. Send (HTTP) {"error":"session_conflict"}
- Edit failed 3 times. Edit {"error":"session_conflict"}
- HTTP send to peer failed 2 times. Peer delivery timed out
- Send (socket ACK) failed once. message.send: session_conflict
- Socket send to peer failed once. Peer delivery timed out
- Six sender workflows ended early. Three peer timeouts tracked the same three rejected sends.

The benchmark reports the observed threshold and exits nonzero on any breach or failed workflow. Reproduce the runs with `pnpm test:performance` and `PERF_CONCURRENCY=4 pnpm test:performance`. [Benchmark instructions](../../tests/evaluation/operations/README.md)
