# Channel Permissions Implementation Plan

> Execute using superpowers:subagent-driven-development with scoped frontend implementation and review. Backend and integration work is owned by the root agent.

**Goal:** Build the approved Slack-style channel manager and permission flow with server enforcement.
**Architecture:** Versioned channel policy records, central capability calculation, shared human-message enforcement, and event-driven React views.
**Tech Stack:** PostgreSQL/Drizzle, Fastify, React, shared @space/ui, Motion, node:test, Vitest.

- [x] Add tests/integration/channel-permissions.test.ts using isolated schema and real production routes; establish 404 missing-route failure. Cover default access, four posting modes, independent replies, mention restrictions, delegation, last-manager protection, concurrent revisions, removal and inactive members.
- [x] Add packages/contracts/channel-permissions.ts and export. Define ChannelPermissions: revision:string; posting:'everyone'|'members'|'admins'|'selected'; poster_ids:string[]; manager_ids:string[]; allow_replies:boolean; allow_broadcast:boolean; invite/remove/edit_details/archive:'managers'|'members'. ChannelPermissionSnapshot extends policy with capabilities:{post,reply,broadcast,invite,remove,edit_details,archive,manage:boolean}. Strict partial PATCH includes required revision.
- [x] Add migration 061_channel_permissions.sql, register in migrate.ts. Seed policies for existing/new channels, bounded array constraints, cleanup removed-member grants, enqueue_resource_delivery trigger. Add adapters/postgres/channel-permissions.ts with serializable versioned updates, identity validation and capability calculation.
- [x] Add GET/PATCH routes in apps/server/chat.ts. Integrate ChatStore details/member actions/new sends; use serializable transactions in changed management paths without explicit locks. Preserve duplicate send acknowledgements and DM behavior.
- [x] Frontend worker owns apps/web/src/features/channels and composer permission integration in features/chat/ChannelRoom.tsx: dialogs, managers, separate action capabilities, live subscription, drafts/read-only. Worker supplies focused failing/passing tests; root reviews contract integration.
- [x] Run pnpm builds for contracts/core/postgres/ui/server, PostgreSQL integration suite with TEST_DATABASE_URL=postgres://workplace:local_demo_only@127.0.0.1:55438/workplace, scoped web tests and typechecks. Perform spec and quality review, resolve findings, inspect live local UI, and check git diff --check.

## Verification completed

- `pnpm build`: 15 build tasks successful.
- `pnpm typecheck`: 24 dependency/typecheck tasks successful.
- Full web suite: 60 files, 510 tests passed. Final focused channel suite after CSS/copy fixes: 18 tests passed.
- Real PostgreSQL integration regression suite: 48 tests passed across channel permissions, channel management, workspace membership, workspace, direct messages, and mentions. Used a dedicated temporary NATS instance on port 54232 because the existing local test broker had exhausted its storage reservation; temporary instance stopped afterward.
- Reviewed backend authorization, migration, concurrency and UI against the spec; resolved all findings. No remaining material findings in final review.
- Browser at 1512×778 and 390×844: saved/reopened posting restrictions, conditional posting fields, manager selector, separate action controls, scrolling and visible footer. Desktop/mobile captures stored in the chat visualization directory.
- Migration 061 applied to the local development database for browser verification. Isolated test schemas cleaned up, including the interrupted concurrency fixture.
- `git diff --check` passed. Implementation was verified on `codex/channel-permissions`, then transferred into the main checkout at the user’s request. Existing mention/notification work was preserved. Changes remain uncommitted; no deployment performed.

Review-driven concurrency fixes also move installation creation, channel creation/join, workspace removal and role changes to existing serializable retries. Tests pause operations before insertion and prove offboarding cannot restore channel membership or leave an enabled agent behind. Legacy private channels already missing a manager permit ordinary departures; operations that remove an existing last manager still fail.

Main-checkout transfer verification: full build passed; 101 affected web tests and 39 channel/mention/notification integration tests passed. The overlapping mention search change retains both guest restrictions and channel broadcast capabilities. Changes remain uncommitted on main.
