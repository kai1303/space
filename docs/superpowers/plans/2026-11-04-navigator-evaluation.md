# Navigator evaluation implementation plan

**Goal:** Make the remaining Navigator validation reproducible, then run the available local checks and a bounded live Jev check when credentials are available.

**Architecture:** Keep evaluation in `tests/evaluation`, calling the existing rules function or configured Level 1 adapter directly. Use hand-labeled synthetic conversations, no database connection and no task dispatch. Report individual decisions, coverage, false positives, missed intent, capability matching, latency, reserved and reported tokens, and optional estimated USD from operator-supplied prices. Do not invent provider prices or treat fixtures as production quality evidence.

**Scope:** The user selected Jev Level 1. Existing integration tests cover Level 2 escalation, approval, budgets, concurrent delivery and recovery. No changes to production decision policy or model thresholds without live evidence. Existing unrelated frontend edits remain outside this work.

- [x] Add regression tests for replay metrics, pending-message context, budgets, failure handling and CLI offline defaults. Run them before implementing the runner.
- [x] Implement `tests/evaluation/navigator.ts`, a bounded sequential evaluator; `navigator-fixtures.ts`, a labeled starter corpus; and `navigator-cli.ts`, JSON report output with explicit live mode. Add `navigator:eval` scripts to root and tests package manifests.
- [x] Preserve `NATS_URL` through the worker's package-specific Turbo environment override. Verify the effective `@space/worker#start` configuration with `turbo --dry=json`.
- [x] Run Navigator contract tests, database integration and concurrency tests, and real WAL/JetStream worker recovery tests in disposable local schemas. Run the relevant build and type checks.
- [x] Run the offline corpus and record actual metrics. Run one live Jev smoke case, the full 24-case corpus and one synthetic real-worker smoke. Replay 15 threshold combinations offline without additional provider calls.
- [x] Document commands, metric definitions, live credential setup, manual UI acceptance steps and remaining production validation limits in `docs/architecture/navigator-evaluation.md`. Correct stale Navigator documentation.

Acceptance: default replay causes no network calls; live mode requires a configured Level 1 provider; no task is dispatched by evaluation; a failed paid call is not retried; budget-skipped cases are visible; zero denominators report null; incorrect decisions affect reported accuracy; no credential/raw provider errors appear in reports.

Independent review found an unknown-usage cost reporting issue for compatible providers; a failing regression reproduced it and the fix now reports null instead of $0. Final validation: 60 targeted tests passed, relevant builds and test-package typecheck passed. Real Jev matched 17/24 starter labels at defaults. No thresholds changed: same-corpus replay is not held-out calibration. Production load and multi-node validation remain deployment work.
