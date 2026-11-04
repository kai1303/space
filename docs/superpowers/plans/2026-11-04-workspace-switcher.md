# Workspace switcher implementation plan

**Goal:** Match the inspected Slack workspace menu and add-workspace dialog using Space's existing authentication, membership and creation paths.

**Design:** The rail shows workspace initials, opens a compact identity header and other-workspace rows, and ends with Add a workspace. The add dialog offers sign in, find and create. Workspace URLs use real `/chat?workspace=…` links; no invented tenant domains. Find searches authorized memberships. Signing in changes the browser's account, which the UI explains. The sidebar's existing workspace actions remain intact.

**Architecture:** Reuse the shared Popover and Dialog for keyboard handling, focus and motion. A focused web component owns dialog state; Chat owns the workspace list and create callback. Reuse AuthScreen's form without its full-page wrapper. No new backend routes, polling, dependencies or authentication scopes.

**Tech stack:** React, TypeScript, existing Space UI, Vitest and CUA browser checks.

- [x] Write and run failing tests for rich workspace rows, add choices, search, create failure/retry and sign-in entry.
- [x] Build the switcher/dialog and style it with existing theme tokens; wire real workspace creation in Chat.
- [x] Test session refresh on sign-in, keyboard dismissal, focus return, creation and switching; run web checks.
- [x] Compare the live menu/dialog with captured Slack references at desktop and narrow sizes; restore temporary viewport overrides.

**Evidence boundary:** Do not create a persistent live workspace or sign in to another account merely for a screenshot. Verify mutations with request-level component/integration fixtures and inspect the live forms without submitting them.

## Verification

74 tests passed across WorkspaceSwitcher, ChatShell, AuthScreen and Chat, including API-backed workspace creation/switch-back and a deferred-authentication race regression. TypeScript and production build passed. Browser verified menu, all three choices, search/no-match behavior and forms; at 390px the create and sign-in dialogs both had 348px client and scroll widths. Restored the viewport. Live authentication and creation were not submitted; no new persistent workspace was created for screenshots. Review found and then verified the pending-auth dismissal fix.
