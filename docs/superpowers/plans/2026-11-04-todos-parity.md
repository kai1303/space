# Slack To-dos parity implementation plan

Goal: apply the To-dos layout and interactions observed in the signed-in Slack workspace in Brave on 2026-11-04 to Space's existing personal Todos.

Architecture: retain owner/workspace authorization and durable workspace updates. Use existing rich-text components and the durable event service for reminders; no polling or new locks. Keep additions isolated from other ongoing sidebar and messaging work.

## Observed reference

- List and detail split, with Add To-do and Clean up in the list header.
- Creation opens a right-hand rich-text composer, with an optional reminder.
- Filters: in-progress, completed, overdue, upcoming reminders, no reminder scheduled. No filters selected by default.
- Sort: due date (default), earliest created, latest created.
- Reminder presets: 30 minutes, 1 hour, 3 hours, tomorrow 9am, Monday 9am, custom.
- Cleanup menus expose complete, move to Saved, clear, and remove deleted source messages; completion scopes include all, overdue, overdue by 30+ days.
- Existing Space supports title-only creation/editing/completion and local status filtering.

## Implementation

- [x] Extend owner-scoped Todos contracts/store/API with rich documents, reminder dates, archived/deleted state, source-message references, bounded server filtering/sorting, and atomic partial updates.
- [x] Add durable reminder delivery through existing event service, cancelling stale/completed/removed reminders with conditional writes and deduplicating delivery.
- [x] Replace title-only form with two-pane list, rich-text creation/editing, status/reminder filters, sorting, contextual actions, and cleanup.
- [x] Connect message-to-todo and archived todo display in Saved using existing message controls.
- [x] Verify validation, authorization, retries, concurrency, reminder recovery, UI interactions, build/typecheck, and Brave desktop/mobile rendering.
- [x] Record observed behavior versus authored adaptations and remaining evidence limits.

The user's request authorizes implementation of this reference. Preserve all pre-existing changes; no commit/push or deployment is requested.

## Comparison and evidence

| Area | Slack observed in Brave | Space before | Implemented |
| --- | --- | --- | --- |
| UI | List/detail split; actions in list header; right-side rich composer | Inline plain title field and narrow title editor | List/detail split, header actions, rich composer, responsive detail screen, centered empty-state illustration |
| Behavior | No filter selected initially; due-date sort; independent status/reminder filter groups | In-progress default, loaded-page filtering | All by default, due/oldest/newest ordering, server-side status/reminder filtering |
| Function | Rich text, reminder presets/custom time, cleanup, Saved separation, message entry | Create, rename, complete; message entry copied only title | Rich documents, source links and authorization, reminders, cleanup, archive/restore, undo clear |
| Reliability | Server internals not inspected | Idempotent IDs and workspace events | Partial writes, optimistic editor revisions, replay-safe creation, durable versioned reminder events; authorization rechecked on reads and delivery |

Reference: https://app.slack.com/client/T0F6QDEJD/to-dos (authenticated Brave session, 2026-11-04).

Captured reference states: empty list; creation editor; reminder presets/custom dialog; filter, sort, and cleanup menus. Slack had no existing to-dos. No Slack data was created or deleted; populated-row behavior and outbound reminder delivery were not directly verified. Space's implementation of those flows was tested locally.

Evidence images are in `/Users/kai/.codex/visualizations/2026/11/04/01a1a5c6-14bb-7693-91e3-d8ebe0059b26/`: `slack-todos-empty.jpg`, `slack-todos-create.jpg`, `slack-todos-reminder.jpg`, `space-todos-empty.jpg`, `space-todos-create.jpg`, `space-todos-mobile.jpg`, and `space-todos-final.jpg`.

Authored adaptations: Space uses its own icons, status/reminder selectors within the filter popover, native custom date/time input, explicit cleanup confirmation and continuation after each 240-item batch, reversible clearing, and a Saved To-dos subsection. The Slack legacy migration banner is omitted. Reminder delivery is persisted and displayed in Todos; email, OS push, Slackbot messages, and Activity inbox notifications are not implemented by this change. Mention identities in existing rich documents are retained; the Todo editor does not send mention notifications.

## Verification

- Full web suite passed: 338 tests at the broad verification point. Subsequent focused tests cover additional fixes for custom date autofill and HTTP/socket revocation during post-write refresh.
- Todo/backend/deadline/broker integration: 23 passing tests, including overlapping writers, schedule generation reuse, revoked sources, durable redelivery and rollback.
- Web and server builds/typechecks passed at earlier checkpoints. Final focused UI checks: 11 Todo tests plus 19 composer tests passed. Follow-up verification: the concurrent WorkspaceInvitations.tsx errors are resolved in the current workspace; the complete web build passes. The broad web run passed 349 tests in 40 files but caught an omitted CheckCircle import in Todos; after restoring that import, all 11 Todo tests pass and the complete web build passes again. No changes were needed to WorkspaceInvitations.tsx in this follow-up.
- Brave verified local creation, persistence after reload, rich-text editing, reminder presets and custom dates, completion, moving to Saved, restoring, and mobile details; the local event bridge delivered the due reminder after restart and the UI displayed Reminder due.
- Migration043 applied locally; server and event bridge restarted to load the new reminder handler and subject configuration.
- No production deployment or performance/load claim. Existing unrelated work remains uncommitted.

## Empty-state follow-up (2026-11-04)

- Replaced the generic checkmark icon with the actual illustrated Slack empty state observed in Brave, sized at 157×140px and centered above the heading, explanation, and Add To-do button. The image is decorative (`alt=""`) and served locally.
- Asset: `apps/web/public/illustrations/todos-empty.svg`. Source: https://a.slack-edge.com/bv1-13-br/empty-later-dark-e21422d.svg, captured from Slack’s rendered Todos page via its image asset inventory. This is a third-party Slack asset, not an original Space illustration; the repository’s MIT license does not grant rights to this asset.
- Verified desktop and 390×844 mobile layouts in Brave. Screenshots: `space-todos-empty-illustration.jpg` and `space-todos-empty-mobile.jpg` in the evidence directory above.
- Moved only our completed synthetic “Review Todos parity” verification item to Saved to expose the real empty state; it remains recoverable there. The local preview is left on the empty Todos page.
