# Slack conversation UI reference — 2026-11-04

Inspected the signed-in Slack web app in Brave, self-DM at `/client/T0F6QDEJD/dms`, using live DOM and computed styles. REA MCP was unavailable; its doctor reported missing registration and an unsupported local Node version. These are browser observations, not REA evidence records or recovered Slack source code.

## Observed measurements

| Element | Slack computed layout | Space implementation |
| --- | --- | --- |
| Conversation header | ~49px, padding 0 12px 0 18px | 49px, same padding |
| Header avatar | 24px square | 24px square |
| Header controls | 28px square | 28px square |
| Tab row | ~38px | 38px |
| Composer shell | 8px radius, dark background rgb(34,37,41), border rgb(86,88,86) | Same tokens |
| Formatting / editable / actions rows | ~38 / 38 / 40px | 38 / 38 / 40px, grows for wrapped controls/content |
| Editor text | 15px / 22px, padding 8px 12px | Same |
| Composer below-shell space | 24px | 24px desktop, 16px mobile |

Slack's fractional 117px shell includes a subpixel border at the browser's scale. Space uses a 1px border and totals 118px. The idle keyboard hint is absent visually; Space keeps status and error feedback visible.

## Message rows and adaptation

The self-DM was empty. The populated #general channel supplied shared message-renderer evidence: 15px text, 22px line height, 12px timestamps, 8px 20px gutters, and consecutive same-sender messages without a repeated avatar/name. Compact timestamps occupy the left gutter. Space keeps the sender and full timestamp accessible and reveals the compact timestamp on hover/focus (always on touch).

The exact Slack grouping cutoff was not established. Space uses five minutes, breaks on a local date change, sender ID/kind change, unread divider, intervening activity, or missing previous loaded message. DMs and agent sessions use the same presentation; selected Sidekick context remains a separate section with full attribution.

Following the subsequent UI feedback, DMs and agent sessions align short histories to the top with the same conversation introduction. Selected messages extend that session with an optional context section. Long histories retain virtualized scrolling and recovery. Existing Space features determine the actions: Files remains available, session details and approvals remain functional. Slack's canvas, scheduling, recording and shortcuts were observed but are not implemented as new services or inert lookalike controls in this change.

Reference screenshots are retained in the task artifact directory: `slack-dm-reference.png`, `space-slack-dm.png`, and `space-slack-agent-session.png`.
