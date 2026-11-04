# Testing Navigator

Navigator now has three distinct checks: repeatable contract/integration tests, labeled decision replay, and manual product acceptance. A passing transport test does not establish model accuracy; replay does not exercise authorization or dispatch.

## Reproducible local checks

From the repository root, with dependencies installed and the local PostgreSQL/NATS/CDC stack running:

```sh
pnpm exec turbo run build --filter=@space/worker --filter=@space/server
cd tests
node --env-file=../.env --import tsx --test --test-concurrency=1 \
  contracts/*navigator*.test.ts \
  integration/navigator.test.ts \
  integration/event-workers.test.ts \
  integration/event-runtime.test.ts
pnpm exec tsc -p tsconfig.json --noEmit
```

Database tests create and remove disposable schemas. The runtime test needs the wildcard CDC service (`DATABASE_SCHEMA` unset), launches a separate worker, and uses a local HTTP Jev fixture. It checks WAL → JetStream → native adapter → persisted suggestion, no execution before acceptance, restart recovery and duplicate acceptance. Its explicit fixture provider configuration prevents paid inference even when the developer has a real key.

If the runtime test reports a missing WAL-driven change, check CDC health first. Restart the bridge and workers after rebuilding event-stream changes. Never delete a replication slot or broker volume to get a test passing.

## Decision replay

Build the adapters once, then run the offline baseline from the repository root:

```sh
pnpm exec turbo run build --filter=@space/core
pnpm --silent navigator:eval > /tmp/navigator-rules.json
```

The default is rules-only: no database, network call or task dispatch. `tests/evaluation/navigator-fixtures.ts` contains 36 hand-labeled synthetic cases (`navigator-execution-intent-v2`) covering clear requests, multiuser confirmations, cancellation, existing/completed work, explicit redos, ambiguous discussion, quoted/code input, unavailable capabilities and Vietnamese. Version 2 changes three original labels to match the approved execution-intent policy; historical v1 reports are retained unchanged. These are starter examples, not a representative production dataset.

For live Jev, set these in private `.env` (ignored by Git):

```dotenv
NAVIGATOR_L1_PROVIDER=jev
TYPESAFE_API_KEY=your-private-key
```

The native URL and `jev-latest` model have defaults. Remove any old compatible `NAVIGATOR_L1_URL` when switching to Jev. The commands load the project `.env`; exported shell values take precedence. Do not paste keys into commands, reports or tracked files.

```sh
# One paid smoke request first.
pnpm --silent navigator:eval --mode level1 --limit 1 > /tmp/navigator-jev-smoke.json

# Up to 36 sequential paid requests, with a bounded 200,000-unit ceiling.
pnpm --silent navigator:eval --mode level1 --max-reserved-tokens 200000 > /tmp/navigator-jev.json

# Rerun one case when investigating a result.
pnpm --silent navigator:eval --mode level1 --case confirmation
pnpm navigator:eval --help
```

Level 1 replay evaluates the provider directly on the same contexts as the rules baseline. It does not run rules first or call Level 2. The real worker now sends unaddressed messages directly through Jev in semantic mode; keyword rules cannot bypass execution-intent detection. Compatible-provider and rules-only paths retain their previous behavior. Replay stops after a provider/validation error and never retries a paid call. A conservative reservation is made before each call, including failed calls; over-budget cases remain visible as skipped. The adapters bound request/response size and enforce their existing timeouts. Replay limits are independent of channel daily budgets.

Use `--input-usd-per-million` and `--output-usd-per-million` only with verified prices for the configured provider. Without both prices, or when usage is unknown, `estimatedUsd` is null. Reported tokens are not a bill; byte-based reservations deliberately overestimate usage. Compatible adapters returning zero/zero usage are treated conservatively as unknown for cost reporting.

The command exits nonzero on errors or skipped cases. Incorrect decisions are findings, not runner errors; add `--require-perfect` to make any mismatch fail the command. Use `--silent` when redirecting JSON to avoid package-manager script headers.

## What the metrics mean

- **Coverage:** completed cases / all selected cases. Always check this before accuracy.
- **Accuracy:** expected action and, for suggestions, the exact expected capability set / completed cases.
- **False-positive rate:** expected-ignore cases that returned any non-ignore decision / completed expected-ignore cases. This includes unnecessary escalation; it is not a count of executed work.
- **Missed-intent rate:** expected-action cases that returned ignore / completed expected-action cases. An escalation is not counted as a missed intent here, even if no Level 2 provider is configured.
- **Capability accuracy:** correctly suggested capability sets / completed cases labeled suggest. Escalation on those cases is a mismatch.
- **Latency:** nearest-rank p50/p95 of adapter calls, including failed calls. Rules have no model latency.

Zero denominators are null. Errors and skips are separate from accuracy denominators; a partial run must not be presented as full coverage. In particular, nine Level 1 escalations without a Level 2 provider means nine fallback ignores in the deployed routing policy, not nine successful suggestions.

## Historical v1 results — before execution-intent changes

| Check | Result |
| --- | --- |
| Automated validation | 60 targeted tests passed; worker/server/event-service builds and test-package typecheck passed |
| Rules baseline, starter corpus | 12/24 exact matches; 5/12 unnecessary interventions; 6/12 missed intents |
| Live Jev, default yes=0.7 / no=0.3 | 17/24 exact matches; 1/12 unnecessary interventions; 0/12 raw L1 ignores on actionable cases; 9 escalations |
| Live Jev capability matches | 4/8 cases labeled suggest; the other four escalated |
| Live Jev latency | p50 261 ms; p95 285 ms; 24 sequential calls |
| Live Jev usage | 21,295 input + 2,452 output tokens; 75,296 reserved units; USD not estimated |
| Live worker smoke | Real Jev through WAL/JetStream: one call, persisted suggestion, no tasks, 1.48 s end-to-end; provider latency 371 ms |

The live model returned `jev-1.14.0`. The worker smoke used a disposable schema and a synthetic echo request. It did not invoke a user's installed agent. A separate local HTTP fixture runtime test verified acceptance and task completion without paying for inference.

The initial runtime run exposed an older local CDC process repeatedly rejecting scheduled targets. Restarting the bridge with the current build restored delivery while preserving its replication slot. The worker's Turbo override was also updated to retain `NATS_URL` for non-default brokers.

Saved evidence:

- [Rules replay](../evaluations/navigator/2026-11-04-rules.json)
- [Live Jev decisions and probabilities](../evaluations/navigator/2026-11-04-jev.json)
- [Threshold comparison](../evaluations/navigator/2026-11-04-thresholds.json)
- [Live worker smoke](../evaluations/navigator/2026-11-04-live-worker.json)

The threshold comparison reused the saved Jev probabilities through the real native adapter with an injected local response, making zero additional model calls. With yes fixed at 0.7, no=0.4 matched 19/24, no=0.45 matched 21/24 and no=0.49 matched 22/24. This is exploratory fitting to the same labels. Defaults remain 0.7/0.3; do not claim calibration or change defaults solely from this result. Add independently labeled conversations before choosing thresholds. Two unavailable-capability requests escalated instead of clarifying even at no=0.49.

## Execution-intent v2 results — 2026-11-04

Final automated validation: **66 targeted tests passed**, including native transport, versioned decisions, permission/budget enforcement, rich-text context, managed-session privacy, acceptance during inference, cached replay and the real WAL/NATS worker path. Worker/server/event-service builds and test-package typechecking passed. Independent review reported no outstanding findings after the concurrency fix. The local CDC process initially failed to publish with NATS 503 errors and retained WAL; restarting it with the current build recovered delivery, and the fresh runtime run passed.

A live run of the approved execution-intent policy on `jev-1.14.0`, with unchanged 0.7/0.3 thresholds:

| Measure | Result |
| --- | --- |
| Coverage | 36/36, no provider errors or skipped cases |
| Exact action/capability match | 32/36 (88.9%) |
| Negative cases | 0/21 unwanted interventions |
| Actionable cases | 3/15 missed requests |
| Suggested capability sets | 10/13 exact matches |
| Escalations | 0 |
| Latency | p50 263 ms; p95 385 ms |
| Reported usage | 41,008 input + 3,544 output tokens |
| Conservative reserved units | 162,703 |
| Estimated inference cost | $0.001722336 |

The four mismatches are retained: flight booking stayed quiet instead of clarifying an unavailable skill; dependent investigation plus summary selected only investigation; a new summary alongside running work stayed quiet at clarity 0.69; Vietnamese confirmation stayed quiet at existing-work probability 0.36. English history confirmation, multiuser confirmation, pending-proposal confirmation, cancellation, acknowledgment, repeated confirmation of running work and explicit redo matched their labels.

An earlier one-call development smoke missed a summary request (clarity 0.60); the prompt was then clarified to distinguish routing clarity from having all execution inputs. Its 1,071 input / 99 output tokens add $0.000044982. Total for this change: 37 paid calls, estimated **$0.001767318**. Prices verified against [TypeSafe Models](https://docs.typesafe.ai/models): $0.042 per million input tokens, free output. These are usage-based estimates, not an invoice.

Saved evidence:

- [Live v2 decisions, probabilities and usage](../evaluations/navigator/2026-11-04-execution-intent-jev.json)
- [Offline rules comparison under v2 labels](../evaluations/navigator/2026-11-04-execution-intent-rules.json)
- [Initial development smoke](../evaluations/navigator/2026-11-04-execution-intent-smoke.json)
- [Exact current native prompt with synthetic proposal context](../evaluations/navigator/2026-11-04-execution-intent-request.json)

The full replay was recorded before adding the local work-state fingerprint/freshness check; those host-only fields do not change the questions or model inputs. The final host behavior is checked by deterministic integration tests. The corpus is small and authored during development, with no held-out production sample. No thresholds or labels were changed to fit these 36 outputs.

## Manual product acceptance

1. Start the current built CDC bridge, API, web app and worker. A running worker must be restarted to load changed `.env` credentials. From the root, a worker can be started with `node --env-file=.env apps/worker/dist/main.js`. Keep one intended local worker per setup; the evaluation does not restart the existing application worker.
2. Create a dedicated test channel and grant an agent a relevant capability. Open **Navigator**, choose **Rules + optional model providers**, set cooldown to zero for the test, and use a sufficient daily reservation limit (for example 100,000).
3. Send a plain request without an `@tag`, such as a request to summarize the discussion when a summary capability is granted. Expect a suggestion delivered through realtime updates and no task until **Ask …** is selected.
4. Dismiss one suggestion. Send a fresh request and accept it. Verify exactly one task/session; a collaborator's request still requires the installation owner's approval where applicable. Reload and verify the result/session reference survives.
5. Try greetings, acknowledgments, postponements and code/quotation examples. Record false suggestions and missed requests instead of changing labels to make the model pass. Explicit `@agent` mentions bypass Jev and therefore do not test model quality.
6. Test revocation and a zero token limit: inference must stop, while explicitly authorized mention routing remains available. Restore the channel cooldown and budget afterward.

Jev execution-intent mode does not escalate. Level 2 remains available to compatible-provider configurations. Production throughput, multi-node failover, provider rate limits and accuracy on real conversations remain unverified. The local worker result is functional evidence, not a capacity claim.
