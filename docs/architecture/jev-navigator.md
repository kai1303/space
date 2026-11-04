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

In Space, open **Navigator** in the selected channel and choose **Rules + optional model providers**. Until a manager enables that mode, no Jev calls occur. Supplying a TypeSafe key alone does not select Jev. Direct tags bypass inference; ordinary discussion replies do not implicitly invoke agents. At least one eligible agent capability (connected agents inherit owner access; unpaired installations use channel grants) is needed to classify useful matches.

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

When supplied, author identity/kind is retained. The last pending message is the target; earlier pending messages and older conversation are history. Messages after that target are excluded. An empty, unknown, duplicate or explicitly agent-authored target is rejected before HTTP. Production routing supplies a human target and bounded thread context: at most 16 recent messages, each text capped at 1,000 characters. Rich code/quote instructions are removed from routing text. A truncated latest message fails closed before HTTP, so a trailing cancellation cannot be silently omitted. This is context-aware classification, not unlimited transcript ingestion or persistent provider-side conversation memory.

The independent questions ask:

1. Does the last message request or confirm execution now? A concrete proposal in history can be confirmed by another participant; permission is enforced separately. Unresolved problems alone, ability questions, quotations, cancellation, postponement and acknowledgment do not count.
2. Is the requested action and target clear enough to route? The executor can retrieve missing inputs; unresolved alternatives are ambiguous. Task complexity alone does not block routing.
3. Does this refer to accepted, running or completed work? Repeated confirmations and progress questions must not start duplicate work. Confirming an unaccepted proposal or explicitly requesting a redo is new work.
4. For each distinct eligible skill, does it fit the requested work? Several skills can match. Shared skills across installations are asked once.

After permission checks, `work_state` supplies at most eight pending proposals, eight public task summaries/statuses and eight managed-session titles/states for this thread. Goals are capped at 512 characters. Private session messages, outputs and follow-up goals are excluded. These records are reference data, never execution authority. [Example native request](../evaluations/navigator/2026-11-04-execution-intent-request.json) captures the exact current prompt with synthetic pending-proposal context and no credentials.

Conversation and capability text are explicitly treated as untrusted data in the questions. Question IDs are application keys, not task authorization. No question depends on the answer to another question; application code combines their probabilities afterward.

## Decisions and evidence

The adapter retains a `decision.assessment` containing:

- Actual returned model ID and target message ID.
- `requestsAgentWork`, `taskClear`, and `continuesExistingWork` probabilities, with `version: "execution-intent-v1"`.
- A SHA-256 fingerprint of the bounded work-state snapshot for host-side freshness validation.
- The probability for each evaluated capability.

The assessment is stored with the existing inference/decision/suggestion JSON, so no migration is needed. The native response's `usage.input_tokens` and `usage.output_tokens` are recorded too. Evidence points to the target message. Values must be finite numbers between zero and one; expected answers, types, usage and known capabilities are validated. There is no separately invented Noul confidence score.

Default mapping uses yes >= 0.7 and no <= 0.3:

- Request and clarity must both reach yes, and existing-work probability must be no or lower.
- With a matching capability: suggest up to eight skills.
- With all capabilities below the no threshold: clarify the missing capability.
- All uncertain or non-actionable cases: ignore quietly. Jev no longer escalates based on task complexity.

Thresholds remain 0.7/0.3. Optional worker settings `NAVIGATOR_L1_YES_THRESHOLD` and `NAVIGATOR_L1_NO_THRESHOLD` configure them. Yes must exceed 0.5 and no must be below 0.5. These thresholds are not calibrated production guarantees.

In semantic mode with Jev, every unaddressed batch passes through this intent gate; keyword rules cannot bypass it, including on budget exhaustion or provider failure. Rules-only mode and compatible-provider behavior are unchanged. Explicit mentions bypass Jev, and managed-session messages stay with the session executor.

A high probability does not start an agent or grant permission. Suggestions still require selection and the existing execution policy. If conversation or work state changes before the suggestion is persisted, Space suppresses the stale decision. The same check applies to cached inference replay. Historical usefulness-based assessments remain readable but cannot be replayed into new Jev routing. No database migration is needed.

## Cost and failure behavior

The worker reserves the serialized native request size, including all per-capability questions, in the existing persistent daily budget before HTTP. Reported usage is stored separately. Unknown or failed outcomes retain their reservation; retries never repeat a paid call for the same batch/level. Providers without an estimator retain the existing conservative fallback.

Shared transport caps requests at 32 KiB, responses at 64 KiB and calls at ten seconds, including body reads. Oversized context/catalogs fail closed before an outbound call. Only HTTPS and loopback HTTP are accepted, redirects are rejected, and errors never expose keys or raw provider bodies. There are no automatic HTTP retries. Explicit routing remains available if Jev fails or the daily budget is exhausted. Jev semantic mode stays quiet; rules-only mode remains a separately configured option.

## Verification scope

Contract tests use probability fixtures and real loopback HTTP listeners. Integration tests use disposable PostgreSQL schemas and the real native adapter to verify request shape, last-message targeting, persistence, budget reservation and suggestion-only behavior. Fixtures cover intended examples structurally; they do not establish that a live Jev model classifies each example correctly. No real TypeSafe account request, model quality evaluation or paid inference is performed by the test suite.

Verified locally on 2026-11-03: full suite 470 tests passed, build/typecheck passed, and independent review reported no remaining blockers. No database migration was needed for this adapter.

Before the execution-intent change on 2026-11-04, an explicitly run live 24-case starter replay matched 17/24 labels at default thresholds, and one real-worker smoke persisted a Jev suggestion without executing a task. These were separate paid checks, not the automated test suite. See [saved results, threshold comparison and repeatable test commands](navigator-evaluation.md). The sample is too small to establish production accuracy; default thresholds remain unchanged.

The execution-intent v2 live replay subsequently matched 32/36 synthetic cases with zero interventions on 21 negative cases, three missed requests and one partial capability selection. This is development-set evidence, not held-out calibration. See the linked evaluation document for saved results and remaining limitations.
