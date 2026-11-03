# Main chat UI implementation plan

Goal: turn the existing authenticated `/chat` screen into the main Space interface using the approved Slack-based design system.

Keep existing Better Auth, REST and Socket.IO boundaries. Reuse shared primitives, sidebar, message, composer, search and Motion behavior. No new backend subsystem or invented Slack mechanics. Preserve the gallery at `/design-system`, legacy gallery hash URLs and `/workspace` preview. The main entry without a gallery hash opens chat.

- [x] Add regression assertions for real sidebar navigation, rich-editor plain-text transport, thread controls and scoped search. Observe missing behavior before implementation.
- [x] Add real-data options to the shared sidebar and a plain-text transport mode to RichComposer. Hide unsupported formatting/uploads instead of silently dropping them. Keep gallery defaults intact.
- [x] Replace chat shell and CSS with workspace rail, resizable sidebar, channel header, message feed, thread pane, create-channel dialog, profile controls and responsive drawer. Preserve server authorization/reconnect/history behavior.
- [x] Connect shared search to currently loaded authorized channel history. Clearly label this scope. Use existing message-arrival tracking for live events.
- [x] Correct default navigation and verify the local auth proxy, connected send/reply, empty state, desktop/mobile and theme behavior. Existing auth tests remain passing.
- [x] Run targeted tests, monorepo typechecks, full build, focused review and browser QA. Save screenshots and note backend/plain-text/search limitations.

Files: `apps/web/src/Chat.tsx`, `chat.css`, `Chat.test.tsx`, `main.tsx`, `Workspace.tsx`; new focused `ChatShell.tsx` for shared application chrome; `packages/ui/src/sidebar.tsx`, `rich-composer.tsx` and their tests. Keep transport helpers and server contracts unchanged.

The layout follows the existing accepted rail/sidebar/feed/composer design. Agent task requests/approval remain connected; unavailable DMs, reactions and uploads are not represented as working features. Backend history is plain text, so the main composer must reflect that capability.
