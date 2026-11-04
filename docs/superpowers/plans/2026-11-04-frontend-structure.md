# Frontend Structure Implementation Plan

**Goal:** Migrate the existing React/Vite frontend to the feature-oriented structure approved in this chat.

**Architecture:** Application composition and navigation live in `apps/web/src/app`; product behavior lives in `features`; HTTP and realtime infrastructure live in `shared`. Shared UI remains in `packages/ui`, grouped by responsibility with explicit package subpath exports. Backend services and adapters retain their current locations.

**Tech Stack:** React, TypeScript, Vite, Vitest, pnpm workspaces, Turborepo.

## Tasks

- [x] Move web source, colocated tests, and CSS into app, feature, shared, and gallery directories; rewrite imports, test mocks, asset references, and active documentation references.
- [x] Group UI sources and tests into primitives, navigation, conversation, composer, rich-text, agents, emoji, motion, and styles; update style copying and package exports while preserving existing entry points.
- [x] Extract `ChannelRoom` and `WorkspaceChannels` from `Chat.tsx`; extract navigation and composer upload/draft lifecycle into their agreed owners without changing behavior.
- [x] Make `app/App.tsx` compose application entry routes and `app/AppProviders.tsx` own global React providers; rename the gallery and workspace preview clearly.
- [x] Document ownership and dependency direction in `docs/architecture/frontend.md` and update current developer instructions and commands for relocated files.
- [x] Run UI build, web build, workspace typecheck, frontend tests, and source-reference/boundary checks. Review the diff for unintended behavior changes.

## Verification

Existing regression suites are the behavior contract for this structural migration. Preserve their assertions and rewrite references to their new locations. Add structural validation only where it checks meaningful package boundaries. Use `pnpm --filter @space/ui build`, `pnpm --filter @space/web build`, `pnpm typecheck`, and `pnpm test:ui`. Do not combine the two previously reported behavior fixes with this migration.


## Results

- UI build and Vite web build passed. Vite reports dependency module-directive and bundle-size warnings; no performance improvement is claimed.
- Workspace typecheck: 23 tasks successful (20 cached).
- UI: 167 tests passed across 25 files. Web: 384 tests passed across 43 files in the final full run.
- One intermediate full web run timed out during the initial render of the Activity navigation test. The test then passed in isolation, all 69 chat tests passed, and the final full web suite passed without changing application behavior or test assertions.
- Checked 334 relative web module references, all 32 UI package entrypoints, production dependency direction, CSS preservation, and original test-case retention. Spec and implementation reviews found no concrete regression.
- Implemented directly on `main`, as requested. Live-browser visual behavior and backend integration tests were not exercised for this frontend-only migration.
