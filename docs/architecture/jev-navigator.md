# Native Jev navigation

Jev is an optional Level 1 decision provider. The native adapter calls TypeSafe's `POST /v1/systemone` with `state` and typed `noul` questions. It does not send Chat Completions messages or ask Jev to generate JSON prose. The contract follows the official [System One reference](https://docs.typesafe.ai/api/system-one) and [Noul documentation](https://docs.typesafe.ai/primitives/noul).

## Enable it

Create a TypeSafe key in [the official console](https://console.typesafe.ai). In the environment used to start the worker:

```sh
export NAVIGATOR_L1_PROVIDER=jev
export TYPESAFE_API_KEY='your-server-side-key'
# Optional: pin a model rather than use the default jev-latest alias.
# export NAVIGATOR_L1_MODEL=jev-1.14.0
pnpm worker
```

For the standard local setup, load your existing database environment before starting the worker. Store credentials in your private environment configuration; do not commit them. `NAVIGATOR_L1_API_KEY` overrides `TYPESAFE_API_KEY`. The native endpoint defaults to `https://api.typesafe.ai/v1/systemone`; `NAVIGATOR_L1_URL` is an optional trusted gateway/test override that must end in `/systemone`. Unset an older Chat Completions URL when switching to the default Jev endpoint.

In Space, open **Navigator** in the selected channel and choose **Rules + optional model providers**. Until a manager enables that mode, no Jev calls occur. Supplying a TypeSafe key alone does not select Jev. Direct tags and owned-thread follow-ups bypass inference as before. At least one channel-granted eligible agent capability is needed to classify useful matches.

Level 2 remains independent. Configure an existing compatible reasoning provider with `NAVIGATOR_L2_URL`, `NAVIGATOR_L2_MODEL`, and optional `NAVIGATOR_L2_API_KEY`. Jev is deliberately restricted to Level 1. `NAVIGATOR_L1_PROVIDER=compatible` (the default) preserves the existing compatible provider configuration. No Jev dependency or SDK is installed.

## Exact question source

The editable questions and policy are in `packages/core/jev-navigator.ts`, exported as `JEV_NAVIGATOR_QUESTIONS`. All questions share one state:

```json
{
  "history": [
    {"id": "m1", "text": "We need a summary."},
    {"id": "m2", "text": "Should we ask Writer?"}
  ],
  "last_message": {"id": "m3", "text": "Yes, please do that."},
  "available_capabilities": [
    {"id": "writing.summarize", "description": "Summarize conversations"}
  ]
}
```

When supplied, author identity/kind is retained. The last pending message is the target; earlier pending messages and older conversation are history. Messages after that target are excluded. An empty, unknown, duplicate or explicitly agent-authored target is rejected before HTTP. Production routing supplies a human target and bounded thread context: at most 20 recent messages, each text capped at 1,000 characters. This is context-aware classification, not unlimited transcript ingestion or persistent provider-side conversation memory.

The independent questions ask:

1. Does the last message ask or confirm that an agent should perform work now? Confirmation can reference a proposal in history. Discussion of agents, ability questions, quotations, postponement and acknowledgments alone do not count.
2. Would an available agent materially help an unresolved need in the last message, even without an explicit invocation?
3. Does interpreting that need require complex reasoning or clarification?
4. For each distinct eligible skill, would that capability materially help? Several independent skills can match. Shared skills across installations are asked once.

Conversation and capability text are explicitly treated as untrusted data in the questions. Question IDs are application keys, not task authorization. No question depends on the answer to another question; application code combines their probabilities afterward.

## Decisions and evidence

The adapter retains a `decision.assessment` containing:

- Actual returned model ID and target message ID.
- `requestsAgentWork`, `assistanceUseful`, and `needsDeeperReasoning` probabilities.
- The probability for each evaluated capability.

The assessment is stored with the existing inference/decision/suggestion JSON, so no migration is needed. The native response's `usage.input_tokens` and `usage.output_tokens` are recorded too. Evidence points to the target message. Values must be finite numbers between zero and one; expected answers, types, usage and known capabilities are validated. There is no separately invented Noul confidence score.

Default mapping uses yes >= 0.7 and no <= 0.3:

- Both request and usefulness are low: ignore.
- Neither reaches yes, or meaningful complexity remains: escalate.
- A request or useful assistance is clear, complexity is low, and capabilities match: suggest up to eight skills.
- Capability selection is uncertain: escalate; no matching capability: clarify.

These are initial policy thresholds, not calibrated accuracy claims. Optional worker settings `NAVIGATOR_L1_YES_THRESHOLD` and `NAVIGATOR_L1_NO_THRESHOLD` configure them. Yes must be above 0.5 and no below 0.5. Evaluate against labeled conversations before relying on a particular boundary. Suggested assistance and an explicit request remain separate even when both lead to a suggestion.

A high probability does not start an agent or grant permission. Suggestions still require selection and the existing execution policy. Jev does not generate the user-facing explanation; the application derives a short reason from the decision. If escalation is unavailable, the existing Navigator fallback applies.

## Cost and failure behavior

The worker reserves the serialized native request size, including all per-capability questions, in the existing persistent daily budget before HTTP. Reported usage is stored separately. Unknown or failed outcomes retain their reservation; retries never repeat a paid call for the same batch/level. Providers without an estimator retain the existing conservative fallback.

Shared transport caps requests at 32 KiB, responses at 64 KiB and calls at ten seconds, including body reads. Oversized context/catalogs fail closed before an outbound call. Only HTTPS and loopback HTTP are accepted, redirects are rejected, and errors never expose keys or raw provider bodies. There are no automatic HTTP retries. Explicit routing and rules remain available if Jev fails or the daily budget is exhausted.

## Verification scope

Contract tests use probability fixtures and real loopback HTTP listeners. Integration tests use disposable PostgreSQL schemas and the real native adapter to verify request shape, last-message targeting, persistence, budget reservation and suggestion-only behavior. Fixtures cover intended examples structurally; they do not establish that a live Jev model classifies each example correctly. No real TypeSafe account request, model quality evaluation or paid inference is performed by the test suite.

Verified locally on 2026-11-03: full suite 470 tests passed, build/typecheck passed, and independent review reported no remaining blockers. No database migration was needed for this adapter.
