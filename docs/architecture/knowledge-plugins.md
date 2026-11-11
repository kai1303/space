# Workspace knowledge plugins

Workspace owners and admins open **Agents & tools → Apps → Add MCP server**, then select **Space people directory**, **Space channel directory** or **External knowledge plugin** under **Connection type**. Save the connection, select **Test connection**, then grant search and optionally resolution to a paired agent under **Agent access**. This requires migrations through 081 and a configured [outbound gateway](outbound-mcp.md).

The people directory reads active memberships and profiles from PostgreSQL. Search accepts a name or job title, or an empty query with a `workspace_role` filter. Results contain the profile link and source fields. Resolve takes an exact installation-scoped reference. Guest directory restrictions apply to the requester and the channel audience. All plugins use the existing connection grants, deadlines, audit records and revocation checks.

The channel directory lists current workspace channels. An empty query lists visible channels; a name or `#name` narrows the results. Both search and resolve exclude archived channels and DMs, and enforce requester and originating conversation visibility. A public conversation never reveals private channels. In a private conversation, every active participant must belong to each private channel returned. Guests only see channels they have joined. Each citation has a `#name` label and a stable Space channel URL; an agent can use the pair as a Markdown link to render a clickable channel tag. Channel access is granted separately from people search.

## External provider protocol

Implement a Streamable HTTP MCP server. Return JSON objects in MCP `structuredContent`. The TypeScript interface and field names are in [the shared contract](../../packages/contracts/knowledge.ts). The gateway discovers these upstream tools:

| Tool | Arguments | Successful result |
| --- | --- | --- |
| `knowledge_manifest` | `{}` during discovery | `{apiVersion: 1, name, description, filters?}` |
| `knowledge_search` | `{context, request: {query, filters?, cursor?, limit}}` | `{hits, nextCursor?}` |
| `knowledge_resolve` (optional) | `{context, ref: {connectionId, recordId}}` | `{hit}`, or `{hit: null}` when no visible record matches |

Each filter has a unique lowercase `key`, a `description`, and optional allowed string `values`. The gateway publishes the corresponding input schema to the agent. Search defaults to 10 results and accepts 1–50. Preserve the search scope across pages and use stable record IDs even when a title changes.

For example, a service catalog can return this hit for a billing search, using the supplied connection ID:

```json
{
  "ref": {"connectionId": "cf8b67e6-48be-4842-8172-0c784b66abce", "recordId": "billing"},
  "title": "Billing service",
  "evidence": "Finance Operations owns the billing service.",
  "citation": {"label": "Service catalog · Billing", "url": "https://catalog.example/services/billing"}
}
```

Optional facts use `{subject, predicate, value}`. A value can be a string or a record reference. For a verified owner mapping, return the installed directory connection ID and the Space user ID. Agents can follow it through that directory's granted resolve tool. A reference itself grants no access. The directory's profile citations open relative to the Space web origin. External citations use HTTPS. A thread provider may also return a canonical Space message path as a citation. It must check the current source message and both requester and destination access before returning text. See the [thread ingestion setup](../../apps/mcp-gateway/providers/pg-knowledge/README.md#opt-in-channel-threads).

The gateway supplies `workspaceId`, `connectionId`, `requesterId`, `installationId` and `audience: {kind: "channel", channelId}`. Authenticate the gateway using the configured bearer token before trusting that context for private data. The provider must check its own ACLs for both the requester and the destination audience. If the audience cannot be authorized, return an MCP error. Empty hits indicate a successful search with no visible matches. v1 conservatively uses the originating channel as the audience. Only search and resolve can be granted on a knowledge connection.

## Agent notes

A note is one long-term fact, decision, procedure or answer saved on purpose. Notes belong to one channel and are visible to anyone who can see that channel, checked live on every search. Turn them on per channel with **Memory → Knowledge notes** (channel creator or workspace owner/admin). Migration 088 is required.

Agents save notes in two ways. Paired agents add up to three `notes` to the hidden `<space-memory>` turn-end block. MCP clients with a channel key use `knowledge_add`; write keys also get `knowledge_update` and `knowledge_remove`. Both need the installation's **Read and contribute knowledge** grant. A note with the same title as a live note in its channel becomes a new revision of it; every version is kept in `knowledge_note_revisions`. Evidence must be messages from the note's own channel.

Each task receives the newest 20 titles as `context.knowledge_notes` when the switch is on and the agent has read access. Full text comes from `knowledge_search` with `filters.source = "notes"` on the pg-knowledge provider. The provider re-checks the note's revision, the switch and channel access in Space with `knowledge_visible_notes()` before returning text. See the [notes setup](../../apps/mcp-gateway/providers/pg-knowledge/README.md#knowledge-notes).
