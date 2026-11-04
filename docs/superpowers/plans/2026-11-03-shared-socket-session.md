# Shared browser Socket.IO session

**Goal:** One connection per authenticated browser tab, shared by chat, unread state and resource notifications.

**Architecture:** A session-owned browser transport centrally registers event handlers and reconnects with backoff/jitter. Views hold reference-counted subscriptions rather than connections. A session owner keeps the transport alive across navigation and destroys it on logout/session replacement. Each subscription restores from current inputs/cursors after reconnect; commands use one bounded serialized queue. Server keeps a bounded resource map alongside channel/workspace streams, supports explicit unsubscribe and scopes authorization loss to the affected subscription.

- [x] Write failing server tests for multiple resources, unsubscribe, independent revocation, limits and concurrent subscriptions.
- [x] Add server subscription map, unsubscribe commands and scoped stream revocation; preserve durable replay, ACK limits and access checks. Prevent a resource ACK from blocking unrelated subscriptions.
- [x] Write failing browser tests for sharing across resource/chat/unread streams, session lifetime, listener cleanup, restoration, scoped revocation and transient recovery.
- [x] Centralize connection/event/reconnect ownership; adapt resource notifications, chat and unread hooks. Preserve stale-result guards and message retry identity.
- [x] Review changes, run complete web/connector and relevant PostgreSQL/Redis integration tests, build/typecheck, update docs and restart verified local API if safe.

No new dependencies or database migrations. Keep connector transport and safety timers unchanged. Preserve unrelated workplace.css edit and previous polling replacement work.

Validation: 217 web tests passed (25 files, excluding the concurrently developed AgentSessions test file); 94 PostgreSQL/Redis integration tests passed. Workspace build/typecheck and whitespace checks passed. Review found and resolved stale subscribe recovery, revoked-watcher cleanup, and subscription-limit reconnect behavior. Current browser source has a single io() creation site. Local API restarted from current build; health endpoint returned ok.

Combined-suite limitations: concurrent agent-session UI tests and managed connector/session cancellation tests failed in the full runs. Those production files belong to parallel work and were preserved. No production load benchmark was run.
