# Opt-in monitoring for self-hosted Space

The installation operator controls monitoring for the whole deployment. The first target is the single-host Linux Docker Compose stack. Its operator should be able to tell whether the API is serving traffic, whether committed messages are reaching subscribers, and whether PostgreSQL or JetStream is running out of disk.

## Operator workflow

Ship a Compose override, `compose.monitoring.yaml`. On Linux the operator enables it by adding `COMPOSE_FILE=compose.yaml:compose.monitoring.yaml` to the deployment's Compose environment and applying `docker compose up -d`. The override enables API instrumentation and adds the collectors in one operation. A fresh installation using the base file alone starts with monitoring off. Existing readiness probes work in both modes.

Provide a disable procedure that explicitly stops and removes the monitoring services before removing the override and reconciling the API. Simply removing an override can leave its containers running. Preserve metric history in a dedicated volume across disable and re-enable. Document the API restart when applying either configuration.

## Signals and alerts

| Operator question | Collection | Initial alert conditions |
| --- | --- | --- |
| Can clients use the API? | Probe the HTTP result of `/readyz`. Record request counts and duration on completion, using bounded route and status labels. | Sustained readiness failure, elevated server error rate or latency with sufficient traffic. |
| Is delivery falling behind? | Read the oldest unpublished event age, replication slot state and retained WAL. Collect pending acknowledgements and redeliveries for the configured durable JetStream consumers. | Stale outbox before the readiness cutoff, unavailable slot, or persistent consumer backlog with stalled acknowledgement progress. An idle, caught-up installation stays healthy. |
| Could the next writes exhaust storage? | Measure available space on the filesystems backing the PostgreSQL and NATS volumes, plus JetStream store use and limit. | Low free space, excessive retained WAL or broker storage approaching its limit. |
| Can the operator trust these signals? | Record scrape success and the presence of each required series. | A missing or failing collector produces a distinct alert even when its last sample was healthy. |

Use Prometheus to store metrics and evaluate rules, and Alertmanager to group and deliver notifications to an optional operator-configured webhook. Provide a local alert view and a test notification procedure. Keep the interfaces private and publish operator access on loopback. Collection stays on the installation. Allow only bounded service, route, status and stream labels. Exclude message content, raw paths, query strings, credentials and user or workspace identifiers.

## Failure isolation and bounds

The external monitoring services own the collection interval. The API records observations in memory and serves them on a private listener. Chat requests and event publication never wait for a collector. Use a read-only database identity with limited connections, statement deadlines and indexed queries. Collect disk capacity from the actual data filesystems without mounting the Docker socket. Configure time and size retention limits for Prometheus and document the headroom needed for storage overhead. A monitor on the same host cannot report total host loss while that host is down. Operators needing that signal can probe readiness from another host.

## Acceptance checks

1. Render both Compose configurations and start each in an isolated project. Verify the default has no monitoring services, listener or exports. Enable, disable and re-enable with existing volumes. Confirm chat works after each transition and metrics history survives.
2. Send a message, then stop the CDC bridge and send another. Observe the delivery alert, restart the bridge, and verify both message delivery and alert resolution. Check idle periods for false alarms.
3. Exercise storage and missing-series alert rules against synthetic samples. Stop a collector to exercise the live missing-data path. Deliver a firing and resolved notification to a local test receiver.
4. Stop the entire monitoring stack while the application is running. Verify message send and realtime receipt. Inspect exported labels and host port bindings. Record CPU, memory and disk usage during the rehearsal before publishing sizing guidance.

The deployment runbook defines the existing recovery signals and operator responsibilities. [Realtime availability and recovery](../../architecture/realtime-deployment.md)
