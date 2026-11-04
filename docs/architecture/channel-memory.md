# Opt-in channel memory

Open **Memory** beside Messages in a channel. Memory is off until the channel
creator or a workspace owner/admin enables it. Ordinary channel members can then
edit shared notes, import `.md`, `.markdown` or `.txt` files, save selected messages,
search memory, remove sources, and export Markdown. No message is copied simply
because it was posted. No model API key or external memory database is required.

Choose **More actions → Save to channel memory** on a message, then save it in the
memory dialog. The server reads its author, timestamp and text from the original
channel, so client-supplied text cannot forge the source. Repeated saves of the same
message have one source entry. Source links open an authenticated original-message
dialog, even when the original is outside the currently loaded chat history.

Imports accept UTF-8 text up to 100,000 bytes and retain the filename, import time
and importing user ID. Chat attachments are referenced by filename when saving a
message; attachment bytes are not silently imported. Binary/PDF/Word extraction,
server-side automatic fact extraction, contradiction detection, inferred summaries,
remain outside this slice. Authorized agent task dispatch can now include bounded channel-memory excerpts. Agents and Navigator can
now read context and save their own extracted knowledge through the
[memory MCP tools](memory-mcp.md).

## Storage and operation

Apply migration 011 using `pnpm migrate` and restart the API. PostgreSQL stores only
`channels.memory_enabled` and `channels.memory_provider`. Canonical memory is UTF-8:

```text
<MEMORY_DIRECTORY>/<workspace UUID>/<channel UUID>/memory.md
```

The default directory is `.space-memory` at the application root, independent of
the launch working directory. Set `MEMORY_DIRECTORY` to an absolute private path to
override it. The default directory is ignored by Git and Docker builds. Compose
mounts the dedicated `memory_data` volume at `/app/.space-memory` and runs the API
as the node user. Back up this volume along with PostgreSQL: database backups alone
do not contain memory. This change supplies the Compose configuration; it does not
recreate existing containers automatically.

Reads of empty/disabled channels do not create files. New scoped directories use
0700 and files use 0600. UUID-only paths, scoped symlink checks, no-follow file opens,
size limits, temporary files, fsync and atomic rename protect the filesystem boundary.
The operator must control the configured root and its parent directories; do not
allow untrusted local processes to replace directories while the API is running.

Content is limited to 200,000 characters and 512 KiB. The SHA-256 of the exact content
is its revision. Stale writes return `409 memory_conflict`; the UI keeps the draft
and can load the latest version for comparison. Save/merge before importing or
removing sources. Closing a dirty editor asks before discarding its changes.

Memory operations check current membership before accessing a provider and recheck
membership and settings before returning. Provider I/O holds no database connection,
transaction or row lock. An authorized write already in flight can complete after
disablement or revocation; subsequent operations are blocked and an in-flight result
is withheld if access or settings changed.

The Markdown provider serializes mutations using a per-document filesystem lock
(`proper-lockfile`), with a heartbeat and recovery after 30 seconds of inactivity.
Revision checks happen inside that boundary; reads use atomic file snapshots and
need no write lock. Every replica must use the same database and shared memory volume
with atomic directory creation/rename; independent local disks are unsupported.
Stop application writes before editing canonical files externally; direct filesystem
writers do not participate in the provider's coordination. Short database-only MCP
key creation uses serializable transactions and bounded retries for its quota check; no provider is called in that transaction.

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
      directory: '/private/space-memory',
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

Filesystem tests use temporary directories. API acceptance tests use a random schema
in the local test database; they cover opt-in, role checks, offboarding, cross-channel
source denial, stale edits, retained files, concurrent/idempotent ingestion, source
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

## Thread working memory

[Thread working memory](./thread-working-memory.md) is available independently of
channel memory opt-in. Thread-scoped MCP keys expose conversation retrieval and
source-linked Markdown checkpoints on the existing MCP transport. Reusable channel
knowledge keeps the provider and opt-in behavior described above.

## Installed agent permissions

Channel managers can choose **No memory access**, **Read memory**, or **Read and contribute knowledge** for each installation in Memory → Installed agents. The default is none, including for existing installations. These permissions do not grant execution skills or enable channel memory. An active installation, current owner channel membership, and at least one supported channel skill grant are also required when accessing memory.

`GET /v1/channels/:channelId/memory/agents` lists up to 100 eligible installations and current permissions. `POST /v1/channels/:channelId/memory/agents/:installationId` accepts `{ access: 'none' | 'read' | 'contribute' }`. Changes are manager-only and audited. Migration 038 adds the grants and installation-bound MCP connections without granting existing agents access.

Task preparation supplies at most 6,000 UTF-16 code units of the selected provider's document as `context.channel_memory`, with channel/provider/revision identifiers and a truncation flag. Unicode surrogate pairs are preserved. This is quoted reference data, not privileged instructions. Both the API's paired-agent path and the remote worker use the same reader factory. Provider I/O occurs outside database transactions; membership, permissions, settings, and delivery eligibility are rechecked afterward. Each reader allows at most eight outstanding provider reads and waits at most five seconds per call. A timed-out read retains its concurrency slot until it settles, so a provider that never settles cannot create an unbounded backlog. Custom providers must implement their own I/O cancellation/timeouts.

An unavailable or failing provider fails authorized dispatch rather than silently substituting another provider. Disabled or ungranted memory performs no provider read. Compose mounts the memory volume read-only in the remote worker. Custom deployment adapters must be registered consistently in API and worker processes with `createAgentMemoryReader(new MemoryStore(pool), providers)`.

MCP key creation optionally accepts `installation_id`. Bound keys may request read or contribute access, capped by the live installation permission. Contribute exposes read/search/context and evidence-backed `memory_remember`; it never exposes whole-document `memory_write` or `memory_forget`. Full-write keys remain available for explicitly configured external integrations and cannot be bound to an installation. The UI distinguishes these paths. Built-in runners receive supplied excerpts; granting contribute access does not change their tool restrictions or automatically attach an MCP client. Contribution uses an explicitly configured MCP client.

Revocation blocks later operations and withholds results when access changes during retrieval. Source-backed additions recheck authorization after reading evidence and before starting the provider mutation. A provider mutation already started can finish after revocation; revocation cannot erase data already sent to an external agent or retained conversation. No background extraction or polling is added.
