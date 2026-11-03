# Workspaces Only Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for separate API/UI and test updates. User explicitly requested removing organizations after reviewing the ERD; this is the authorized design.

**Goal:** Users join and create workspaces directly, with no organization layer in the active schema, APIs or UI.

**Architecture:** Preserve existing workspace IDs, names, content, memberships and workspace roles. Migration 014 folds organization inactivity into workspace inactivity, disables affected agents and removes their channel memberships, then drops organization tables and columns. Workspace locks replace parent-organization locking; all authorization uses active workspace membership. Any signed-in user may create a workspace and becomes its owner. Adding an existing user requires only workspace role authorization. No organization role is promoted into workspace authority.

**Tech Stack:** Existing Fastify, React, Drizzle/PostgreSQL, Better Auth and Socket.IO; no new dependencies.

## Contract and scope

- `POST /v1/workspaces` accepts exactly `{name}` and returns a workspace with the caller's owner role.
- Existing workspace/member, profile, chat, asset, memory and connector routes remain functional. Organization routes are removed, returning 404.
- WorkspaceStore.create becomes `(actor, input)`; parser becomes parseWorkspaceInput. OrganizationStore and organization-owner provisioning are removed.
- Shared workspace locks serialize content/agent mutations against workspace offboarding; exclusive workspace locks serialize role changes and last-owner checks. Avoid lock upgrades from share to update.
- Existing migration files remain immutable. New migration removes organization metadata; take a private local database backup before applying it to the running development database.
- Preserve concurrent profile, memory and asset work. All repository files are untracked; do not bulk stage or commit.

## Steps

- [x] Write failing coverage for direct workspace creation, removed routes, independent workspace memberships and preserved offboarding boundaries.
- [x] Add upgrade test from migration 013 proving identity/content preservation, unchanged roles and no resurrection of inactive parent membership.
- [x] Add migration 014 and remove organization schema mappings/store; refactor workspace, access, chat, foundation, memory, assets, pairing, bootstrap and provisioning.
- [x] Update API registration, runtime contracts and onboarding UI to create workspaces directly; update UI tests.
- [x] Update integration fixtures and tests, scripts, package exports/commands and current architecture documentation.
- [x] Run full typecheck/build/tests, review changes, fix findings and rerun affected checks.
- [x] Back up and migrate the local development database, restart the API and verify workspace creation, existing chat access and member directory in the browser.
- [x] Record outcomes and show the simplified hierarchy to the user.

## Local verification

- Spec and independent code-quality reviews found no material issues.
- Backend contracts/integration: 98 tests passed; workspace-focused suite: 18 tests passed.
- Web application: 83 tests passed, including direct workspace onboarding.
- Backed up the local development database to a private PostgreSQL custom-format archive and validated its table-of-contents before migration.
- Applied migrations through 014. Compared pre/post snapshots: all 10 original workspaces, 18 memberships, 27 messages and 19 agent installations preserved with intended effective access. Channels, threads, tasks, assets and workspace audit content also matched.
- Confirmed organization tables and organization_id columns are absent from the active public schema.
- Live API verified direct workspace creation, owner membership, channel creation, saved message/history and removed organization endpoints (404).
- Browser showed Workspace-only QA, its migration-check channel and the saved verification message with Live status.
- The local API was restarted after migration. No production deployment or Git commit was performed.

Final combined verification: typecheck and build passed. The full parallel `pnpm test` run was interrupted by the unrelated `packages/ui/src/work-items.test.tsx` syntax-token assertion (expected `hello`, received `console.log(value);`). Its isolated 18-test file passed; the separate web run passed 83 tests and backend run passed 98. The full monorepo suite is therefore not reported as passing.
