# Memory MCP for agents and Navigator

The endpoint **`/mcp/memory`** exposes channel memory over MCP Streamable HTTP.
The `memory_*` tools read and edit the channel’s saved document, which the built-in Markdown provider stores in Space PostgreSQL. The channel, thread and session tools read conversation history. An optional graph ranks related messages, and a worker extracts topics and facts with message citations. The `knowledge_*` tools manage revisioned notes under the separate Knowledge switch. The server checks the connection’s scope and permissions on each call.

## Connect

1. Open a channel's **Memory** panel and enable memory.
2. Under **Connect an agent or Navigator**, give the connection a name and choose
   read access or read/write access. Both permissions include reading conversations
   in this one channel so a model can extract knowledge from them.
3. Create a key, then copy its MCP configuration into your agent or Navigator host.
   The secret is shown once and is not recoverable from the connection list.

Example for a client supporting the common `mcpServers` configuration shape:

```json
{
  "mcpServers": {
    "space-memory": {
      "url": "http://127.0.0.1:5173/mcp/memory",
      "headers": {
        "Authorization": "Bearer <channel-memory-key>"
      }
    }
  }
}
```

Configuration syntax differs between MCP hosts; the transport URL and Authorization
header are the connection contract. The copied URL uses the web app's origin. Vite
forwards `/mcp` to the API; deployed web gateways must forward that path too. A
client may instead connect directly to the API origin, e.g. loopback port 3000.

The endpoint supports explicitly configured bearer keys. It does not implement
interactive OAuth discovery/consent; clients that only support OAuth need a later
OAuth integration. Local Codex pairing credentials and human login tokens are not
MCP keys, and creating a key does not automatically install it in an agent's config.

## Tools

| Tool | Access | Behavior |
| --- | --- | --- |
| `memory_read` | Read | Canonical memory content, revision, and saved sources |
| `memory_search` | Read | At most 20 matching excerpts from the selected provider |
| `memory_context` | Read | Channel messages with evidence IDs; `after` cursor and `limit` (1–50, default 20) |
| `memory_remember` | Write | Save a source-backed extracted claim with producer identity and timestamp |
| `memory_write` | Write | Replace canonical memory using its exact expected revision |
| `memory_forget` | Write | Remove one `message:`, `document:` or `knowledge:` source section |
| `channel_memory` | Read | Recent threads (7 days) by the first line of their root; `after`, `limit` 1–50; optional `query` ranks by meaning. The first page adds the channel's name, topic, description and, when the topic is empty, `top_topics` |
| `thread_memory` | Read | Root, recent messages, messages related to `query`, topics, facts and the session list |
| `session_memory` | Read | Own session only (installation-bound key); others return `session_private`. Recent turns and turns related to `query` |
| `knowledge_list` | Read | Newest 20 live notes in this channel (id, kind, title, revision) |
| `knowledge_add` | Contribute/Write | Save a note with a caller UUID and 1–20 channel message IDs; a used title returns `title_taken` |
| `knowledge_update` | Write | Revision-checked change to a note; stale revisions return `note_conflict` |
| `knowledge_remove` | Write | Revision-checked removal; old versions stay stored |

Knowledge tools appear only while the channel's Knowledge switch is on. A channel key
can be created while memory or Knowledge is on.

Read-only connections do not advertise write tools, and write permission is checked
again when tools execute. Tools never accept a channel or workspace ID: the key
fixes that scope. MCP cannot enable/disable memory, change providers, issue keys or
clear the whole provider through a management operation. A write key can replace
the full document, including clearing its content, so grant it only to agents you
intend to let edit shared knowledge.

An extraction call looks like:

```json
{
  "name": "memory_remember",
  "arguments": {
    "id": "00000000-0000-4000-8000-000000000001",
    "kind": "decision",
    "title": "Database choice",
    "content": "Use PostgreSQL for transactional storage.",
    "message_ids": ["00000000-0000-4000-8000-000000000002"]
  }
}
```

Generate a UUID once for each extracted entry and retain it for retries. `kind` is
`fact`, `decision`, `procedure`, or `answer`. Titles are bounded to 160 characters,
claim content to 16,000, and message references to 20. The server resolves each
message from the key's actual channel and adds evidence links. Model output cannot
invent an accessible source by supplying a different channel ID.

For existing imported documents, pass `source_ids` from `memory_read`, for example
`["document:<UUID>"]`. Existing message or knowledge sources can also be referenced.
At least one message or saved source is required; each list is bounded to 20. Sources
must exist in this channel's selected provider. New claims are marked with
`knowledge:<UUID>`, the key's connection name/ID, save time, evidence references,
and a fingerprint of the normalized extraction input. Identical retries keep one
entry; reusing an ID with different input/producer returns `memory_source_conflict`.
Providers must preserve the optional source `fingerprint` for this retry behavior.

The model is responsible for the claim and for deciding when to update an existing
decision. Saving a claim does not certify it as correct. Conflicts with older claims
are not automatically resolved. As with manually edited Markdown, source markers
and fingerprints are editable, not immutable audit history. Removing a source does
not automatically remove other notes derived from it.

## Authorization and operations

Channel managers issue/revoke up to 20 named keys per channel. Keys are opaque,
stored only as SHA-256 hashes and never appear in list responses or application
request logs. Any current channel manager can revoke a key, including while memory
is disabled. Issuing requires enabled memory or enabled Knowledge notes. A lost creation response cannot be
recovered; revoke that named connection and create a replacement.

Every HTTP request and tool invocation rechecks the key, the creator's current channel
membership, channel opt-in and access level before and after the work. Channel keys
take no lock; a settings change during a call returns `memory_settings_changed`.
Revoked keys fail with 401; disabled memory blocks calls immediately. Offboarding the
creator blocks their keys. Re-adding that same identity restores its membership
eligibility unless a manager revoked the keys. There is no promise to recall content
already read by an agent.

MCP keys cannot authenticate to human APIs or the local connector namespace. Responses
use `Cache-Control: no-store`. Tool failures expose stable error codes, not provider
exceptions or connection credentials. Retrieved memory/conversations are reference
data and must not become privileged model instructions.

Loopback, configured authentication-origin hosts and `MEMORY_MCP_ALLOWED_HOSTS` are
allowed endpoint hosts. Other Host headers and untrusted browser Origins are rejected.
Non-loopback requests require HTTPS. Behind TLS termination, configure the existing
trusted proxy settings correctly so Fastify can identify HTTPS. Do not expose a
memory key in a URL or commit the copied configuration to a repository.

## Protocol and verification

The official MCP TypeScript server/client SDK 2.4.0 and Node adapter 2.1.2 provide
the protocol. The stateless per-request factory supports current MCP 2026 negotiation
and the SDK's 2025 legacy mode. No in-memory session is used for authorization, so
clients cannot retain permissions after revocation by holding a connection open.

References: [MCP Fastify serving guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/fastify.md),
[MCP HTTP factory](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md).

Acceptance tests run real MCP clients against a real loopback listener and temporary
PostgreSQL schemas. They cover both protocol modes, tool discovery, memory and
conversation reads, extracted message/document knowledge, retries, stale revisions,
read-only keys, foreign evidence, revocation, disabled memory, creator offboarding,
key hashing, hostile Host/Origin and custom provider selection. UI tests cover
issuance/configuration, revocation, disabled state and late secret responses.

Verified on 2026-11-03:

- All six real-client MCP acceptance tests passed, including both protocol modes,
  document/message evidence and alternate provider selection.
- Full monorepo test graph passed 291 tests (98 backend, 83 web, 68 shared UI,
  22 server/storage/filesystem, 20 connector); typecheck and build also passed.
- A browser-created write key and copied configuration were used by a real MCP
  client through the frontend proxy. It discovered six tools, read the fixture
  conversation, and saved extracted knowledge with producer/evidence references.
  Reopening Memory displayed that content; browser revocation removed the key.
- The local development database includes migration 012 (current version 014 from
  concurrent workspace changes). The running API serves the MCP endpoint and its
  Host protection. No real channel was opted in or issued a key by these checks.
- Code and provenance-path review reported no actionable findings. Browser testing
  used a production frontend build and a disposable database schema; its key was
  revoked and the fixture schema/files were removed afterward.

The model-generated claim in the protocol test was a synthetic fixture. No external
model, production service or load test was invoked. A real agent or Navigator host
still needs to be configured with its own model and the generated MCP connection.
