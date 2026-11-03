# Composer verification

Date: 2026-11-03. Scope: shared RichComposer, channel/thread gallery integration and workspace regression. Reference scope and REA Evidence IDs are in [the research report](research/slack-composer.md).

## Automated checks

- `pnpm test:ui`: 64 passing tests, 53 UI and 11 web. Seven new keyboard cases cover ordinary Enter, Command+Enter, modifier keys, composition and key code 229. The gallery exercises the real Quill editor for rich formatting and channel draft isolation.
- The async regression was observed failing with an unwanted empty-draft callback after unmount. With editor-identity guards, an old send settling cannot clear the new instance's draft; the test passes.
- `pnpm --filter @space/ui --filter @space/web typecheck`: passes.
- `pnpm build`: passes, 10 successful tasks; eight cached and two rebuilt on the final run. Existing dependency directive and chunk-size warnings remain warnings.

JSDOM lacks browser Range geometry methods. The gallery test supplies these layout-only methods so actual Quill focus/selection can run without unhandled layout errors. This does not validate pixel geometry; browser checks do that separately.

## Browser checks

- The gallery now exposes a contenteditable rich editor through the Chat composer navigation link. Shift+Enter retains multiline content, Enter submits it and clears the editor. Alt/Ctrl+Enter did not submit the draft.
- Code block toggles to its active state; Bold and link become disabled. Toggling back restores inline controls.
- Switching channels restores the original text draft. Closing/reopening the thread restores its independent draft.
- At 320px viewport width, document width and scroll width both measure 320px. The footer content fits its 252px inner width. Formatting wraps rather than using Slack's adaptive overflow menu.
- At 1100px viewport width, the desktop thread footer measures 301px client/scroll width. Unavailable recording and shortcut controls hide based on the composer container width. This resolves the review finding about desktop thread overflow.
- At 1440px the channel and thread composers display together. A new local workspace message was submitted successfully through the same shared composer at `/workspace`.
- The checked gallery tab captured no console warnings/errors. Temporary viewport overrides were reset.

Review found and corrected stale async draft clearing, narrow desktop footer overflow and rejected-file selection retry. Automated coverage proves the first; browser geometry verifies the second. The file-input reset is a source-level fix; native same-file retry was not independently exercised.

Screenshot: `/Users/kai/.codex/visualizations/2026/11/03/01a19f82-8391-7ba3-a409-61a31b7bca6b/space-chat-composer.jpg`.

This slice verifies local frontend behavior, not durable delivery or Slack backend parity. Unimplemented editor/menu/preference capabilities are listed explicitly in the research report.
