# Application operation latency

November 14, 2026. The target is a nearest-rank P95 strictly below 200 ms for each operation. Errors, missing routes, and operations with too few observations fail verification independently. Timings include HTTP response-body transfer and, when named, receipt on the peer socket. The eight-sender chat test uses the shared channel and two API processes. The broad test uses four concurrent workflows across 20 isolated workspaces on one API. Both use the same local shared PostgreSQL database. Compare results within each workload.

## Attachment completion

The server fetched staging bytes, conditionally wrote the sealed original, checked its size again, and then fetched the original to generate the preview. On a successful conditional write, the response confirms which bytes won. The server now passes that buffer directly to preview generation. An existing original or a losing writer still uses the sealed object for the preview. Encrypted attachments continue to skip preview generation.

| Attachment operation | Before P95 (ms) | After P95 (ms) | Samples per run |
|---|---:|---:|---:|
| Attach 25 MiB and send | 2901.5 | 1023.3 | 20 |
| Attach PNG and send | 617.0 | 343.6 | 20 |
| Complete 25 MiB | 1373.6 | 683.6 | 20 |
| Complete audio | 308.3 | 77.9 | 20 |
| Complete DOCX | 329.5 | 68.4 | 20 |
| Complete encrypted | 170.3 | 46.1 | 20 |
| Complete PDF | 143.2 | 121.5 | 20 |
| Complete PNG | 333.7 | 231.6 | 20 |
| Complete text | 525.6 | 74.6 | 20 |
| Complete unsupported | 462.5 | 89.3 | 20 |
| Complete video | 573.2 | 125.9 | 20 |

Both runs completed 20 workflows. The verified implementation retains the destination-size check after conditional writes. Its run measured 240 operations, including 22 additional operations at the end of each workflow. 10 operation P95s exceeded the target. The before and after counts of failed cold PDF thumbnail requests were 2 and 2. Each failure also appears under the enclosing download. The storage and preview unit suites passed all 19 tests. The real SeaweedFS integration checks exercised sealed originals, previews and retries. Timings reflect shared-host load as well as the change. Raw reports are under `tests/test-results/operations/app-p95-baseline/` and `app-p95-verified/`.

## Coverage and eight-sender baseline

The original broad benchmark registered nine selected API modules on a collector. The revised benchmark observes routing on the actual Fastify instance. It found 382 HTTP method/path combinations including automatic HEAD routes and the benchmark's seven individually tracked authentication flows. The initial workload exercised 147 of these. Socket operations and file transfer timings are additional observations. The optional `PERF_METRIC=p95` applies the percentile threshold per operation and preserves all raw samples and failures.

On the eight-sender shared-channel baseline, P95 exceeded 200 ms for add reaction, delete and edit in run 1, and for HTTP send, HTTP delivery to peer and socket delivery to peer in run 2. Channel creation or member addition returned three session conflicts in each run. Raw data is under `tests/test-results/operations/chat-8-2api-shared-{1,2}/`.

The verified broad workload exercised 169 HTTP method/path combinations. 213 remain, including 115 HEAD routes. The report lists each missing route. Service health, Agent Sessions discovery, Navigator reads and the Todo sync credential/import/receipt flow now run through the API for each workspace.

| Operations remaining at or above 200 ms P95 | Samples | P95 (ms) |
|---|---:|---:|
| Attachments / Attach 25 MiB and send | 20 | 1023.3 |
| Attachments / Attach PNG and send | 20 | 343.6 |
| Attachments / Complete 25 MiB | 20 | 683.6 |
| Attachments / Complete PNG | 20 | 231.6 |
| Attachments / Generate Office thumbnail | 20 | 2020.1 |
| Attachments / Generate PDF thumbnail | 18 | 1366.8 |
| Attachments / Generate PDF thumbnail redirect | 18 | 1365.0 |
| Attachments / Upload bytes 25 MiB | 20 | 291.2 |
| Channels / Post incoming webhook | 20 | 251.0 |
| Messages / Send to peer delivery | 20 | 201.1 |

## Concurrent channel membership

With eight senders on two APIs, a database trace recorded serialization failures during channel membership inserts and at commit. After exhausting the transaction retry budget, the API returned HTTP 409 with `session_conflict`. Channel creation, member addition and joining now read fewer rows or make fewer permission queries inside the serializable transaction. Managers skip the workspace preferences lookup when their role already grants the action. The 26 membership, settings and permission tests passed, including concurrent revocation.

| Channel operation | Before P95, runs 1 / 2 (ms) | After P95, runs 1 / 2 (ms) |
|---|---:|---:|
| Create | 94.1 / 77.0 | 148.1 / 127.7 |
| Add member | 87.7 / 56.6 | 106.2 / 74.0 |
| Join | 82.2 / 52.6 | 79.4 / 43.9 |

Each run attempted 160 sender workflows. Conflicts fell from 3 / 3 to 2 / 1 in these samples. Create and add-member P95 increased, and the shortened transactions still exhausted retries. The after reports are in `tests/test-results/operations/app-p95-chat-members-{1,2}/`.

## Eight-sender maximum-latency check

Two consecutive runs each used 20 waves, four senders per API process, one shared database and one common message channel. All 14 message operations returned 160 timings in both runs. Sender and receiver timings overlap. The single conflict in run 1 occurred during channel member addition after the message operations finished. HTTP send to peer was the slowest observation in both runs. Raw reports are in `tests/test-results/operations/chat-8-2api-max-check-20261114-{1,2}/latency.json`.

| Run | Message timings | At or above 200 ms | Slowest (ms) | Remove reaction max (ms) | Session conflicts | Completed workflows |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 2240 | 6 | 211.9 | 135.6 | 1 | 159 / 160 |
| 2 | 2240 | 66 | 457.8 | 426.9 | 0 | 160 / 160 |

## PDF font configuration

The local Poppler process emitted a Fontconfig error on every render. Setting `FONTCONFIG_FILE` to this host's installed configuration reduced repeated first-page rendering of the same two-page fixture from 419–429 ms to 60–67 ms. The cold HTTP thumbnail P95 moved from 1366.8 ms (18 successful samples) to 296.1 ms (19). Two of 20 cold requests returned HTTP 503 before the change and one did afterward. Poppler still admits two jobs at a time per API. Those requests retain the existing retryable overload response. The cached download P95 moved from 117.0 to 34.7 ms. These runs used the same renderer concurrency and input. See `app-p95-verified` and `app-p95-fontconfig` under the results directory. The setting applies to this local benchmark host.

## Large attachment completion

Previously, sealing a 25 MiB attachment read its entire staging object into the API and sent those same bytes back to SeaweedFS. The API now requests a server-side copy for assets of 1 MiB or larger, pins the staging ETag, and requires a previously absent destination. The API checks the final size and generates previews from the sealed original. Smaller objects use the existing conditional upload and reuse its buffer. The source and destination conditions were exercised against the local SeaweedFS, and the integration test ran two different staging objects through concurrent completion at the same destination.

| Operation | Before P95 (ms) | After P95 (ms) | Samples per run |
|---|---:|---:|---:|
| Complete 25 MiB | 1347.8 | 305.5 | 20 |
| Attach 25 MiB and send | 2391.5 | 875.0 | 20 |
| Upload bytes 25 MiB | 828.7 | 392.3 | 20 |

Upload happens directly against SeaweedFS before completion. Its variation across runs illustrates the effect of shared-host load. The storage, preview, and PDF suites passed all 25 checks. Compare `app-p95-fontconfig` and `app-p95-storage-copy` in the results directory. The latter completed 20 workflows with zero errors and had 13 operation P95s at or above 200 ms. The S3 copy uses both conditions supported by the [CopyObject API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html).

## Membership query-plan experiment

On the eight-sender, two-API shared database, EXPLAIN ANALYZE showed primary-key lookups of `channel_members(channel_id,user_id)` on both join and permission reads. A trial skipped the prior membership read for public channels and relied on the existing unique constraint to handle repeat joins. It retained serializable transactions and passed 40 integration tests, including workspace revocation racing the join. It did not improve observed join P95. The trial was reverted.

| Eight-sender result | Baseline | Trial 1 | Trial 2 |
|---|---:|---:|---:|
| Join P95 (ms) | 50.6 | 81.0 | 120.7 |
| Serialization failures at membership INSERT | 39 | 28 | 35 |
| Serialization failures at COMMIT | 60 | 63 | 97 |
| Client-visible session conflicts | 0 | 1 | 1 |

All three runs used the same per-process PostgreSQL error instrumentation and 160 attempted sender workflows. Counts at COMMIT can involve other operations. See `chat-members-plan-baseline` and `chat-members-index-{1,2}`. During the second trial a database snapshot showed WALSync, WALWrite, and a sender waiting on the channel sequence update. The host's one-minute load average was 37. PostgreSQL estimated 13.3 million dead catalog tuples in pg_depend and 7.3 million in pg_attribute. A read-only inventory found 16 inactive replication slots across the cluster, with as much as 26 GB of retained WAL measured from a single slot. Catalog retention spans databases, while test schema creation and deletion add catalog churn. These observations do not isolate the cause of any single slow request. The existing slots are intact.

## Memory and workspace route coverage

The `app-p95-memory` run exercised 258 operations in 20 completed workflows. All 16 channel/thread Memory operations, the workspace workflow list and Huddles configuration were below 200 ms P95. The slowest newly covered operation was enabling channel knowledge at 157.3 ms. This measures the built-in Markdown provider. Across the entire run, 27 operation P95s missed the target, one cold PDF thumbnail returned HTTP 503, and 195 registered HTTP methods still lacked a successful sample.

## Inspecting large originals by range

After server-side copy, preview classification still downloaded the entire sealed 25 MiB object before inspecting its type. The classifier now reads ranges on demand, using the existing file-type detector with the actual object size. It can seek to container signatures beyond the first page. Adjacent reads reuse a 64 KiB window. A fourth storage read or a large request falls back to one full read. Raster decoding and text validation still consume the complete original, and storage failures remain retryable.

| Operation | Before P95 (ms) | After P95 (ms) | Samples per run |
|---|---:|---:|---:|
| Complete 25 MiB | 427.1 | 76.7 | 20 |
| Attach 25 MiB and send | 1250.8 | 388.4 | 20 |
| Upload bytes 25 MiB | 555.3 | 276.4 | 20 |

Compare `app-p95-memory` and `app-p95-range`, both with four concurrent workflows, 20 workspaces, and 258 measured operations. The latter completed all workflows. Seven operation P95s missed 200 ms, and one cold PDF thumbnail returned HTTP 503. The storage and preview suites passed all 22 checks. A targeted test verified a large unsupported binary used only range reads, a mislabeled PDF remained recognizable, and text with invalid UTF-8 in the last byte was rejected.

## HEAD coverage and Office revision headers

A separate protocol pass sends HEAD to each registered route after an authorized GET on a live fixture. The original Office revision HEAD returned 401 on 20 of 20 requests because the generic cookie-authentication hook admitted only GET to the Office service-token handler. The route now verifies the same signed download token and URL binding for both methods. HEAD reads the byte count from PostgreSQL. The first implementation passed authentication but Fastify's automatic HEAD wrapper replaced the declared size with zero. Registering both methods explicitly preserved the actual Content-Length. The integration test also verifies an empty body, HTTP 401 with no credential, and HTTP 403 for a token bound to another URL.

| Office revision HEAD | Before | After |
|---|---:|---:|
| Correct responses | 0 / 20 | 20 / 20 |
| Successful request P95 | unavailable | 5.3 ms |

The verified protocol pass timed 89 HEAD operations below 200 ms P95 and covered 275 of 382 registered method/path combinations overall. One cold PDF thumbnail returned HTTP 503. Raw reports are `app-p95-heads`, `app-p95-heads-office` and `app-p95-heads-verified`. Normal latency runs omit the extra HEAD requests.

## Agent Sessions lifecycle coverage

The expanded protocol workload exercised real paired installations, thread and channel session creation, session lookup, models, resources, team, rename, sidebar archive, end/reopen, memory lookup, and connection revocation. It also checked cancelled pairing, vault discovery, and DM call history. It ran 20 workflows with zero request errors. All 28 newly measured operations (including associated HEAD routes) had at least 20 observations and were below 200 ms P95. The slowest new operation was creating a channel session at 28.3 ms. It exercised 302 of 382 registered HTTP method/path combinations and timed 375 named operations. There are 80 missing method/path combinations.

| P95 misses in this coverage pass | P95 (ms) |
|---|---:|
| Generate Office thumbnail | 1055.7 |
| Attach 25 MiB and send | 626.5 |
| Upload bytes 25 MiB | 415.0 |
| Attach PNG and send | 264.5 |
| Post incoming webhook | 260.6 |
| Generate PDF thumbnail | 201.4 |

See `tests/test-results/operations/app-p95-agents/latency.json`. This broad workload includes HEAD probes. Use the separate eight-sender and ordinary broad reports for their respective workloads.

## Cold Office conversion and PNG encoding

The Office trace measured the real document service for 20 new DOCX attachments, followed by a second request for each unchanged revision. Cold thumbnail P95 was 2043.0 ms end to end. Waiting for the conversion HTTP response accounted for 2010.1 ms P95, and retrieving the resulting PNG headers took 2.5 ms P95. Reopening the same revision measured 22.2 ms end to end. The converter already reuses the revision key. A second application cache would only address repeated loads. The converter's upstream implementation has a timed wait for synchronous conversions. [Converter implementation](https://github.com/ONLYOFFICE/server/blob/master/DocService/sources/converterservice.js)

For the 1200×700 PNG fixture, lowering WebP encoding effort from 4 to 2 kept quality, pixel dimensions and format settings. In 15 local encodes median display-image CPU-path wall time went from 33.3 to 19.0 ms and the derivative grew from 17,552 to 18,648 bytes. All ten preview tests passed. The complete-PNG HTTP P95 moved from 98.4 to 185.5 ms and attach-and-send moved from 210.5 to 328.9 ms in the adjacent broad runs. This experiment established faster encoding but no end-to-end latency gain on this host. Reports are `app-p95-office-stages` and `app-p95-webp`.

## Incoming webhook retries

The PostgreSQL trace found 25 attempts for 20 successful incoming requests. Five attempts hit serialization failures. The first backoff alone could add 100–200 ms. Shortening the initial delay to 5 ms retained the same serializable transaction, exponential jitter, five-attempt bound, permissions, rate limit and unique idempotency checks. The focused integration test verified concurrent duplicate delivery created one message, conflicting reuse returned HTTP 409 and revoked webhooks stopped working.

| Incoming webhook | Before | After |
|---|---:|---:|
| Successful requests | 20 | 20 |
| P95 (ms) | 337.1 | 120.0 |
| Serialization failures retried | 5 | 6 |

Reports are `app-p95-webp` and `app-p95-webhook-5`. Both ran four overlapping workflows on the shared database. The after workload also exercised outbound connections later in each workflow.

## Cold PDF rasterization

Poppler previously compressed the first page to a temporary PNG and Sharp decoded it to produce the WebP thumbnail. Poppler now emits the RGB pixels on stdout. The API checks the dimensions, bit depth and exact payload length before passing the raster to Sharp. The first page, maximum dimensions, two-conversion limit, timeout and final WebP output stay the same.

| Measurement | Before P95 (ms) | After P95 (ms) |
|---|---:|---:|
| Renderer with in-memory storage, 20 renders in pairs | 205.4 | 123.7 |
| Cold HTTP thumbnail, successful requests | 344.5 (19/20) | 375.7 (20/20) |

The before HTTP run was `app-p95-webhook-5`. One request received HTTP 503 when both renderer slots were busy. The after run was `app-p95-huddles`. Its one failed workflow hit a later attachment send with HTTP 409. A subsequent run, `app-p95-tasks`, measured 262.4 ms for 17 successful cold PDF requests, with three HTTP 503 responses. The isolated renderer improved. End-to-end cold PDF latency and overload remain open.

## Large direct uploads

SeaweedFS received a multipart form for each large file. An alternating comparison uploaded the same 25 MiB payload through signed form POST and signed raw PUT, two concurrent transfers per batch and 20 samples per method. Raw PUT reduced P50 from 199.9 to 142.0 ms and P95 from 310.0 to 233.6 ms. The API now also signs PUT URLs for files of at least 1 MiB. Both the web client and benchmark use that URL when present. SeaweedFS integration checks verified successful exact-size transfer, rejection of undersize, oversize and changed media type, expiration within the reservation deadline, and browser origin preflight.

| Broad workload, 20 requests per operation | Form POST P95 (ms) | Direct PUT P95 (ms) |
|---|---:|---:|
| Upload bytes, 25 MiB | 341.9 | 482.3 |
| Complete 25 MiB | 151.5 | 536.8 |
| Attach 25 MiB and send | 534.4 | 1155.2 |

These are `app-p95-tasks` and `app-p95-direct-upload-1`. Both completed all 20 workflows on one API with four concurrent workflows and HEAD probes. The full workflow regressed in the first verification. The downstream completion and PDF rendering times also rose. The storage comparison alone does not establish an end-to-end improvement.

## Expanded integration coverage

The task, Sidekick, Huddles, connection and team lifecycle workload reached 351 of 385 registered methods and paths and timed 425 named operations in `app-p95-tasks`. Every Huddle uses a real local LiveKit room. Connection discovery uses the real Space gateway and an isolated loopback MCP upstream. The task lifecycle proposes and rejects a task. Connector execution, real external network transit and physical media delivery require separate evidence.

## Asset authorization round trips

A 100-read trace on the shared cluster, with four concurrent authorized readers, counted 100 BEGINs, 200 SELECTs and 100 COMMITs. Each read loaded the asset and checked active workspace and channel membership separately. The API now joins both membership rows when it loads the asset, using one statement snapshot. It still checks ready state, expiry, attachment ownership and authorizes again after conversion. All 100 reads then completed with one SELECT each. The isolated lookup P50 fell from 6.5 to 2.9 ms and P95 fell from 20.0 to 4.7 ms.

| Broad HTTP P95 (ms) | Before | After |
|---|---:|---:|
| Original image | 52.2 | 115.2 |
| Image thumbnail | 40.2 | 57.9 |
| Cached PDF thumbnail, 19 observations each | 69.3 | 566.1 |
| Cold PDF thumbnail, 19 observations each | 505.7 | 797.0 |

These shared-host runs were `app-p95-direct-memory` and `app-p95-asset-access`. Both completed 20 workflows, with one PDF request rejected at capacity. The HTTP results did not replicate the isolated query gain. In the earlier run the direct 25 MiB transfer measured 248.4 ms P95, and in the later run 402.2 ms. The shared database reported 7.6 million estimated dead tuples in pg_attribute, 13.8 million in pg_depend and an oldest slot retaining 27 GB of WAL. At one observation three autovacuum workers were active. These concurrent activities make adjacent endpoint results variable.

The broad runs included 22 Memory MCP operations, covering handshake, discovery and all 16 named tools for channel, installation and thread grants. Each was exercised 20 times. The first run had one MCP miss, listing thread tools at 246.8 ms. Both suites timed 449 operations and covered 352 of 387 registered method/path combinations. The HTTP totals count each route once even when it supports multiple MCP tools.

## Eight senders and database history

Two consecutive runs on the existing shared database and two on a freshly initialized PostgreSQL 16 control each used four senders per API, one common populated channel and 20 waves. Both clusters used filesystem-backed Docker volumes, logical replication, synchronous commit, fsync, full-page writes, LZ4 WAL compression, and the same WAL and autovacuum settings described in the chat latency report. The control ran on the same busy host and used its own data volume. The existing cluster identifier was 7703863166444404769 and the control identifier was 7708062503886589992.

| Database and run | Completed / 160 | Slowest message P95 (ms) | Maximum message time (ms) | Message observations ≥200 ms / 2240 | Session conflicts |
|---|---:|---|---:|---:|---:|
| Existing 1 | 160 | Socket send to peer, 237.2 | 438.7 | 77 | 0 |
| Existing 2 | 159 | Edit, 263.3 | 578.8 | 93 | 1 |
| Fresh control 1 | 159 | HTTP send to peer, 494.8 | 1403.0 | 227 | 1 |
| Fresh control 2 | 160 | Delete, 529.3 | 1420.2 | 139 | 0 |

Both 409 responses occurred during add member, after message timings were collected. A fresh catalog and replication slot did not eliminate membership conflicts or message latency spikes. These control runs cannot isolate shared host or storage contention. Raw reports are `chat-8-current-shared-{1,2}` and `chat-8-clean-control-{1,2}`.

The broad fresh-database control completed 20/20 workflows and timed 449 operations, of which 24 missed 200 ms P95. Its raw report is `app-p95-clean-control`. Storage and grant verification included a real Chromium XHR with a 1 MiB file from the configured web origin, a successful cross-origin PUT and a subsequent byte check. All 52 asset, DM and channel-permission integration tests passed, including membership revocation during PDF rendering.

## Reaction admission and database round trips

In an eight-wave diagnostic run on the shared database, 128 add/remove reaction requests across both API processes spent 500.0 ms P95 waiting for their local channel write queue and 49.4 ms P95 executing after admission. The two percentiles describe separate distributions. Previously an ordinary-channel reaction read the channel kind, began a transaction, applied the reaction and committed. The ordinary-channel path now checks the kind and applies the reaction in one database statement. It keeps the existing queue, durable commit and bounded retry policy. Direct messages retain their serializable transaction.

| Eight-sender check | Before 1 | Before 2 | After 1 | After 2 |
|---|---:|---:|---:|---:|
| Add reaction P95 (ms) | 168.3 | 262.9 | 131.3 | 434.5 |
| Remove reaction P95 (ms) | 190.0 | 177.9 | 128.1 | 780.9 |
| Remove reaction maximum (ms) | 293.5 | 449.5 | 137.8 | 1322.5 |
| Message observations ≥200 ms / 2240 | 77 | 93 | 13 | 507 |
| Add-member HTTP 409s | 0 | 1 | 1 | 0 |

The two after runs went in opposite directions. Fewer round trips did not establish a reproducible endpoint latency improvement. Raw runs are `chat-8-current-shared-{1,2}` and `chat-8-single-reaction-{1,2}`. The queue diagnostic is `chat-8-queue-breakdown`. Three focused integration cases passed for duplicate reactions across writers, per-user replay and authorization, and concurrent direct-message sends, replies and reactions.

## Workspace revision counter contention

The database logs provide more detail than the HTTP error. A channel membership insert also enqueues chat delivery and increments a durable workspace revision. PostgreSQL named the upsert into `workspace_revision_counters` in some serialization errors. Others surfaced while writing the membership, read or delivery rows, or at commit. The workload sends all messages to one populated channel. Its membership phase puts the same observer into a different, newly created channel per sender.

Migration 149 selects one of the existing 64 counter rows by transaction ID. Previously each backend always selected the same bucket by process ID. A new transaction can now select another bucket even on the same pooled connection. The revision remains a sum of committed increments. A focused integration test passed for pre-existing revision values, visibility before and after commit, and rollback.

| Eight senders, four per API | Before 1 | Before 2 | After 1 | After 2 |
|---|---:|---:|---:|---:|
| Logged serialization failures naming the counter upsert | 2 | 50 | 2 | 0 |
| Of those, outer statement inserted channel membership | 2 | 16 | 2 | 0 |
| Add member P95 (ms) | 63.0 | 211.4 | 60.7 | 51.6 |
| Slowest message operation P95 (ms) | 192.0 | 1527.8 | 449.2 | 364.5 |
| Maximum message timing (ms) | 258.9 | 3539.3 | 1093.9 | 715.1 |
| Remove reaction P95 (ms) | 128.1 | 780.9 | 223.8 | 153.6 |
| Message observations ≥200 ms / 2240 | 13 | 507 | 149 | 138 |
| Client-visible conflicts | 1 add member | 0 | 1 join | 0 |

Raw reports are `chat-8-single-reaction-{1,2}` and `chat-8-tx-counter-{1,2}`. Log counts are from the shared PostgreSQL server during the measured windows and match the respective counter expression. They include retried transactions and can include other activity. The two after runs completed 159 and 160 of 160 workflows, respectively. The counter change reduced observed contention at that statement. A join still exhausted its retries and both runs missed the message latency target.
