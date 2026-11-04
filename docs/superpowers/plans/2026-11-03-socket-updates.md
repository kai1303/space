# Socket updates implementation plan

**Goal:** Replace repeating browser API reads and connector task claiming with Socket.IO notifications.

**Architecture:** Reuse the transactional PostgreSQL chat outbox and Redis adapter for committed invalidations. Authorized workspace/channel/thread/task subscriptions receive payload-free change signals and refetch existing HTTP endpoints. Initial loads, reconnect and focus recover state; no recurring browser refresh. Share connections by scope and coalesce refreshes during in-flight requests. Connector receives work-available signals and drains queued tasks serially.

**Scope:** Chat channel lists, mention inbox, Navigator suggestions, thread subscriptions, workspace members/pairing, task details, local connector task claim. Keep heartbeat, lease renewal, cleanup, durable outbox/reconciliation, UI clocks and debounce timers.

- [x] Add failing subscription/outbox tests covering authorization, committed changes, cross-instance forwarding and revocation.
- [x] Add scoped `updates.subscribe {scope,id}`, `updates.changed`, `updates.revoked` and durable triggers for metadata, mentions, Navigator, pairing and connection changes. Recheck access before notifications. Recovery reconciliation may refresh subscriptions to repair missed Redis notifications.
- [x] Add tested shared browser subscription helper, reconnect/focus recovery and refresh coalescing. Replace all six repeating browser API refresh loops; retain existing permission and stale-response guards.
- [x] Replace connector one-second claiming interval with `agent.tasks.available`; retain readiness checks, initial/reconnect claim, serial draining and safety timers.
- [x] Run targeted UI, connector and real PostgreSQL/Redis integration tests, full typecheck/build, then inspect diff and polling inventory.

Validation: 208 web tests, 37 connector tests and 85 PostgreSQL/Redis integration tests passed; workspace build/typecheck and diff whitespace checks passed. Migration029 applied to local development database; local API restarted and health endpoint verified.
