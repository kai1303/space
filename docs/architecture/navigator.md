# Navigator and conversation routing

Navigator routes human messages and proposes relevant agents inside existing chat threads. The default mode is `rules`; no model credentials, API calls or inference tokens are required. Direct mentions and approved thread subscriptions also work when suggestions are off.

## Routing order

1. An explicit `@tag` selects an eligible installation. The composer’s mention picker lists channel-granted agents. Unique names use normalized tags such as `@writer`; colliding names use the stable `@agent-<installation UUID>` form. Quoted/code examples do not invoke agents, including structured composer code blocks and quotations.
2. An active subscription routes human follow-ups to its owning installation and skill. A repeated tag to that owner follows the same path. While work is queued/running or awaiting approval, incoming messages stay durable until the current task finishes. The next execution reuses the approved session; it makes no Navigator inference call.
3. Without a direct target or subscription, configured rules match keywords to granted capability IDs. One batch can suggest multiple capabilities.
4. In `semantic` mode only, unresolved batches can call the configured Level 1 provider. It returns ignore, suggest, clarify, or escalate. Escalation may call Level 2 when that provider is configured and budget remains. Level 2 can return bounded task proposals with validated acyclic dependencies. These are proposals; no dependency execution scheduler is provided.

An explicit tag to a different agent takes precedence and establishes the new subscription; an already executing previous task is not cancelled. Unknown/ambiguous tags do not fall back to another agent. Multiple eligible skills on the tagged installation produce a skill-choice suggestion. Selecting a suggestion never silently selects a different installation.

## Authorization and ownership

Existing installation ownership, workspace/channel membership and skill grants remain authoritative. An owner’s direct invocation is approved through the existing task policy. Another participant’s initial invocation waits for the installation owner’s approval. Suggestions create no execution until somebody selects an eligible agent; the same policy then applies.

Approval establishes conversation continuity for that installation/skill/thread. Subsequent currently authorized human participants can supply follow-ups under that approved subscription. Permission checks run again during routing and dispatch. An installation owner or channel manager can use **End agent follow-ups** to close the subscription; this stops future automatic delivery and does not cancel an execution already running. Revoked installations/grants cannot receive new work. Files with no request do not independently invoke an agent.

## Durable processing

Migration 020 adds a human-message insert trigger and per-thread queue. Agent messages do not wake Navigator, preventing self-trigger loops. The trigger commits with the message; retries retain existing message identity and do not enqueue duplicate input.

The worker claims a 45-second lease, reads at most 20 pending human messages, and batches unaddressed input up to the next explicit mention. A one-second initial delay allows short message bursts to accumulate. Explicit mentions are processed in order. A thread watermark, unique decision keys, stable task idempotency keys and lease fencing prevent duplicate dispatch. Pending messages survive process restarts. The first queue wake starts at the new message; historical tags are context and are never retroactively invoked. A blocked thread is rescheduled so other threads can progress.

Routing commits tasks, subscriptions, decisions and cursor advancement transactionally. Before committing, it rechecks access, catalog eligibility and current subscription ownership. New ownership supersedes an in-flight unowned-thread classification. Suggestion acceptance is serialized and idempotent; changed choice on an already accepted suggestion is rejected. Establishing ownership dismisses pending suggestions in that thread.

Model calls happen outside database transactions. Each call first reserves a conservative token amount in PostgreSQL under the channel lock. Reservations and their per-batch/level key survive restarts; a retry reuses a stored result and never repeats a call with an unknown outcome. Failed calls retain their reservation. Daily limits are per channel and use the database’s current date. Reported usage and latency are saved separately; the limit is conservative reserved tokens, not a currency spending estimate. Provider availability, failure, invalid output or exhausted budget never disables explicit routing or subscriptions.

The delivery loop runs independently of the navigation loop, so model inference does not block execution delivery. Each conversational invocation includes up to 16 text messages from its origin thread, bounded to 1,000 characters each and to the triggering decision’s watermark. Agent session IDs remain stable across follow-ups. Connectors remain responsible for mapping that session to their runtime and making external tool side effects idempotent.

Conversational tasks publish milestone progress and final results through normal agent-authored messages. Detailed response/tool rendering uses the existing agent response contracts. The older task demo remains compatible. Migration 020 permits separately identified progress messages while preserving a unique final result per task; receipt IDs and ordered agent events fence duplicate output.

## Configuration

Open **Navigator** in a channel. Channel managers can choose:

- **Off:** explicit mentions and subscriptions only.
- **Rules only:** deterministic suggestions, no inference.
- **Rules + optional model providers:** rules first, then optional classification/escalation.

Rules use one line per capability, for example:

```text
writing.draft: announcement, draft, write
incident.investigate: timeout, incident, failed
```

Skills must correspond to actual installed/granted capabilities to produce a useful candidate. Navigator matches up to 100 eligible catalog rows and returns at most eight capability IDs. Suggestions refresh in the channel/thread every five seconds. Selection and dismissal failures remain visible. Navigator settings do not enable channel memory.

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
- `GET /v1/channels/:id/navigator/suggestions?thread_id=<id>`: pending scoped suggestions.
- `POST /v1/navigator/suggestions/:id/accept`: `{installation_id,skill}`; idempotent task proposal/dispatch under existing policy.
- `POST /v1/navigator/suggestions/:id/dismiss`: `{}`.
- `GET /v1/threads/:id/agent-subscription`: active ownership and whether the caller may end follow-ups.
- `POST /v1/threads/:id/agent-subscription/close`: `{}`; owner/manager only.

Thread history is available independently of opt-in knowledge memory. Navigator does not automatically extract/save memory or enable a provider. Agents/Navigator hosts that perform extraction use the existing separately authorized [Memory MCP](memory-mcp.md).

## Verification boundaries

Tests use disposable PostgreSQL schemas and real loopback HTTP model fixtures. They verify routing, approval, batching, follow-up queueing/session reuse, permissions, inference escalation/reservations, output validation, timeout/size limits and UI suggestion controls. No paid provider was invoked. Actual model quality, Jev/DeepSeek deployment compatibility and production load remain unverified. Chat-to-runtime execution still uses the existing mock connector; local connector enrollment/readiness alone does not execute real agent turns.

Verified locally on 2026-11-03: full monorepo test graph passed 457 tests, with build and typecheck passing. Independent review and regressions covered stale cached output after revocation, numeric queue ordering, historical first-wake suppression, batch context boundaries, global final-result uniqueness, and legacy migration rollback/preservation.
