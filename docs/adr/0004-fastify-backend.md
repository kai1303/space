# ADR 0004: Fastify for the HTTP backend

Date: 2026-11-03
Status: Implemented at the owner's request; supersedes ADR 0001's manual HTTP server.

Use Fastify 5 in `@space/server`. The existing API is small and organized around
independent contracts and persistence modules. Fastify supplies routing, lifecycle
hooks, bounded JSON parsing, structured logging and in-process HTTP injection tests
without requiring controllers/dependency-injection modules throughout the domain.

`createApi(store)` returns a Fastify instance without listening or owning the supplied
pool. `main.ts` owns the production pool, attaches an onClose hook, awaits listening
and handles SIGINT/SIGTERM through `app.close()`. This keeps tests free to reuse their
isolated database pool while giving the process a graceful shutdown path.

Use explicit routes for the existing task, event, thread and installation APIs. Bearer
authentication runs in onRequest before payload parsing. Domain authorization remains
in the PostgreSQL task/foundation adapters and deterministic core policy. Keep the
runtime-neutral parsers in @space/contracts: no duplicated AJV schema or automatic
removal/coercion of unknown authority fields at this stage.

Preserve the 32 KiB body limit and the `{ error: code }` response format. Map framework
parse/media/size errors to safe public codes, and sanitize unknown server exceptions.
Request/body logging is disabled through Fastify's LogController; failure logs contain
a request ID rather than exception text or credentials. Repeated cursor query values
are explicitly rejected rather than selecting one silently.

No changes to task lifecycle, worker, transport adapters, database schema or user
onboarding. Add route plugins/modules when feature growth justifies them. W05 remains
the next unselected product module.

Validation: real-network API integration plus Fastify inject tests, PostgreSQL scope
checks, malformed/oversized/media-type handling, authorization-before-parse, all read
routes, approval/rejection, unsupported controls and sanitized internal errors.

References:
- https://fastify.dev/docs/latest/Reference/Server/
- https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/
- https://fastify.dev/docs/latest/Guides/Testing/
