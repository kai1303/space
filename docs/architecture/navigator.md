# Navigator and conversation routing

Navigator routes human messages and proposes relevant agents inside existing chat threads. The default mode is `rules`; no model credentials, API calls or inference tokens are required. Direct mentions also work when suggestions are off. Ordinary thread replies do not implicitly invoke an agent. Connected agents inherit their owner’s current conversation access and need no per-channel skill grants. Unpaired installations retain explicit grants. Workspace boundaries, supported capabilities, connection revocation and owner approval still apply.

## Routing order

1. An explicit `@tag` selects an eligible installation. The composer’s mention picker lists channel-granted agents. Unique names use normalized tags such as `@writer`; colliding names use the stable `@agent-<installation UUID>` form. Quoted/code examples do not invoke agents, including structured composer code blocks and quotations.
2. Local Codex requests create a managed persistent session and first turn, with a durable session reference in the source thread. Each explicit request creates an independent session. Non-Codex connectors retain their explicit one-shot dispatch path.
3. Without a direct target, configured rules match keywords to granted capability IDs in rules-only mode and with compatible providers. Jev semantic mode instead requires a clear execution request; keywords never bypass that gate. One batch can suggest multiple capabilities; no run starts before a user accepts.
4. In `semantic` mode only, unaddressed batches can call the configured Level 1 provider. Jev uses conversation and bounded public work state to classify new execution requests, escalating plausible ambiguous requests and existing work to Level 2; new-work suggestions still require acceptance. For compatible providers, unresolved rules batches can call Level 1. It returns ignore, suggest, clarify, or escalate. Escalation may call Level 2 when that provider is configured and budget remains. Level 2 can return bounded task proposals with validated acyclic dependencies. These are proposals; no dependency execution scheduler is provided.

Unknown/ambiguous tags do not fall back to another agent. Multiple eligible skills on the tagged installation produce a skill-choice suggestion. Selecting a suggestion never silently selects a different installation. Follow-ups can use the selected session composer or semantic routing in the source thread. A `continue` or `stop` decision must name a supplied active managed session and cite exactly the latest pending human message. Progress questions and acknowledgments are not execution requests. Ambiguous targets require clarification; the host never guesses an ID. Ordinary discussion never inherits a previous request or approval.

## Authorization and ownership

Existing installation ownership, workspace/channel membership and skill grants remain authoritative. An owner’s direct invocation is approved through the existing task policy. Another participant’s initial invocation waits for the installation owner’s approval. Suggestions create no execution until somebody selects an eligible agent; the same policy then applies.

Each new request retains the installation owner's approval policy. Session follow-ups keep that session identity but recheck authorization and approval. Historical thread subscriptions are closed by migration033 and ignored by routing. Existing executions are not cancelled by that migration. Revoked installations/grants cannot receive new work. Files with no request do not independently invoke an agent.

## Durable processing

Migration 020 adds a human-message insert trigger and per-thread queue. Agent messages do not wake Navigator, preventing self-trigger loops. The trigger commits with the message; retries retain existing message identity and do not enqueue duplicate input.

A durable JetStream event targets one thread. With active managed sessions, semantic requests are classified individually so one follow-up cannot consume another pending request. The worker reads at most 20 pending human messages, and batches unaddressed input up to the next explicit mention. A one-second initial delay allows short message bursts to accumulate. Explicit mentions are processed in order. A thread watermark, unique decision keys, stable task idempotency keys and optimistic watermark comparisons prevent duplicate dispatch. Pending messages survive process restarts. The first queue wake starts at the new message; historical tags are context and are never retroactively invoked. Independent sessions may have work pending in the same source thread; each session rejects overlapping turns.

Routing commits sessions, first tasks, session reference messages, decisions and cursor advancement transactionally. Before committing, it rechecks access and catalog eligibility. Suggestion acceptance uses serializable transactions and is idempotent; changed choice on an already accepted suggestion is rejected. Starting a request dismisses pending suggestions in that thread.

Model calls happen outside database transactions. Each call first reserves a conservative token amount in PostgreSQL inside a serializable transaction with a unique per-batch/level key. Reservations and their per-batch/level key survive restarts; a retry reuses a stored result and never repeats a call with an unknown outcome. Failed calls retain their reservation. Daily limits are per channel and use the database’s current date. Reported usage and latency are saved separately; the limit is conservative reserved tokens, not a currency spending estimate. Provider availability, failure, invalid output or exhausted budget never disables explicit routing.

Separate bounded delivery and navigation subscriptions run independently, so model inference does not block execution delivery. Each conversational invocation includes up to 16 text messages from its origin thread, bounded to 1,000 characters each and to the triggering decision’s watermark. Agent session IDs remain stable across follow-ups. Connectors remain responsible for mapping that session to their runtime and making external tool side effects idempotent.

Conversational tasks publish milestone progress and final results through normal agent-authored messages. Detailed response/tool rendering uses the existing agent response contracts. The older task demo remains compatible. Migration 020 permits separately identified progress messages while preserving a unique final result per task; receipt IDs and ordered agent events fence duplicate output.

## Deeper routing, authorization, and observation

Migration 057 adds the routing authorization ledger, durable pending follow-ups, policy versions, and observe mode. It must be applied before starting the updated server or worker.

A compatible Level 2 router may request `read_context` once, naming up to eight message IDs already supplied in the current thread context or root. The host retrieves only those messages from the same channel/thread, excludes rich quoted/code instructions, and caps each excerpt at 2,000 characters with an 8,000-byte shared retrieval budget. The full provider request still has a 32 KiB limit. Automatic continuation/stop requires the complete latest request: if the target is truncated, Level 2 must retrieve it fully or ask for clarification. Private session turns, arbitrary files, other threads, and external URLs are not read by this capability. A third durable inference reservation covers the final L2 decision. Repeated reads, unknown IDs, changed inputs, and exhausted budgets fail closed. A truncated latest Jev target bypasses its incomplete classification and may reach configured Level 2.

`continue` retains session identity and uses the existing session-send path. Busy sessions hold up to 32 pending requests per thread; committed task completion and session-end events wake delivery. Requests stay ordered, and pending human messages are routed before waiting requests dispatch, allowing a following stop to cancel them. No timer scans the queue. The requester's current access, unchanged source text/document, and the installation owner's approval policy are rechecked before dispatch. Ending or stopping a session cancels waiting continuations, including when its last task already finished.

Each accepted start, continuation, or stop records immutable actor, source message, decision, channel/thread, installation, skill, session, requested scope, and policy fingerprint. This is an authorization record, not permission to bypass an owner approval or an executor sandbox. Policy changes generate a fresh version and cancel waiting continuations. Replays check the classified context, full source text/document, observed human head, policy, and public work-state snapshots. Changed or unknown-outcome inference is never paid for again automatically. Already executing work retains existing task/session controls.

Channel `execution_mode` is independent of `mode`. The default `suggest` preserves new-work suggestions and permits authorized semantic continuation/stop. `observe` records inferred decisions without creating suggestions, tasks, continuations, or stops. Direct mentions remain explicit requests. Managers can review the latest 20 observed/unavailable decisions in the settings dialog and refresh explicitly; the review does not poll. Use observe before enabling model-driven follow-ups with a new provider. These tests validate enforcement and transport, not live model routing accuracy.

## Configuration

Open **Navigator** in a channel. Channel managers can choose:

- **Off:** explicit mentions only.
- **Rules only:** deterministic suggestions, no inference.
- **Rules + optional model providers:** rules first with compatible providers; Jev instead requires execution-intent classification for unaddressed messages.

Rules use one line per capability, for example:

```text
writing.draft: announcement, draft, write
incident.investigate: timeout, incident, failed
```

Skills must correspond to actual installed capabilities authorized through owner access or legacy grants to produce a useful candidate. Navigator matches up to 100 eligible catalog rows and returns at most eight capability IDs. Suggestions refresh from authorized realtime channel updates with reconnect catch-up. Selection and dismissal failures remain visible. Navigator settings do not enable channel memory.

For native Jev setup, see [Native Jev navigation](jev-navigator.md). For compatible providers, configure the worker using complete Chat Completions endpoint URLs:

```sh
# Optional local fast classifier; model names are examples supplied by your deployment.
NAVIGATOR_L1_URL=http://localhost:11434/v1/chat/completions
NAVIGATOR_L1_MODEL=<installed-local-model>
# NAVIGATOR_L1_API_KEY=<optional credential>

# Optional independently configured escalation provider.
NAVIGATOR_L2_URL=https://your-provider.example/v1/chat/completions
NAVIGATOR_L2_MODEL=<escalation-model>
# NAVIGATOR_L2_API_KEY=<provider credential>
```

Jev has a native optional Level 1 adapter; DeepSeek Flash remains a candidate Level 2 model. Neither is selected automatically or required. Configure an endpoint/model explicitly after verifying its supported protocol. A deployment can use local providers, cloud providers, a mix, or neither. The adapter follows documented [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) and [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility) request shapes; it does not assume every provider implements the same extensions.

The adapter separates system instructions from untrusted conversation/catalog data, requests JSON, validates known capability/evidence IDs, and rejects malformed decisions/dependency cycles. It caps requests at 32 KiB, responses at 64 KiB, output at 512/1,024 tokens for Level 1/2, and each HTTP call at ten seconds including response-body reads. HTTPS is required except for loopback HTTP. Redirects are rejected so credentials cannot be forwarded to another endpoint. Credentials and raw provider errors are not exposed through channel APIs or logs. Enabling semantic mode explicitly allows that channel’s bounded conversation context to be sent to operator-configured providers.

## Interfaces

- `GET/PATCH /v1/channels/:id/navigator`: visible catalog/settings; manager-only changes.
- `GET /v1/channels/:id/navigator/observations`: manager-only latest 20 observed/unavailable decisions.
- `GET /v1/channels/:id/navigator/suggestions?thread_id=<id>`: pending scoped suggestions.
- `POST /v1/navigator/suggestions/:id/accept`: `{installation_id,skill}`; idempotent task proposal/dispatch under existing policy.
- `POST /v1/navigator/suggestions/:id/dismiss`: `{}`.
- `GET /v1/threads/:id/agent-subscription`: legacy subscription metadata (migration compatibility only).
- `POST /v1/threads/:id/agent-subscription/close`: `{}`; owner/manager only; legacy cleanup, not current routing control.

Thread history is available independently of opt-in knowledge memory. Navigator does not automatically extract/save memory or enable a provider. Agents/Navigator hosts that perform extraction use the existing separately authorized [Memory MCP](memory-mcp.md).

## Verification boundaries

Tests use disposable PostgreSQL schemas and real loopback HTTP model fixtures. They verify routing, independent session creation, approval, batching, explicit semantic follow-ups, durable session references, permissions, inference escalation/reservations, output validation, timeout/size limits and UI suggestion controls. Automated provider fixtures do not invoke paid inference. An explicit live Jev replay and real-worker smoke were run on 2026-11-04; see [evaluation results and test commands](navigator-evaluation.md). Representative model quality, Level 2 deployment compatibility and production load remain unverified. Local Codex execution is covered separately by connector and integration tests.

Verified locally on 2026-11-03: full monorepo test graph passed 457 tests, with build and typecheck passing. Independent review and regressions covered stale cached output after revocation, numeric queue ordering, historical first-wake suppression, batch context boundaries, global final-result uniqueness, and legacy migration rollback/preservation.

Verified locally on 2026-11-04: a browser mention created a managed session; two real Codex turns completed in that same session; reloading and opening its saved reference retained both turns. An ordinary discussion reply advanced the routing watermark without creating another task. Targeted validation passed 69 backend integration tests, 240 web tests and 100 UI tests, plus build and type checking. This is local functional evidence, not production or load verification.
