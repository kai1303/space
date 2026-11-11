# Thread working memory

A thread is an agent’s short-term working context. Its original messages remain the
source of truth. Reading a thread does not enable durable channel memory or copy
anything into it. Channel knowledge still requires opt-in and defaults to Markdown
files through the existing replaceable provider.

The shared PostgreSQL context reader supplies the original request, the latest 16
messages, attachment metadata and an optional Markdown memory. Message excerpts
are limited to 1000 characters and carry `text_truncated`; MCP can read full source
text separately. Conversation order uses channel sequence numbers, never timestamps.
Only messages and memories at or before the requested watermark are included.
Agent invocations include this under `context.working_memory`; the legacy bounded
`context.messages` projection remains available. Local Codex receives the context as
quoted data. AG-UI receives it through `forwardedProps.context`.

Navigator uses the same reader and passes the original request and memory as
reference data alongside recent messages. Jev keeps `last_message` separate from
`history` and `working_memory`. Memories do not create new requests, confer
permissions, or count as proof that work was completed. Explicit mentions and active
ownership retain their existing deterministic routing.

## Suggested replies in long threads

The thread composer requests a draft when it needs a suggestion. With `XAI_API_KEY` configured on the API server,
threads with up to 50 visible messages use recent message excerpts directly. In longer
threads the API first folds older text into a rolling summary, then sends the summary
and the latest 50 turns to the reply model. Private agent-session messages, deleted
messages and messages erased by retention are excluded from both inputs.

Migration 069 stores the summary and its position on the thread. This summary is
specific to suggested replies and is shared across participants. Each successful
batch advances the position, including within a long message. A later request resumes
from that position. Concurrent requests can duplicate a model call, but only one
result can advance a given position. Changes to visible source text or visibility
invalidate the summary. Each model request fits within 12 KiB. A suggestion request
has a 30-second deadline; if catch-up or generation fails, the composer gets no draft
and the next request can reuse any completed batches.

## Agent tools

Use the existing Streamable HTTP MCP endpoint, `/mcp/memory`, with a **thread-scoped**
bearer key. The key chooses its thread; tool arguments cannot choose a different one.
Channel-memory keys retain their previous tools and opt-in requirements.

| Tool | Access | Purpose |
| --- | --- | --- |
| `thread_context` | read/write | Original request, recent messages, watermark and history flag |
| `thread_messages` | read/write | Oldest-first evidence pages; optional `after` cursor and `limit` (1–50) |
| `thread_message` | read/write | Full source text for one `message_id` in the granted thread |

Agents read context first and inspect relevant sources. They no longer write memory: it is built from the messages.

## Layered memory (Graph RAG)

Short-term memory has three layers: channel → thread → session. Every node returns `ref`, `parent`, `summary`, `updated_at` and `children`, so agents can walk down and back up. The design is in [the Graph RAG memory spec](../superpowers/specs/2026-11-11-graph-rag-memory-design.md).

All three layers come from messages. A change-data-capture reader copies messages, with a local embedding each, into the `space_memory` graph in the knowledge database. Readers in Space ask that graph which messages matter for a `query`, then read the text from Space in the asked scope only. Without the graph (`MEMORY_GRAPH_URL` unset) memory still reads, newest first. A worker with a local model also writes topics and facts per thread; a fact is shown only if all its evidence messages are live in that thread.

| Tool | Key | Returns |
| --- | --- | --- |
| `channel_memory` | Channel | Threads active in the last 7 days by their root line, newest first, keyset-paged by `next_cursor`; with `query`, ranked by meaning |
| `thread_memory` | Channel | Root, recent messages (session messages excluded), up to 8 related to `query`, topics, facts and session nodes |
| `session_memory` | Channel, bound to the session's installation | Recent session turns and up to 8 related to `query` |

Tasks receive `context.working_memory`, `context.agent_session_memory` and the first page of `context.channel_memory`, without ranking, so preparing a task never waits on the graph. Migration `093_drop_agent_memory.sql` deletes the old agent-written memory; take a backup first. The hidden `<space-memory>` block now carries only knowledge `notes`.

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
the token in a memory. It is stored hashed on the server. `access: "read"`
omits the memory-writing tool. This route works while channel memory is off.
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
