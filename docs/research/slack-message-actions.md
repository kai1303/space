# Slack message actions

Observed on 2026-11-03 in the authenticated Slack web client, on an existing message owned by the current user. This pass opened the hover toolbar and More actions menu without changing or sending messages.

## Observed controls

The hover toolbar contains three quick reactions (check mark, eyes, raised hands), Add reaction, Reply in thread, Forward message, Add to-do, Ask Slackbot, and More actions. Quick reactions and available actions can depend on the workspace and message context; this is one observed configuration.

For the owned message, More actions contains Edit message, Mark unread, Add to saved, Add a reminder, Turn off notifications for replies, Copy link, Copy message, Pin to channel, Connect to apps, and Delete message. Only opening the menu was exercised. Mutation behavior and other-author permissions were not tested.

## Captured styles

The toolbar parent is absolutely positioned at `top: -16px; right: 17px`. The inner group is flex, approximately 40px tall, with 4px padding and 12px radius. Its dark background is `rgb(26,29,33)` and shadow is `rgba(232,232,232,.13) 0 0 0 1px, rgba(0,0,0,.08) 0 1px 3px 0`. Buttons are approximately 32px square with 8px radius and `rgb(171,171,173)` icon color.

Actual rendered toolbar and menu HTML, computed styles, and labels are retained in `/Users/kai/.codex-artifacts/space-slack-2026-11-03/message-actions/toolbar.json` and `menu.json`. The downloaded Slack stylesheets from the sidebar investigation remain in the adjacent `sidebar-style-capture` directory. This pass used browser runtime inspection, not a new REA static JavaScript run.

Screenshots:

- `/Users/kai/.codex/visualizations/2026/11/03/01a19f82-8391-7ba3-a409-61a31b7bca6b/slack-message-toolbar.jpg`
- `/Users/kai/.codex/visualizations/2026/11/03/01a19f82-8391-7ba3-a409-61a31b7bca6b/slack-message-actions.jpg`

## Current Space gap

`packages/ui/src/conversation.tsx` renders only Reply in the hover action group, when an `onReply` callback exists. Existing reaction chips support an optional callback, but the component has no toolbar reaction picker or More menu. `packages/ui/src/styles.css` uses a 5px toolbar radius and positions it at `top: -10px; right: 12px`, differing from this Slack capture.

## Selected text follow-up

The standard channel composer keeps formatting in the top toolbar. Selecting plain text did not create a floating toolbar, including with Show formatting hidden. Selecting text and clicking Bold changed only that selection. Link opened an Add link dialog with the selected text prefilled. The toolbar was approximately 38px high with 4px padding; buttons were 28px square with 4px radius. The Add link dialog was 520px wide with 8px radius. This test used a temporary unsent draft in the initially empty random channel, then cleared it; the existing general-channel draft was preserved. Cmd/Ctrl+K opened search in the empty composer, so no link shortcut was inferred from it.

Rendered HTML and computed styles are retained in `selection-toolbar.json` and `link-dialog.json` alongside the message captures. A screenshot is retained as `slack-selected-text.jpg` in the visualization directory above. These observations cover the standard composer in the current web version, not every selection context.

## Applied frontend changes

`MessageActions` now renders the captured toolbar geometry and More menu ordering. Existing reaction and reply callbacks are retained. `MessageActionHandlers` supplies application callbacks for forward, to-do, agent, edit, unread, save, reminder, reply notifications, copy, pin, apps, and delete. Only supplied actions appear. The shared Menu supports arrow keys, Home/End, Escape, outside dismissal, and optional fixed portal positioning so scroll containers do not clip it. Failed asynchronous actions show an error; copy operations show confirmation only after success.

Main chat connects Reply and Copy message. Its server currently has no reaction/edit/save/pin/delete command contract; this pass does not create one or show those operations as persisted. The gallery at `/design-system#message-actions` exposes all callback controls as an explicitly labeled local preview, with local reaction state and real clipboard actions.

The existing rich composer keeps the captured top-toolbar selection behavior. Toolbar buttons now use the measured 28px dimensions. Links preserve selection on cancel, close, and save, show the active linked state, prefill selected text/current URLs, and retain URL validation. The link dialog uses the measured 520px width and 8px radius. A floating selection bubble was not added.

Automated checks cover controlled quick reactions, permission/capability-based menu availability, menu keyboard/focus behavior, outside dismissal, clipboard failures, main-chat copy, selected-range formatting, link editing, and unsafe-link rejection. Build and UI/web typechecks pass; the full UI run at verification time passed 101 tests (61 shared UI, 40 web, including concurrently added web coverage).

Browser checks exercised selected-text bold, link prefill/cancel restoration, lists, code blocks, clipboard success, and menu keyboard navigation. Copy feedback occupies a separate grid row; the measured message body remained 304px wide before and after feedback. At 390px and 320px, menus stayed within the viewport without horizontal overflow. Below a 300px message container, quick presets yield to the reaction picker; this responsive adaptation is authored for Space. Both menus use the same clamped portal positioning and restore trigger focus. Viewport overrides were reset. The light theme was not visually rechecked in this pass.

Final preview screenshots: `space-text-actions.jpg` and `space-text-actions-mobile.jpg` in the visualization directory above. A fresh authenticated chat session belonged to concurrent QA and had no channels, so live visual checks used the component gallery; main-chat copy/reply integration was verified in the web tests.
