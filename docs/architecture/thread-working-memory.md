# Thread working memory

A thread is an agent’s short-term working context. Its original messages remain the
source of truth. Reading a thread does not enable durable channel memory or copy
anything into it. Channel knowledge still requires opt-in and defaults to Markdown
files through the existing replaceable provider.

The shared PostgreSQL context reader supplies the original request, the latest 16
messages, attachment metadata and an optional Markdown checkpoint. Message excerpts
are limited to 1000 characters and carry `text_truncated`; MCP can read full source
text separately. Conversation order uses channel sequence numbers, never timestamps.
Only messages and checkpoints at or before the requested watermark are included.
Agent invocations include this under `context.working_memory`; the legacy bounded
`context.messages` projection remains available. Local Codex receives the context as
quoted data. AG-UI receives it through `forwardedProps.context`.

Navigator uses the same reader and passes the original request and checkpoint as
reference data alongside recent messages. Jev keeps `last_message` separate from
`history` and `working_memory`. Checkpoints do not create new requests, confer
permissions, or count as proof that work was completed. Explicit mentions and active
ownership retain their existing deterministic routing.

## Agent tools

Use the existing Streamable HTTP MCP endpoint, `/mcp/memory`, with a **thread-scoped**
bearer key. The key chooses its thread; tool arguments cannot choose a different one.
Channel-memory keys retain their previous tools and opt-in requirements.

| Tool | Access | Purpose |
| --- | --- | --- |
| `thread_context` | read/write | Original request, recent messages, checkpoint, watermark and history flag |
| `thread_messages` | read/write | Oldest-first evidence pages; optional `after` cursor and `limit` (1–50) |
| `thread_message` | read/write | Full source text for one `message_id` in the granted thread |
| `thread_checkpoint` | write | Revision-checked, source-linked Markdown working summary |

Agents should read context first, inspect relevant sources, then save useful
decisions, constraints, open questions, user feedback and results in a checkpoint.
The server does not run an extra LLM or automatically generate summaries.

Example `thread_checkpoint` arguments:

```json
{
  "revision": 0,
  "through_sequence": "42",
  "content": "# Decisions\nUse TypeScript.\n\n# Open questions\nWho reviews the draft?",
  "source_message_ids": ["11111111-1111-4111-8111-111111111111"]
}
```

Use revision 0 initially, then the current checkpoint revision. The watermark must
identify a real message in this thread; every supporting source must be in the same
thread at or before it. Content is at most 6000 characters with 1–32 source IDs.
Competing writes serialize and stale revisions return a conflict. Re-read before
merging and retrying. Revisions retain producer identity and time in PostgreSQL;
these are derived Markdown working notes, separate from provider-backed channel
memory. A later-watermark checkpoint is excluded from earlier context snapshots.

## Granting access

As a current channel manager, send:

```http
POST /v1/channels/:channelId/threads/:threadId/context/connections
Content-Type: application/json
Authorization: Bearer <human-api-token>

{"name":"Research agent","access":"write"}
```

The response contains `connection` and a one-time `token`. Configure your MCP client
with the server’s `/mcp/memory` URL and `Authorization: Bearer <token>`. Do not store
the token in a checkpoint. It is stored hashed on the server. `access: "read"`
omits the checkpoint-writing tool. This route works while channel memory is off.
External agents require this explicit grant; connector credentials are not MCP keys,
and native connectors are not automatically provisioned with one.

Current channel members can inspect working context with:
`GET /v1/channels/:channelId/threads/:threadId/context`.
Managers can list grants at `GET /v1/channels/:channelId/memory/connections` (each
includes `thread_id`, null for channel keys), and revoke one with
`POST /v1/channels/:channelId/memory/connections/:connectionId/revoke` and body `{}`.
The existing 20-key channel limit applies to both grant types. Membership and
revocation are rechecked on every MCP call. A thread grant exposes no channel-memory
tools and no neighboring-thread content. Files retain the existing authorized
attachment download flow; MCP context returns metadata only.

Apply migration `026_thread_context.sql` with the normal `pnpm migrate` workflow
before starting the updated server and worker. No new model or database dependency
is required. Validation uses disposable PostgreSQL schemas and a real MCP client;
it does not exercise a production agent or cloud model.
