# Space macOS verification — 2026-11-04

Scope: existing Space UI in an installable Apple Silicon macOS Electron client. Local backend and frontend remain separate services.

## Observed workflows

- Signed in through the packaged application's UI using synthetic QA accounts.
- Sent a channel message, replied in its thread, switched workspaces, and sent a message in the second workspace.
- Quit and reopened the packaged application; the session and previous conversation persisted.
- Selected a text file using the native file picker, uploaded it, and sent it with accompanying text; the inline preview appeared.
- Downloading the uploaded file exposed a desktop bug: the navigation guard blocked the authenticated endpoint's redirect to storage. The shell now routes same-origin asset download links through Electron's downloader. A real Electron regression test verifies authentication, a redirect to another origin, saved bytes, and unchanged chat navigation.

The live app now contains a user-authored unsent draft. Further checks used isolated hidden test windows; the live window was left alone.

## Automated evidence

- Desktop policy: 4 tests passed.
- Electron fixture smoke: initial and restarted processes passed, including renderer isolation, navigation restrictions, authenticated redirected download, and persistent cookies.
- Real local backend plus isolated Electron profile: initial and restarted processes passed. The test cut the profile's HTTP/WebSocket connections, sent a message while disconnected, retried the same client message ID, then observed exactly one recovered message. The hidden window preserved an unread count of one. Full process restart preserved authentication/history; server-side session revocation returned the UI to sign-in and removed private chat content.
- Backend auth, unread, agent-session, and asset suites: 60 cases passed across scoped runs. The initial run had one failure in the historical unread migration fixture; that fixture was corrected to seed historical columns before applying later migrations, and all 7 unread tests passed on rerun.
- Focused frontend socket-session, unread, history, agent-session, and chat-client suites: 43 tests across 7 files passed.
- Attachment-only composer regression: 1 test passed against the actual message contract. UI TypeScript checking passed.
- Frontend production build completed with existing bundle-size and directive warnings.
- Rebuilt the Apple Silicon `.app`, DMG, and ZIP with the download fix. `hdiutil verify` reported a valid DMG checksum. The running user window was not restarted to load the new build.

## Limits and follow-up

- One attachment-only send failed during manual testing and retained its draft. A subsequent API send and the composer contract test succeeded; the original failure was not reproduced or claimed fixed.
- Agent-session behavior was tested through integration/component suites, without a real provider invocation.
- Connection loss/recovery was simulated on the test profile; physical Mac sleep/wake was not exercised.
- Synthetic QA accounts, private workspaces, messages, and an uploaded file remain in the local development database/storage. Automated Electron profiles were removed.
- The installer is an unsigned, unnotarized development build. Clean-machine distribution, Intel hardware, production deployment, OAuth/deep links, and automatic updates remain outside this verification.
