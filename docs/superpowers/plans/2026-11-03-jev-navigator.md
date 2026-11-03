# Native Jev Navigator implementation plan

Approved scope: integrate TypeSafe System One as an optional Level 1 Navigator provider. Keep the last pending human message separate from earlier conversation; ask independent Noul questions for requested agent work, useful assistance, complexity and each eligible capability. Store probabilities separately from execution authority. Rules, mentions and owned subscriptions keep their current behavior.

- [x] Add native request/response fixture tests, including contextual confirmation, informational discussion, useful help without invocation, ambiguity, independent multi-capability matches, untrusted context, malformed probabilities and network limits.
- [x] Reuse bounded HTTP transport for both providers. Add the native Jev provider and checked intent-assessment contract. Retain bounded input, timeouts, response sizes, no redirects and generic errors.
- [x] Wire explicit provider selection and server-side credentials into worker configuration. Reserve the actual provider request estimate, including Jev questions, before calling it. Test factory and persistent inference integration with existing permission/budget/cache paths.
- [x] Document exact setup and editable question source. Run focused tests, related integration tests, build/typecheck and code review. Do not call paid endpoints or enable semantic navigation automatically.

Configuration: NAVIGATOR_L1_PROVIDER=jev, TYPESAFE_API_KEY (or NAVIGATOR_L1_API_KEY), optional model/endpoint overrides; compatible providers remain the default. Level 2 remains independently configured for reasoning. No new database migration needed.

Verified: 22 focused Navigator/provider contract tests passed; native HTTP/PostgreSQL integration passed; the full monorepo suite passed 470 tests (184 contracts/backend, 156 web, 84 UI, 26 server, 20 connector). Full build/typecheck, Compose validation and whitespace checks passed. Independent review found and verified the bounded-history pending-target fix; no remaining blockers. Fixtures validate protocol/routing, not live Jev semantic accuracy. No paid API call or channel semantic enablement occurred.
