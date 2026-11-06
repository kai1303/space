# Smooth Onboarding Implementation Plan

**Goal:** Deliver the approved continuous account → workspace → chat flow using Motion.

**Architecture:** A shared access-page presentation supplies consistent branding, dimensions and Motion transitions. AuthScreen retains authentication behavior; a workspace setup feature owns its form. Chat and ChatWorkspace keep routing, workspace discovery and the signed-in realtime boundary.

**Tech Stack:** React, TypeScript, installed motion/react, @space/ui, Vitest and Testing Library.

## Tasks (inline execution)

- [x] Add failing integration coverage in `apps/web/src/app/Chat.test.tsx`: no Main navigation before membership resolves or during workspace setup, explicit retry after discovery failure. Existing create-workspace test must still select the returned workspace.
- [x] Add auth pending/duplicate-submit and workspace validation/retry tests beside their features. Run focused tests and confirm behavioral failures before implementation.
- [x] Add `features/auth/AccessFrame.tsx` and `access.css`, sharing stable form dimensions and Motion content/layout transitions with reduced-motion support. Update AuthScreen for pending labels and disabled fields while retaining its embedded API and field values on failure.
- [x] Add `features/workspace/onboarding/WorkspaceSetup.tsx`: trimmed workspace-name validation, ref-based submission guard, retained values on failure and inline error. Pass creation through ChatWorkspace's existing addWorkspace callback.
- [x] Update Chat startup/error presentation and ChatWorkspace's discovery/empty states. Preserve providers, invite routing and navigation state. Reveal workspace chrome with Motion after workspace selection.
- [x] Run `pnpm --filter @space/web exec vitest run src/features/auth/AuthScreen.test.tsx src/features/workspace/onboarding/WorkspaceSetup.test.tsx src/app/Chat.test.tsx`, `pnpm --filter @space/web typecheck`, and `pnpm --filter @space/web build`.
- [x] Verify the live local browser flow, capture screenshots, review the scoped diff, and report verification and limitations.

## Verification results

- New onboarding expectations failed before implementation; new credential-feedback expectations also failed before their fix.
- Auth + workspace setup: 6 tests passed.
- Chat, auth, workspace switcher and invitation suite: 95 passed, 1 failed. The failure is the existing “updates the Starred sidebar immediately…” test. It also fails against the previous Chat/ChatWorkspace code in a temporary baseline harness; the harness was removed after the check.
- Web typecheck and production build passed. Build emitted Motion dependency `use client` bundler warnings.
- Live local browser: rejected sign-in, correction clearing feedback, successful returning-user sign-in, fresh signup, focused workspace setup, and workspace creation all verified. The error state's submit-button top position was unchanged before/after feedback. At 375px the form fit without horizontal overflow; reduced motion produced no transform. Temporary emulation settings were cleared.
- User requested a clearer sign-in error during verification. Added inline credential feedback, field associations, invalid indicators, and edit-to-clear behavior.
- Changes remain uncommitted; unrelated pre-existing working-tree changes were preserved.
