# Jev execution-intent navigation

Approved scope: classify clear requests/confirmations using conversation and current work state. Stay quiet on ambiguous discussion, cancellation, acknowledgment and existing work. Keep explicit mentions, managed-session follow-ups, permissions and suggestion acceptance in Space.

- [x] Replace usefulness/complexity questions with task clarity and existing-work detection; version assessments and preserve parsing of historical results.
- [x] Supply bounded thread-scoped pending proposals, task statuses and session metadata after permission checks. Ensure Jev semantic routing cannot bypass its intent gate through keyword rules or legacy cached results.
- [x] Test decision boundaries, context serialization, storage/acceptance and event delivery. Preserve ordinary-thread versus managed-session separation.
- [x] Version and extend offline/live evaluation fixtures, run bounded live Jev evaluation, record prompt/results/usage and update documentation.
- [x] Review and run relevant checks; report measured results and remaining limits.

Validation: 66 targeted contract/integration tests passed, including real WAL → NATS → worker routing and acceptance. Worker/server/event-service builds and test-package typecheck passed. Independent review found an acceptance race; added work-state fingerprints and a fresh/cached-result regression, then review reported no outstanding findings. Live v2 evaluation: 32/36 exact matches, 0/21 false interventions, estimated $0.001722336 for the 36-case run. The four mismatches remain documented; no production quality claim. See docs/architecture/navigator-evaluation.md.
