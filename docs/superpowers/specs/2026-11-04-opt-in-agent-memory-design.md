# Opt-in agent integrations and memory

The accepted architecture review calls for capability-based agent integrations and explicit per-agent channel-memory permissions. Preserve existing local Codex and Markdown behavior and independent thread working memory.

## Agent integrations

Trusted server configuration registers paired connector descriptors (ID, definition ID, name, skills and persistent-session support). Pairing chooses a registered descriptor; browser/connector inputs cannot invent capabilities. Existing pairing requests default to Local Codex. Store the descriptor selection with the pairing. Route paired installations by their connection record, not by a Codex string. Generic channel agent listings expose owned installations, supported/granted skills and session support. Channel grants are explicit per skill; managed sessions choose a supported granted skill. Keep the old local-codex listing as a compatibility alias. Provider-specific authentication/execution remains in the connector.

## Memory

Channel managers configure an installation's channel-memory access independently: none (default), read, contribute. Channel enablement, active installation, its owner's current channel access and task grant are required at use time. Contribute permits evidence-backed additions, not complete replacement or deletion. Existing manually issued unbound MCP read/write credentials retain their current behavior; installation-bound keys are capped by the live installation grant and may never request full write authority.

Dispatch reads a bounded excerpt through the selected MemoryProvider outside a database transaction, then rechecks task authorization and the memory policy before returning it. Disabled/ungranted memory does not call a provider. Missing configured providers fail closed. Reference content remains untrusted context. Revoking permission prevents subsequent reads/writes; it cannot erase information already delivered to an external agent or retained conversation. No automatic extraction job is added.

## Reliability and compatibility

Use serializable transactions/conditional writes and constraints for new authorization mutations; add no explicit database locks, distributed locks or polling. Preserve idempotent pairing, skill grants, evidence-backed ingest and event-driven delivery. New API payloads are bounded and validated. Existing Markdown storage coordination remains documented migration debt, not a pattern for new work.

## Verification

Test a synthetic non-Codex paired connector through pairing, grants, session creation and dispatch. Test missing and revoked grants, unsupported skills/sessions, defaults and cross-workspace isolation. Test memory none/read/contribute, disabled memory, bounded context, provider failures, stale access during provider I/O, and MCP inability to replace/delete with contribute access. Run affected backend and web tests plus build/typecheck. External provider execution and production load are not implied by local tests.
