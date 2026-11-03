# Opt-in channel memory

Approved direction: memory is optional, disabled by default, with Markdown files as
the built-in provider and an adapter boundary for other memory systems/databases.

## Behavior

Channel managers (creator or workspace owner/admin) enable/disable memory and choose
among server-installed providers. Channel members can read/edit enabled memory,
save existing messages, import UTF-8 Markdown/text documents, search, and export it.
Saving a message reads its text/author/time from PostgreSQL and includes a source
reference. Saves are idempotent by message ID. Text imports retain their filename
and importing actor. The system does not infer facts or execute agents in this slice.

Disabling immediately blocks memory reads, writes, ingestion and search, retaining
files for later re-enablement. Explicit deletion is separate, manager-only, and
works while disabled. No ordinary chat message is automatically copied to memory.

## Persistence and authorization

PostgreSQL stores only channel opt-in/provider settings. The built-in provider stores
canonical content at `<MEMORY_DIRECTORY>/<workspace UUID>/<channel UUID>/memory.md`.
Directories/files use restrictive permissions; UUIDs prevent path traversal. Reads
do not create files. Writes use temporary files and atomic replacement. Content is
bounded to 200,000 characters/512 KiB and versioned by SHA-256 to reject stale edits.
Memory operations acquire the same organization/workspace/channel locks as chat
mutations, check current membership, and serialize per channel across API processes.
All API replicas using Markdown must share the same filesystem volume.

Provider interface supports read, conditional write, source ingestion/removal,
search, and clear. Provider registration is trusted server-side code: the browser
can choose a registered ID but cannot supply filesystem paths, database credentials,
or network endpoints. Every provider call follows authorization; no connector gains
implicit memory access. Search results are reference data, not agent instructions.

## UI and verification

Add a Memory entry beside Messages. The panel explains opt-in, exposes manager
controls, a Markdown editor with conflict recovery, source import/removal, search,
export, and a separately confirmed delete action. Save-to-memory is a message menu
action. Channel navigation, session changes, and access loss discard displayed
memory; pending requests cannot populate another channel.

Verify disabled behavior, membership/offboarding, manager restrictions, source
isolation, duplicate and concurrent saves, stale revisions, restart persistence,
provider replacement, file privacy/path validation, and UI transitions. Use the
existing local PostgreSQL/Redis services and temporary memory directories. Keep
the user's unborn/untracked repository intact; do not create an initial commit.
