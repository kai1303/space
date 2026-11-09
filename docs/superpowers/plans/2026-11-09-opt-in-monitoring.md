# Self-hosted logs and metrics implementation plan

1. Add an optional private Fastify metrics listener and verify route-template aggregation, response durations and listener cleanup in the API tests. Keep the base Compose file independent of the listener.
2. Add service-scoped, non-blocking log forwarding and Loki storage. Test delivery with a known diagnostic event and a sensitive field in the same input. Verify the stored event contains only approved fields.
3. Collect API readiness, CDC, broker and disk gauges from a dedicated exporter. Test against an isolated installation and existing database volumes. Bound collector connections, query time, response sizes and metric labels.
4. Wire the services together in the monitoring override. Provision Grafana with both data sources, the operational dashboard, local alert visibility and optional webhook delivery. Validate production rules using promtool and synthetic failing, idle and recovered samples.
5. Exercise enable, disable and restart under a unique Compose project. Verify log and metric queries, privacy, retained history and message delivery during monitoring failure. Document operator commands and deployment limits.
