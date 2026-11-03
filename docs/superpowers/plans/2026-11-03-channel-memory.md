# Channel Memory Implementation Plan

> **For agentic workers:** Execute inline using the executing-plans workflow. The
> user has approved implementation. Do not commit the user's untracked repository.

**Goal:** Ship usable opt-in channel memory backed by Markdown and replaceable providers.

**Architecture:** Channel access/settings remain in PostgreSQL. A server service
authorizes and serializes operations before delegating to a provider; Markdown is
the default and source of truth. React reuses existing dialogs, message menus and
request/session handling.

**Tech Stack:** TypeScript, Fastify, Drizzle/PostgreSQL, Node filesystem, React/Vitest.

## Tasks

- [x] Add API acceptance tests in `tests/integration/memory.test.ts` first and run
  `pnpm --filter @space/tests exec tsx --test integration/memory.test.ts` with the
  local test database. Expect the new memory route to return 404 instead of 200.
- [x] Add shared memory types/validators in `packages/contracts/memory.ts`, export
  them, and define `MemoryProvider` in `packages/core/memory.ts` with read, write,
  ingest, remove, search and clear methods. Add exports to owning package manifests.
- [x] Add migration 011 and channel schema settings. Add `MemoryStore` in
  `adapters/postgres/memory.ts` using parent/workspace/channel locks and current
  membership before any provider callback. Manager checks follow ChatStore.
- [x] Implement `apps/server/markdown-memory.ts`: UUID-scoped files, bounded content,
  SHA-256 revisions, atomic private writes, source sections, literal search and
  explicit deletion. Add filesystem tests in `apps/server/memory.test.mjs` for
  restart persistence, traversal rejection, stale edits, privacy and source handling.
- [x] Add `apps/server/memory.ts` routes, register through `createApi`, register the
  Markdown provider by default, and permit trusted server-injected adapters. Verify
  disabled/forbidden operations never call providers, and concurrent saves persist.
- [x] Add `apps/web/src/ChannelMemory.test.tsx` before its implementation. Verify
  opt-in controls, edit conflict recovery, file import, and stale response isolation.
  Implement `ChannelMemory.tsx` plus CSS and wire the Memory tab and save-message menu.
- [x] Add private memory-directory ignores, `MEMORY_DIRECTORY` environment forwarding,
  persistent Compose volume, and operator/provider documentation with explicit
  source/deletion and extraction boundaries.
- [x] Run focused memory checks, full `pnpm typecheck`, `pnpm build`, and the existing
  suite with test database/Redis configuration. Inspect final code for authorization,
  disabled-state leakage and lost writes; record results in the architecture guide.
