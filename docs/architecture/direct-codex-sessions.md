# Direct Codex session execution

A managed Space session retains one Codex thread mapping in the connector's private storage. Approved turns use an immediate authenticated Socket.IO handoff. They do not enter the pending task-delivery queue or wait for NATS/CDC to wake the connector. Approval requirements and access checks still apply.

The API checks current connector availability and session capacity before accepting a send. A busy/offline/full connector rejects the send and the composer retains its draft. Capacity is four concurrent sessions per connector, with one active turn per session. Idle provider processes can be evicted; their durable thread mappings remain available for later resume.

The database commits the task, execution and exact attempt identity before provider invocation. A direct task is running during its bounded startup handshake. The legacy execution status remains queued until the persisted execution.started event; this represents initialization, not a waiting backlog. The attempt is marked direct and is never picked up by a queue consumer, renewed, or reclaimed. Its existing deadline column supplies a fixed 180-second safety deadline. A missed start acknowledgement fails the attempt only if no event has been durably saved. A saved first event proves acceptance even when the acknowledgement is uncertain. A start that produces no persisted event fails after its startup deadline; it is not automatically rerun.

Events persist before acknowledgement and emit scoped resource invalidations over PostgreSQL notifications to the API nodes. The existing authorized resource subscriptions refetch their HTTP snapshots. Browser reload therefore restores the saved state without restarting provider work. A disconnected connector fails its active attempts. Stop targets the exact session and execution; other sessions continue.

PostgreSQL notifications are live handoff hints, not the durable history. Persisted tasks, event receipts, snapshots and fixed deadlines retain the recovery boundary. API restart expires old direct attempts rather than replaying uncertain provider invocations. Remote and non-managed legacy work retain their existing delivery protocol.

Verification covers admission rejection, two simultaneous sessions, same-session exclusion, duplicate offers and send retries, stale execution fencing, scoped Stop, saved history and live authorized viewer invalidation. A real local check also ran two Codex threads concurrently and verified both saved completions.
