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

The **Space operations** dashboard shows API readiness, HTTP traffic, delivery lag, disk capacity and logs. In **Explore**, select **Space metrics** for PromQL or **Space logs** for LogQL. For remote access, forward the Grafana port over SSH, for example `ssh -L 53001:127.0.0.1:53001 operator@space-host`. The operator interfaces bind to loopback. Keep the Docker network and control of the host restricted to trusted services and operators.

## Verify collection

1. Open [Prometheus targets](http://127.0.0.1:59090/targets). The API, infrastructure exporter and monitoring services should be up after startup. Query `space_infra_source_up` and check that the API, PostgreSQL, NATS and disk sources each return 1.
2. Send a Space message. In Grafana, query `sum by (route) (increase(space_api_http_requests_total[5m]))` for completed HTTP requests. Socket.IO message delivery uses a separate transport. Check delivery health using `space_cdc_outbox_oldest_age_seconds` and the JetStream consumer gauges.
3. In **Space logs**, query `{service_name=~"space-(server|worker|events)"}`. Service startup and supported failure events have stable names, such as `worker_ready` and `cdc_interrupted`. API completions include the method, status and duration. For example, `{service_name="space-server"} | json | msg="http_request_completed" | statusCode >= 500` finds completed HTTP requests that returned a server error. Routine readiness probes are excluded from the access logs. Use the dashboard time selector to investigate the interval around an alert.

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

This restores their normal logging driver and closes the private API metrics listener. Named volumes preserve log and metric history, Grafana settings and the generated database credential. Reapply the enable instructions to resume collection. Restarting exposes historical data subject to retention.

## Verification commands

Run these from the repository root. The privacy test starts an isolated Loki and collector and tears down its own volumes.

```sh
docker compose -f compose.yaml config --quiet
docker compose -f compose.yaml -f compose.monitoring.yaml config --quiet
docker run --rm -v "$PWD/deploy/monitoring:/cfg:ro" -w /cfg --entrypoint /bin/promtool prom/prometheus:v3.16.0 test rules rules.test.yaml
node --test deploy/monitoring/infra-metrics.test.cjs
python3 deploy/monitoring/log-privacy.test.py
```
