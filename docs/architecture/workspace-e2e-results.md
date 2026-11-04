# Workspace browser E2E results — 2026-11-04

Executed in Brave against the real Space frontend, authentication, API, PostgreSQL, and local event pipeline. These were browser-driven scenarios, not mocked browser responses. Separate component regression results are listed below.

## Environment

- Frontend: `http://localhost:5175`, fixed Vite production bundle to avoid reloads caused by concurrent development in the shared checkout.
- API: `127.0.0.1:3002`; isolated PostgreSQL schema `workspace_e2e_73cd68076d3c`.
- Workspace: `f44b9017-0aa7-4038-a3e5-86983e5c862b`, initially **Workspace E2E Review**, renamed to **Workspace E2E Verified**.
- Three synthetic accounts: QA Owner, QA Member, and QA Guest at `workspace-e2e.test`. Accounts were seeded through the real signup API; subsequent login and workspace operations used the browser.
- Actual invitation/verification mailer with a local TLS SMTP sink on port 2465 and a local mailbox on port 5176. No messages were sent to real recipients or an external email provider.
- Test fixture runner, mailbox, and export artifacts: `/tmp/space-workspace-e2e/`. The runner creates a new schema on each start; do not restart it expecting to resume the same fixture.
- Existing user workspaces and the normal browser login at `127.0.0.1:5173` were not modified by these scenarios.

## Browser results

| Scenario | Result and evidence |
| --- | --- |
| Sign in and create workspace | Passed. QA Owner signed in and created the workspace through the UI. |
| Create public channels | Passed. Owner created `qa-general` and `qa-restricted`. |
| Save workspace preferences | Initially failed with `unknown_field`; fixed and retested successfully. Description, slug, default channel, and display-name guidelines saved. Description and slug persisted after reload. |
| Save permissions | Passed. Channel creation set to owners/admins, email visibility to members; both selected values verified after reload. |
| Rename and custom address | Passed. Renamed to Workspace E2E Verified; `/w/workspace-e2e-review` resolved to that workspace. |
| Member email invitation | Passed. Created in UI; delivery status reached `sent`; message appeared in the local SMTP inbox. |
| Email verification gate | Passed. Unverified QA Member could preview but not accept. Browser requested verification, followed the delivered link, then accepted successfully. |
| Default channel membership | Passed. Invited full member automatically gained `qa-general` access. |
| Member settings authorization | Passed. Workspace settings displayed the read-only explanation and disabled description input. |
| Channel creation authorization | Passed at the server boundary. Member attempted creation under the admins-only policy and received `create channel forbidden`; no channel was created. See UI limitation below. |
| Guest invitation | Passed. Created a single-channel guest link with a maximum of one use and assigned only `qa-general`; QA Guest accepted it through the browser. |
| Guest isolation | Passed. Guest sidebar and channel directory listed only `qa-general`; the other public channel was absent. |
| Primary ownership transfer | Passed. Transferred from QA Owner to QA Member; member table showed QA Member as Primary Owner and QA Owner as Workspace Owner. |
| Deactivation | Passed. QA Guest became Deactivated; signing in as that guest showed no workspace access. |
| Invite reuse after deactivation | Passed. Accepting the previously used link returned the deactivated-account error and did not restore membership. |
| Reactivation | Passed. New primary owner reactivated QA Guest. Account retained Single-channel Guest type; subsequent guest login regained workspace access with no channel memberships restored. |
| Member search | Passed. Searching QA Guest narrowed the directory to that member. |
| CSV export | Passed. Browser downloaded `workspace-members.csv`; inspected header and all three rows, including roles, guest type, active state, and join dates. |
| Invitation revocation | Passed. Created a separate link, revoked it in UI, and opened the saved URL; acceptance screen rejected it as unavailable. |
| Message retention | Passed. Sent a disposable message through the browser, then backdated that exact fixture row by three days. Applied one-day retention through the UI confirmation. After reload, the message displayed “Message removed by workspace retention.” One-day setting also persisted. Restored retention to Forever afterward. |

## Defect fixed

`WorkspaceSettings.savePreferences` previously copied the runtime settings response into the update request by removing only a few known response fields. Real responses also contain `guest_type` and `retention_version`; the strict PATCH parser rejected those fields. Existing mocks had omitted them.

The form now explicitly selects the supported update fields. Added a regression using a response containing both metadata fields and validating that the outgoing request passes `parseWorkspaceSettingsUpdate`. The regression failed before the fix and passed afterward. Browser save-and-reload checks passed against the rebuilt frontend.

Changed implementation: `apps/web/src/WorkspaceSettings.tsx`.
Regression: `apps/web/src/WorkspaceSettings.test.tsx`.

## Automated verification

- `pnpm --filter @space/web test -- src/WorkspaceSettings.test.tsx src/WorkspaceAdministration.test.tsx src/WorkspaceInvitations.test.tsx src/InviteAcceptance.test.tsx`: **22/22 passed**, four files.
- `pnpm --filter @space/web typecheck`: **passed** on the final run. An earlier run encountered unrelated concurrent `Chat.tsx` prop mismatches, which were no longer present on the final run.
- Fixed Vite browser bundle built successfully after the settings fix.

## Limits and remaining observations

- Restricted members and guests still see channel-creation controls. The backend rejects unauthorized creation, but the UI should hide/disable the action or explain the restriction before submission. A reactivated guest with no channels sees the generic “Create your first channel” empty state despite being unable to create one.
- This was an agent-driven browser E2E run, not a newly installed, unattended CI browser suite. The 22 tests above are component regressions, not 22 browser scenarios.
- SMTP delivery was tested against the local TLS sink, not a production provider or real recipient inbox.
- Workspace icon upload, attachment/file retention, invitation resend/expiry over time, multi-channel guests, approved-domain self-join, pagination at scale, and concurrent browser sessions were not exercised in this browser run. The API fixture did not configure attachment storage.
- SSO and billing remain deferred as requested. No production load, deployment, or cross-browser claim is made.
- The browser bundle was frozen during testing; later edits by concurrent chats are not covered by this run. No commit, push, or deployment was performed.

## Visual evidence

Screenshots are saved under `/Users/kai/.codex/visualizations/2026/11/04/01a1a5c6-d57e-7e13-b113-012be4056695/`:

- `workspace-settings-e2e.jpg`
- `workspace-members-e2e.jpg`
- `workspace-retention-e2e.jpg`
- `workspace-guest-reactivated-e2e.jpg`

The QA browser tab was left open on Workspace settings for review.
