# Channel memory MCP

The user requested MCP tools so AI agents and the LLM Navigator can extract and
manage knowledge through the existing optional memory providers. The model/client
does extraction; the MCP server supplies authorized conversation context and memory
tools. It does not require a particular model or run a hidden extraction model.

## Connection and authorization

Expose a stateless Streamable HTTP endpoint `/mcp/memory` using the official MCP SDK.
Channel managers create named, revocable, channel-scoped MCP keys from Memory. Read
keys can read/search memory and read channel messages for extraction. Write keys
add remember, revision-checked document updates and source removal. Keys are shown
once, hashed at rest, bounded in number per channel, and never accepted as human or
agent-connector credentials. Each request and each tool invocation rechecks the
key, creator's current channel membership, memory opt-in, and current permission.
Revocation, offboarding and disabling memory prevent new tool calls immediately.

The token's channel is fixed: tools never accept a workspace/channel ID. Browser
requests use an explicit Origin/Host allowlist. CLI clients omit Origin. HTTPS is
required outside loopback by deployment configuration. MCP tools cannot enable
memory, switch its provider, create keys, or clear the entire provider.

## Tools

- `memory_read`: canonical content, revision, source metadata.
- `memory_search`: bounded relevant excerpts.
- `memory_context`: paginated channel message events and a continuation cursor,
  including the message IDs an agent needs for evidence.
- `memory_remember`: append extracted fact/decision/procedure/answer with a stable
  caller-generated ID, model-generated title/content, and mandatory supporting
  message IDs from this channel or existing saved source IDs from the selected provider. Server stamps the MCP connection identity/time and
  resolves evidence links from the actual messages. Replays with identical input
  are idempotent; conflicting ID reuse is rejected.
- `memory_write`: replace canonical Markdown with a required expected revision.
- `memory_forget`: remove one named saved source.

All tools use the selected provider and existing serialized channel access. Human
Markdown editing/imports remain available. Knowledge provenance is retained in
Markdown as a `knowledge:<UUID>` source section with evidence links. It represents
an agent-authored claim, not a server-certified fact. Retrieved text remains data.

## Verification

Use a real MCP client over a real loopback HTTP listener for initialization,
discovery, context, extraction saves, read/search/write/forget, duplicate handling,
permission denial, revocation, disable/re-enable and offboarding. Test custom
providers, hostile Origin/Host, malformed tools, source isolation, key hashing and
secret-free listings. UI tests cover key creation, copyable config and revocation.
Run the complete test/typecheck/build graph and migrate/restart only the verified
local development API. Preserve the user's all-untracked repository without commits.
