# Navigator and thread routing implementation plan

> Execute inline with the executing-plans skill; the user has approved this design and implementation.

**Goal:** Route explicit agent mentions and owned-thread follow-ups without inference, and offer optional rules/semantic suggestions in ordinary chat threads.

**Architecture:** Human message inserts atomically wake a durable per-thread queue. The existing worker handles leased batches; Level 0 routes mentions/subscriptions, rules suggest capabilities, and optional bounded HTTP providers classify/escalate. Permission-checked suggestions create normal task proposals; only the existing approval policy authorizes execution. Approved subscriptions reuse the agent session for serialized follow-ups. No provider is mandatory and no model runs by default.

**Tech stack:** Existing TypeScript, PostgreSQL/Drizzle, Fastify, Socket.IO, React; native fetch for optional compatible model endpoints.

- [x] Contracts and core: add `packages/contracts/navigator.ts`, `packages/core/navigator.ts`, and `packages/core/navigator-provider.ts`; test routing precedence, multi-capability matching, escalation, malicious output, unavailable providers, and limits in `tests/contracts/navigator.test.ts`. Export through existing packages.
- [x] Persistence: migration `020_navigator.sql` adds channel settings, thread queue/subscriptions, decisions/suggestions, durable inference reservations, and a human-message trigger. `adapters/postgres/navigator.ts` implements claims, scoped catalog, inference budgets, atomic routing, proposal acceptance/dismissal, and settings. Refactor task transaction helpers in `store.ts` to reuse existing policy/session creation. Preserve unrelated dirty changes.
- [x] Thread integration: opted-in routing tasks emit progress as normal agent replies. Preserve old task flow behavior. Add worker processing, channel-scoped API endpoints, and chat suggestions/mention picker using existing composer UI.
- [x] Verification: failing core/integration tests first, then implement; run targeted tests, full typecheck/build and relevant existing task/chat/UI tests. Test actual model HTTP protocol against a local fixture; do not invoke paid providers. Document setup, model boundaries, approval semantics and known execution limits.

Acceptance scenarios:
```text
@agent -> proposed task -> owner approval -> execution -> thread progress/result
follow-up while running -> durable queue -> same session after completion -> no inference
unmentioned request -> rules or optional model -> suggestion -> user chooses -> normal proposal
provider failure/budget exhaustion -> deterministic paths continue, no auto-execution
revoked membership/grant -> context/acceptance/dispatch denied
worker crash/retry -> no duplicate tasks, suggestions, or model requests
```

Verification: full suite passed 457 tests (174 contracts/backend, 154 web, 83 shared UI, 26 server, 20 connector); full typecheck/build and diff whitespace check passed. Independent code review reported no remaining findings. Real provider requests used loopback fixtures only. The default connector remains mock unless another configured connector is selected. Local development migration applied separately; no grants or channel semantic settings were enabled.
