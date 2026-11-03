# Profile and Status Implementation Plan

**Goal:** Build the signed-in user's Profile and Status flows from Slack HTML/CSS evidence.

**Architecture:** Reuse authenticated GET/PATCH `/v1/me`, add explicit partial-update validation and a non-destructive user migration, and mount the settings controller in the account rail. Reuse shared Dialog, Popover, Button and TextField components. Keep chat drafts and navigation intact.

**Tech stack:** React, TypeScript, PostgreSQL/Drizzle, Fastify, Vitest and Node test runner.

- [x] Inspect Slack profile/status DOM and computed styles; retain downloaded CSS and hashes. Record measured selectors and adaptation boundaries in `docs/research/slack-profile-status.md`.
- [x] Add failing contract and UI tests for editing, validation, status presets, clearing, cancel and save failure.
- [x] Implement `packages/contracts/profile.ts`, migration `013_user_profiles.sql`, schema fields and `UserStore` partial updates. Keep provisioning's existing `parseProfileInput` contract.
- [x] Implement `apps/web/src/UserProfile.tsx` and `profile.css`, integrating through `ChatShell` and forwarding saved display-name changes into Chat state.
- [x] Verify profile persistence, actor isolation and expired status normalization with the workspace integration tests.
- [x] Verify browser save/reload and narrow layout against an isolated synthetic account; photo selection is extension-blocked and the normalization/save path is covered by component tests.
- [x] Run final web/UI tests, typecheck and build; record the actual scope of validation in the research note.

Commands: `pnpm build`, `pnpm test:ui`, and `TEST_DATABASE_URL=... pnpm --filter @space/tests exec tsx --test contracts/profile.test.ts integration/workspace.test.ts`. Integration tests create and remove their own schema.

The repository was already entirely untracked, with concurrent chat motion and workspace changes. Preserve these changes; do not stage or commit the whole checkout.
