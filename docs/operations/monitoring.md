# Monitor a self-hosted Space installation

The operator can turn on Prometheus metrics and Loki logs together for the single-host Docker Compose stack. Grafana displays both. The base installation starts with collection off. The Compose stack uses its existing PostgreSQL and NATS volumes when monitoring is enabled.

## Enable

From the repository root, add this line to the deployment's `.env` on Linux or macOS. If the installation already sets `COMPOSE_FILE`, append `:compose.monitoring.yaml` to its existing file list. Keep the same Compose project name and working directory used to start Space.

```dotenv
COMPOSE_FILE=compose.yaml:compose.monitoring.yaml
```

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps -a
```

Applying the override recreates the API, event bridge and worker to enable instrumentation and their logging drivers. Expect clients to reconnect briefly. The one-shot `infra-db-init` should exit with status 0. It provisions a generated database credential on new and existing installations. The collector can read the outbox creation time and replication slot state. It uses read-only mounts of the PostgreSQL and NATS data volumes to measure filesystem capacity.

Open [Grafana](http://127.0.0.1:53001) as `admin`. Read the generated initial password locally with the following command and change it after signing in.

```sh
docker compose exec grafana cat /var/lib/grafana/.initial-admin-password
```

The **Space operations** dashboard shows chat throughput, confirmed receipt latency and agent turn phases alongside HTTP traffic, outbox age, storage and service health. In **Explore**, select **Space metrics** for PromQL or **Space logs** for LogQL. For remote access, forward the Grafana port over SSH, for example `ssh -L 53001:127.0.0.1:53001 operator@space-host`. The operator interfaces bind to loopback. Keep the Docker network and control of the host restricted to trusted services and operators.

## Verify collection

1. Open [Prometheus targets](http://127.0.0.1:59090/targets). The API, event bridge, infrastructure exporter and monitoring services should be up after startup. Query `space_infra_source_up` and check that the API, PostgreSQL, NATS and disk sources each return 1.
2. Query `sum by (route) (increase(space_api_http_requests_total[5m]))` for completed HTTP requests. To verify chat throughput and live delivery, use the two-user check below.
3. In **Space logs**, query `{service_name=~"space-(server|worker|events)"}`. Service startup and supported failure events have stable names, such as `worker_ready` and `cdc_interrupted`. API completions include the method, status and duration. For example, `{service_name="space-server"} | json | msg="http_request_completed" | statusCode >= 500` finds completed HTTP requests that returned a server error. Routine readiness probes are excluded from the access logs. Use the dashboard time selector to investigate the interval around an alert.

## Application signals

**Throughput.** In the **Space metrics** data source, query
`sum(rate(space_chat_messages_created_total[5m]))` for messages per second.
The counter advances when the CDC bridge publishes and retires the creation
event for a newly committed message. Edits, search backfills, idempotent retries
and delivery to additional recipients do not increase it. A stalled bridge
reports a delayed burst on recovery. Use the oldest unpublished event gauge
alongside throughput to distinguish an idle installation from a delayed bridge.
This is a process counter sampled by Prometheus. A short-lived process can
exit between scrapes, so use the rate for operations rather than billing.

**Time to first confirmed receipt.** Open the same channel in two signed-in
browser sessions belonging to different users. Once both are live, send a
message from one and check that it appears in the other. After the next
scrape, `sum(space_chat_live_confirmed_receipt_seconds_count)` should increase.
The sending browser starts its monotonic clock when Send submits the message
command, before the local socket queue, and stops when it receives confirmation
from the first live recipient. The duration includes the return acknowledgment. A user
reading the message later, another tab of the sender, and history fetched on
reconnect do not produce confirmations.

For p95 over five minutes, use
`histogram_quantile(0.95, sum by (le) (rate(space_chat_live_confirmed_receipt_seconds_bucket[5m])))`.
The dashboard also shows p50 and p99. Read the percentiles alongside
`sum by (outcome) (increase(space_chat_live_receipt_samples_total[5m]))`.
An interval with no confirmed samples has no latency percentile. A message
sent while everyone else is offline can still be stored and read later.
Both browsers must support receipt measurement. The browser skips measurement
when its local sample slots are full or a send spends 15 seconds in its queue.
These skipped sends have no server-side outcome. The API allows eight pending
samples per sending socket and 1,024 per instance, with a 15-second deadline.
If you run multiple API instances, receipt hints between them use the configured
Redis adapter. Lost hints can result in a timeout even when delivery succeeded.

**Agent tracing.** Run an agent turn with monitoring enabled. In Grafana
Explore, select **Space logs** and enter the first query below. Copy a
`traceId` from the results, substitute it in the second query, and sort by
oldest first. A trace ID identifies one turn. A multi-turn session has several.

```logql
{service_name=~"space-(server|worker)"} | json | msg="agent_turn_phase"
{service_name=~"space-(server|worker)"} | json | msg="agent_turn_phase" | traceId="<turn-uuid>"
```

The trace ID is the task UUID. Dispatch records show when Space commits a turn
for direct handoff or queued delivery. Execution starts when Space accepts
the connector's start event. Tool records include a turn-scoped `toolId` so you
can match start and finish records when several calls run at once. Compare
timestamps between approval request and decision, or execution start and
outcome, to locate delays. These timestamps reflect committed phase reports.
Both IDs stay in the log body. Prompts, tool names, arguments and results are
excluded. An unavailable collector or full buffer can leave gaps in a trace.

## Alerts

Open [Prometheus alerts](http://127.0.0.1:59090/alerts) for rule state and [Alertmanager](http://127.0.0.1:59093) to group or silence alerts. Rules cover API availability, error rate and latency, CDC slot health, outbox age, retained WAL, disk pressure, consumer backlog and missing telemetry. The outbox warning starts above five seconds. Readiness fails at fifteen seconds. A busy collector or an unavailable dependency can delay the warning.

Notifications default to the local alert view. To deliver firing and resolved notifications to a webhook, copy the following configuration to a private file outside the repository. Use a real receiver that accepts Alertmanager webhook payloads. Give the Alertmanager container's user read access to the file. Set `SPACE_ALERTMANAGER_CONFIG` in the deployment environment to its absolute path and apply `docker compose up -d --force-recreate --no-deps alertmanager`.

```yaml
route:
  receiver: operator
  group_by: [alertname, job]
  group_wait: 15s
  group_interval: 2m
  repeat_interval: 4h
  routes:
    - receiver: operator
      matchers: ['alertname="SpaceOutboxDelayed"']
      group_wait: 0s
receivers:
  - name: operator
    webhook_configs:
      - url: https://alerts.example.org/space
        send_resolved: true
```

To test notification delivery without interrupting Space, send a synthetic alert to the local Alertmanager. It expires in five minutes. Confirm that the receiver gets both firing and resolved events. These commands use Node.js and curl. Substitute your configured Alertmanager port if needed.

```sh
node -e 'console.log(JSON.stringify([{labels:{alertname:"SpaceOperatorTest",severity:"info"},annotations:{summary:"Space notification test"},endsAt:new Date(Date.now()+300000).toISOString()}]))' |
  curl --fail --json @- http://127.0.0.1:59093/api/v2/alerts
```

## Storage and failure behavior

- Prometheus keeps up to seven days of samples with a 1 GB block retention limit. Budget additional disk space for the WAL and head chunks. Loki uses local filesystem storage, an ingestion rate limit and seven-day compactor retention. Deletion is asynchronous. These limits do not impose a hard disk quota.
- The Docker logging driver sends the three opted-in services' stdout and stderr to a loopback Fluent Forward receiver using bounded asynchronous buffering. The collector discards unknown events and fields before sending to Loki. Loki receives selected operational data. The host's local Docker logs follow the Docker daemon's own logging and retention settings. Use a distinct `SPACE_LOG_PORT` and distinct UI ports for each installation sharing a host.
- A full buffer, unavailable collector or sustained Loki outage can lose logs. Prometheus can flag an unreachable collector or reported export failures. Records dropped by Docker before they reach the collector do not appear in its counters. Stopping monitoring must leave chat delivery operational. Use an independent off-host uptime check if the whole machine going offline must trigger a notification.
- CPU and memory depend on traffic, active series, dashboard queries and log volume. In one near-idle local Docker rehearsal, the six long-running monitoring services used about 565 MiB combined after a restart and a Grafana query. Measure your own peak usage and keep disk headroom for chat data and telemetry.

## Disable or re-enable

While the override is still active, remove only the monitoring services.

```sh
docker compose rm --stop --force prometheus alertmanager grafana loki log-collector infra-metrics infra-db-init
```

Remove the monitoring override from `COMPOSE_FILE` in the environment, then apply the base configuration to the three instrumented services.

```sh
docker compose up -d --no-deps server events worker
docker compose ps
```

This restores their normal logging driver, stops agent phase logging, and closes the private API and event bridge metrics listeners. Named volumes preserve log and metric history, Grafana settings and the generated database credential. Reapply the enable instructions to resume collection. Restarting exposes historical data subject to retention.

## Verification commands

Run these from the repository root. The privacy test starts an isolated Loki and collector and tears down its own volumes.

```sh
docker compose -f compose.yaml config --quiet
docker compose -f compose.yaml -f compose.monitoring.yaml config --quiet
docker run --rm -v "$PWD/deploy/monitoring:/cfg:ro" -w /cfg --entrypoint /bin/promtool prom/prometheus:v3.16.0 test rules rules.test.yaml
node --test deploy/monitoring/infra-metrics.test.cjs
python3 deploy/monitoring/log-privacy.test.py
```
