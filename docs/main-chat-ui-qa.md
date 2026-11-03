# Main chat UI

Date: 2026-11-03. The main application now uses the shared Space design system with the existing authenticated chat backend. This is an application screen, separate from the component gallery.

Follow-up: the [full rich composer pass](rich-chat-composer-qa.md) supersedes this report's initial plain-text composer limitation and records the newer persistence checks.

## Routes and implementation

- `/` and `/chat`: Better Auth session, workspace/channel navigation, saved message history, Socket.IO delivery, replies, agent task requests/owner approval, channel creation and joining.
- `/design-system`: standalone design-system gallery. Legacy root gallery hashes still work; the chat skip-link hash remains a chat route.
- `/workspace`: earlier synthetic interaction preview, preserved for component research.

`ChatShell.tsx` owns the chrome, rail, account menu, theme and mobile navigation. `Chat.tsx` keeps the existing REST/socket access checks, reconnect/replay and pagination behavior while composing shared `WorkspaceSidebar`, `RichComposer`, `Message`, `WorkspaceSearch`, dialogs and `AgentApproval`. Existing Motion message-arrival tracking animates new events; initial history stays still. Sidebar width can be adjusted with its shared pointer/keyboard separator. The real sidebar uses actual workspace/profile data in place of the gallery's synthetic profile.

Drafts are held above workspace/channel remount boundaries and keyed by channel/thread. They survive ordinary in-app navigation and clear for the affected channel when access is revoked. Logout/session replacement unmounts this state. Drafts are not durable across reload. Search uses only currently loaded, authorized messages in the selected channel; the dialog and results explicitly disclose that scope. A jump from a thread closes the thread before focusing the main message.

The composer uses `plainText` mode: real emoji, multiline editing, default send keys, serialized submissions and failure retention, without formatting/upload controls that the current transport cannot save. The full rich composer remains in the gallery and synthetic workspace. The frontend retains its authored 10,000-character bound, below the existing server's 16,000-character maximum.

## Verification

- `pnpm test:ui`: 65 passing tests, 53 shared UI and 12 web. The real-Quill integration assertions cover channel/thread/workspace draft isolation and restoration, scoped search and direct-result navigation, no-channel search disabling, trusted agent authors, the owner approval endpoint, reconnect cursor reuse, access revocation, and session replacement. A new plain-text mode test verifies that unsupported controls are absent and text reaches the send callback. Missing sidebar/editor-mode assertions were observed failing before implementation.
- `pnpm typecheck`: 18 successful monorepo tasks.
- `pnpm build`: 10 successful tasks. Existing dependency directive/chunk warnings remain non-fatal. The Node 25 test environment emits a local-storage-file warning; tests pass without unhandled exceptions or React duplicate-key warnings.
- The browser initially received HTML from the stale running Vite instance's auth path and rendered blank. Restarting the preview with its current proxy configuration restored the JSON auth endpoint and normal sign-in. No server auth mechanism was replaced or bypassed.
- Created an isolated local QA organization with synthetic accounts/conversations through the existing API. No pre-existing workspace was edited. QA credentials stay outside the repository.
- Browser sign-in, channel switching, draft restoration, live human send, reload persistence and a live thread reply succeeded. A private channel was created from the mobile dialog and opened in its correct empty/private state.
- At 1440px, main history and thread pane fit together. At 390px and 320px, document scroll width equals viewport width. Mobile navigation can open/close, and launching search while it is open closes the drawer before displaying the visible modal. Thread/search panes replace the feed at narrower desktop widths.
- Light/dark themes update shared surfaces and controls. Light-theme rail contrast was corrected to use chrome text tokens. The final clean main-app tab captured no console warnings/errors. Temporary viewport overrides were reset.

Read-only review findings fixed: mobile hidden search, lost workspace/thread drafts, unsynchronized creation-dialog close state, hidden search jumps, and unavailable/mis-scoped search. Follow-up review found no remaining blocker.

Screenshots under `/Users/kai/.codex/visualizations/2026/11/03/01a19f82-8391-7ba3-a409-61a31b7bca6b/`: `space-main-chat.jpg`, `space-main-chat-thread.jpg`, `space-main-chat-mobile.jpg`.

## Limits

No new server contract, database migration, external agent integration or deployment was added. Backend plain-text storage remains authoritative. DMs, reactions, uploads, rich-text persistence, presence, message editing/deletion and workspace-wide server search remain future work. Channel history currently includes thread replies in its ordered backend feed; displayed reply counts reflect the history loaded so far. Real agent-task approval wiring is covered by the UI test; no external agent was invoked for this UI pass. Browser checks use a local QA workspace, not production traffic or a load test.

The visual foundation uses the previously captured [Slack workplace evidence](research/slack-workplace.md) and [standard composer evidence](research/slack-composer.md). This implementation pass does not claim new Slack runtime analysis or complete Slack parity.
