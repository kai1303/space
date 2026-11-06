# Navigator orchestration implementation plan

Goal: implement the four approved improvements: existing-session follow-ups, bounded deeper context, recorded authorization, and observe mode.

Architecture: retain the classifier and event-driven worker. Decisions may continue or stop a known managed session. Existing task/session authorization remains authoritative; a classification never inherits someone else's approval. Busy follow-ups wait in a durable bounded queue awakened by task/session events. No polling or explicit locks are added.

Scope and decisions:
- Preserve explicit mention behavior and ordinary new-work suggestions.
- Add `continue`/`stop` with `targetSessionId` and current-message evidence. Validate against same-thread work state. Ended or unavailable targets fail closed.
- Jev escalates plausible ambiguous requests and existing work. Level 2 can return `read_context` with up to eight known message IDs. One additional paid call may use at most 16,000 retrieved characters; persist a separate inference reservation so retries do not repeat calls.
- Record immutable authorization facts (actor, source message/decision, channel/thread, installation, skill, session, requested scope, policy hash) atomically with routing. Recheck current policy and access before queued dispatch; collaborator follow-ups retain owner approval.
- Add channel `execution_mode: suggest|observe`, default suggest. Observe records inferred actions without suggestions, tasks, continuation, or stop. Explicit mentions remain explicit requests. Provide bounded manager-visible decision review.
- Existing sessions retain their established visibility. The router sees public origin metadata only, never private follow-up contents.

Implementation sequence:
- [x] Contract/provider tests for known targets, pending human evidence, bounded reads, and escalation; implement strict schema and prompts.
- [x] Database migration for execution mode, immutable authorizations, bounded pending follow-ups, third inference reservation, and event-driven wakeups.
- [x] Reuse transaction-scoped session send/control; implement atomic routing, policy/access revalidation, queue drain, observe history API.
- [x] Add channel controls/review to existing Navigator UI if present; otherwise provide documented manager API without inventing unrelated UI.
- [x] Integration tests: duplicate delivery, busy recovery, stop, unauthorized/stale targets, policy changes, observe side effects, bounded context, and approval preservation.
- [x] Run focused contract/integration tests and affected typechecks; review all changes against authorization/concurrency requirements.

Verification commands: `pnpm --filter @space/tests exec tsx --test contracts/*navigator*.test.ts`; isolated-PostgreSQL integration suites for Navigator and agent sessions; `pnpm typecheck`. Existing unrelated working-tree changes must be preserved. No deploy or push is part of this build.

Validation: 54 Navigator contract/evaluation/orchestration tests, 48 existing Navigator/session integration tests, 11 Navigator UI tests, repository typecheck, web production build, and diff whitespace checks passed. Regression integration used isolated PostgreSQL, NATS, and wildcard CDC. No live model quality evaluation or shared database migration/deployment was performed.

Merge verification: isolated checkout of `main` plus only this change passed 55 Navigator/migration tests, 47 existing Navigator/session tests, 11 UI tests, repository typecheck, and the web build. Migration versions now come from their filename prefix so 057 can merge independently of unfinished migrations 054–056 without changing stored identities; repeated migration preserves data and versions. Unrelated local edits are excluded from this commit.
