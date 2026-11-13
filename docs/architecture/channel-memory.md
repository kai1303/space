# Opt-in channel memory

Open **Memory** beside Messages in a channel. Memory is off until the channel
creator or a workspace owner/admin enables it. Ordinary channel members can then
edit shared notes, import `.md`, `.markdown` or `.txt` files, save selected messages,
search memory, remove sources, and export Markdown. Members choose which messages to save in the document. The built-in document provider runs with Space PostgreSQL.

Choose **More actions → Save to channel memory** on a message, then save it in the
memory dialog. The server reads its author, timestamp and text from the original
channel, so client-supplied text cannot forge the source. Repeated saves of the same
message have one source entry. Source links open an authenticated original-message
dialog, even when the original is outside the currently loaded chat history.

Imports accept UTF-8 text up to 100,000 bytes and retain the filename, import time
and importing user ID. Chat attachments are referenced by filename when saving a
message. Agents with a channel memory grant can receive an excerpt of this document.
The separate extraction worker builds topics and facts from messages for the channel and thread memory views. [Working memory](thread-working-memory.md#layered-memory-graph-rag)

## Storage and operation

The built-in `markdown` provider stores one document per channel in Space PostgreSQL. The provider ID, Markdown source blocks and SHA-256 content revisions survive the migration. Back up `channel_memory_documents` with the rest of the Space database. Custom providers own their storage.

For an upgrade from filesystem storage:

1. Stop older API processes that can write `memory.md`. Keep a backup of the database and the legacy memory directory.
2. Run `pnpm migrate` on a machine with the legacy files. Set `MEMORY_DIRECTORY` to the old directory if you customized it. The default is `.space-memory` at the application root. Compose mounts the old `memory_data` volume read-only in its migration service.
3. Check the reported import count and restart the API and workers on the new version. The importer includes disabled channels and channels currently using a custom provider. If a file fails validation, correct the error and rerun the migration. An existing database row wins on retry, including an empty row left by a clear.
4. After verifying the database backup and import, retire the legacy volume according to your retention policy. The importer leaves the original files intact.

The importer reads one document at a time and rejects symlinks, invalid UTF-8 and oversized documents. API replicas and workers read the same database. Custom API hosts that pass `memory.directory` import that legacy path at startup. After cutover the option can be omitted.

Content is limited to 200,000 UTF-16 units and 512 KiB. An edit supplies the SHA-256 revision of the original content. The provider checks it and conditionally replaces the same content in PostgreSQL. A stale replacement returns `409 memory_conflict`. The UI keeps the draft and can load the latest version for comparison. Source imports and removals reapply to current content on a bounded number of concurrent conflicts.

Memory operations check membership before accessing a provider and recheck membership and settings before returning. An authorized write already in flight can complete after disablement or revocation. A subsequent operation uses the current settings.

Disabling blocks retrieval and writes without touching stored memory. The separate
**Delete stored memory…** control requires manager permission and confirmation; it
also works while disabled. Deletion applies only to the selected provider and does
not delete chat messages or original uploads. Switching providers preserves the old
provider's contents and does not migrate them automatically.

Stored source blocks are ordinary Markdown with lightweight comment delimiters:

```markdown
<!-- space-memory-source:message:00000000-0000-4000-8000-000000000001 -->
### Message from Kai · 2026-11-03T09:00:00.000Z
Source: [View original](/chat?workspace=...&channel=...&message=...)

> Use PostgreSQL for this service.
<!-- /space-memory-source -->
```

Keep these delimiters to retain idempotent saving and per-source removal. Manually
rewriting/removing a source block is allowed; provenance beyond those markers is
not immutable audit history. This application currently has no message editing or
deletion API; automatic source-change reconciliation must accompany those features.
Memory is untrusted reference data, and future model integrations must keep it out
of privileged instruction channels. The UI displays Markdown as editable text.

## Other memory systems and databases

`MemoryProvider` is exported from `@space/core/memory`. Register trusted adapters
when constructing the API. Each adapter owns its storage/database configuration;
Space supplies an authorized workspace/channel scope and a common document/source
contract. No credentials or arbitrary endpoints are accepted from the browser.

```typescript
import { createApi } from '@space/server/api';
import type { MemoryProvider } from '@space/core/memory';

// Instantiate your adapter using server-side database configuration.
export function apiWithMemory(
  store: Parameters<typeof createApi>[0],
  provider: MemoryProvider,
) {
  return createApi(store, {
    memory: {
      providers: [provider],
    },
  });
}
```

The built-in `markdown` adapter is always available. Custom IDs must be unique and
match `[a-z][a-z0-9-]{0,63}`. Registered providers appear in the channel manager's
provider selector. Adapters implement `read`, revision-checked `write`, idempotent
`ingest`, source `remove`, bounded `search`, and idempotent `clear`. They must honor
atomic revision checks and concurrent mutations across API replicas; the caller no
longer serializes provider operations in PostgreSQL. They must also honor
scope isolation, enforce content limits, preserve source references, and handle
failures without discarding stored data. Implement timeouts inside remote adapters.
No third-party memory adapter ships in this slice; the integration test verifies
that a supplied adapter is selected and disabled/unauthorized requests never call it.

Provider registration currently applies to the server deployment. Channel managers
choose from that registry; a workspace credential-management UI is not included.
Existing agent connector credentials grant no access to these human-authenticated
HTTP endpoints.

## HTTP API

Every endpoint below requires current channel membership and an authenticated actor.
Cookie writes use the existing trusted-origin/CSRF checks.

| Method | Endpoint suffix after `/v1/channels/:channelId` | Purpose |
| --- | --- | --- |
| GET | `/memory` | Settings, available providers, and enabled document |
| POST | `/memory/settings` | Manager: `{ enabled, provider? }` |
| POST | `/memory/document` | Conditional replacement: `{ content, revision }` |
| POST | `/memory/sources` | `{ message_id }` or `{ source_id, name, content }` |
| DELETE | `/memory/sources/:sourceId` | Remove a `message:<UUID>` or `document:<UUID>` block |
| GET | `/memory/search?q=...` | Search enabled memory; at most 20 line excerpts |
| DELETE | `/memory` | Manager: explicitly clear selected provider, including while disabled |
| GET | `/messages/:messageId` | Read the original message in this channel |

Disabled memory returns no document and rejects content/search operations with
`409 memory_disabled`. Unavailable configured providers return 503. Invalid provider
selection returns 400; unauthorized membership returns 404; manager-only operations
by a member return 403. Responses retain the API's `Cache-Control: no-store` policy.

## Verification

Migration tests use temporary legacy directories. API acceptance tests use a random schema
in the local test database and cover opt-in, role checks, offboarding, cross-channel
source denial, stale edits, cross-replica reads, concurrent/idempotent ingestion, source
removal, explicit deletion and a replaceable provider. React tests cover opt-in,
message saving, imports, conflict recovery, dirty-close protection, navigation and
denied-access clearing.

Verified on 2026-11-03:

- Full test graph with `turbo run test --concurrency=1`: 243 passing tests (90 backend,
  61 shared UI, 53 web, 19 server/filesystem/storage, 20 connector). Migration upgrade
  fixtures were updated to version 11. No failed, skipped or canceled tests.
- Monorepo `pnpm typecheck` and `pnpm build` passed. Existing module-directive build
  warnings and the Node 25 local-storage warning remain non-fatal.
- Real browser + Better Auth + PostgreSQL in a disposable schema: channel opt-in,
  edit/save, literal search, message save, original-message link, UTF-8 Markdown
  import, disable/re-enable with retained data. The existing development API was
  left running during isolated QA. A screenshot is stored with this chat's local
  visualization artifacts. Filesystem restart and error paths are covered by tests.
- Review findings on dirty navigation and CR/Unicode source boundaries were reproduced
  in regression tests, fixed, and re-reviewed without remaining actionable findings.

These checks use local test data; no external memory service or agent inference was
invoked, and no production, load or deployment verification is implied.

## Memory graph

The Memory dialog opens on a **Graph** view. **Notes** holds the Markdown editor described above. The graph works while Markdown notes are off and needs only channel membership.

```
(#channel) ──HAS──► (thread) ──HAS_SESSION──► (agent session)
```

- Click a node to see its summary, revision, writer, memory text, sources and size in the right panel.
- Double-click a thread to show or hide its sessions. The ring menu offers Expand/Collapse, Open and Hide.
- Threads with a memory in the last 7 days appear, 20 at first and 50 per **Load more threads**.
- Channel managers can edit a thread or session memory. A save is a normal revision, so a stale save returns `409`, keeps the draft and shows the newer text. Ended sessions can't be edited.
- Every memory insert sends a channel live update (migration `087_memory_updates.sql`), so open graphs refresh without polling.

| Method | Path | Rule |
| --- | --- | --- |
| GET | `/v1/channels/:channelId/memory/layers?after=&limit=` | Member |
| GET / POST | `/v1/channels/:channelId/threads/:threadId/memory` | Member reads, manager saves |
| GET / POST | `/v1/channels/:channelId/agent-sessions/:sessionId/memory` | Member who can open the session reads, manager saves |

Save bodies are `{ revision, summary, content }`. The server anchors the save to the thread's latest message and records the person as the writer. The view is drawn by `@space/ui/graph` (`GraphCanvas`), which uses `d3-force` for layout. Its look follows Neo4j Browser's graph view, but none of Neo4j's GPL code is used.

## Thread working memory

[Thread working memory](./thread-working-memory.md) is available independently of
channel memory opt-in. Thread-scoped MCP keys expose conversation retrieval and
source-linked Markdown memories on the existing MCP transport. Reusable channel
knowledge keeps the provider and opt-in behavior described above.

## Installed agent permissions

Channel managers can choose **No memory access**, **Read memory**, or **Read and contribute knowledge** for each installation in Memory → Installed agents. The default is none, including for existing installations. These permissions do not grant execution skills or enable channel memory. An active installation, current owner channel membership, and at least one supported channel skill grant are also required when accessing memory.

`GET /v1/channels/:channelId/memory/agents` lists up to 100 eligible installations and current permissions. `POST /v1/channels/:channelId/memory/agents/:installationId` accepts `{ access: 'none' | 'read' | 'contribute' }`. Changes are manager-only and audited. Migration 038 adds the grants and installation-bound MCP connections without granting existing agents access.

Task preparation supplies at most 6,000 UTF-16 code units of the selected provider's document as `context.channel_notes`, with channel/provider/revision identifiers and a truncation flag. Unicode surrogate pairs are preserved. This is quoted reference data, not privileged instructions. Both the API's paired-agent path and the remote worker use the same reader factory. Provider I/O occurs outside database transactions; membership, permissions, settings, and delivery eligibility are rechecked afterward. Each reader allows at most eight outstanding provider reads and waits at most five seconds per call. A timed-out read retains its concurrency slot until it settles, so a provider that never settles cannot create an unbounded backlog. Custom providers must implement their own I/O cancellation/timeouts.

An unavailable or failing provider fails authorized dispatch rather than silently substituting another provider. Disabled or ungranted memory performs no provider read. The remote worker reads the canonical Markdown document from the Space database. Custom deployment adapters must be registered consistently in API and worker processes with `createAgentMemoryReader(new MemoryStore(pool), providers)`.

MCP key creation optionally accepts `installation_id`. Bound keys may request read or contribute access, capped by the live installation permission. Contribute exposes read/search/context and evidence-backed `memory_remember`; it never exposes whole-document `memory_write` or `memory_forget`. Full-write keys remain available for explicitly configured external integrations and cannot be bound to an installation. The UI distinguishes these paths. Built-in runners receive supplied excerpts; granting contribute access does not change their tool restrictions or automatically attach an MCP client. Contribution uses an explicitly configured MCP client.

Revocation blocks later operations and withholds results when access changes during retrieval. Source-backed additions recheck authorization after reading evidence and before starting the provider mutation. A provider mutation already started can finish after revocation; revocation cannot erase data already sent to an external agent or retained conversation. No background extraction or polling is added.
