# Sending from Slack’s Drafts & sent

Checked on November 14, 2026. Slack puts **Drafts**, **Scheduled**, and **Sent** in one sidebar destination. The composer sends to the current channel, DM, or thread. By default Enter sends on desktop, and the arrow beside Send schedules delivery. On mobile, tapping Send posts immediately and holding Send offers scheduling. [Slack’s messaging guide](https://slack.com/help/articles/201457107-Send-and-read-messages)

| Interaction | Behavior recovered from the shipped web client |
| --- | --- |
| Send from a draft row | The row has independent edit, schedule, and send actions. Send requires a sendable draft and an unlocked thread. On paths that show the confirmation dialog, it names the destination and offers Cancel and Send. Scheduled messages and drafts containing files for external recipients follow separate handling. |
| Deliver immediately | The channel/thread handler takes rich text, file IDs, link previews, and the original destination from the draft. For a thread it also passes the parent timestamp and the choice to share the reply with the channel. It removes the draft locally before delivery, finishes cleanup on success, and restores the draft if the send promise rejects. |
| Schedule | The client sends the requested delivery time with the draft, then reconciles the draft returned by the server. The confirmation for immediately sending a previously scheduled message can offer Send Later, Cancel, and Send Now. |
| Open Sent | The desktop page requests 25 outgoing items per page with a cursor and the `channel_and_thread` view. It groups rows by day. Selecting one jumps to its channel and message timestamp, passing the parent thread timestamp when present. An empty list offers to compose a message. A failed fetch offers a retry. |

REA 6.8.0 analyzed nine complete module factories extracted from two previously captured Slack web bundles. The render bundle includes `vZk6` and `Dq64` for the draft row and confirmation, and `rChF`, `tJCG`, and `WmNh` for the Sent list. The shared bundle includes `0Y95` for channel/thread delivery, `nHCL` for scheduling, `3Y5b` for the scheduled-send confirmation, and `Pgm1` for sending by draft ID. The module ranges, bundle digests, and REA evidence are retained under `~/.codex-artifacts/slack-drafts-sent/`. Evidence ID `ev_629fd602cc5be88e23c92073c1697de19ce383a4a1c45319cd5862d5fa646f51`.

These are static observations of the captured desktop web client. The mobile gestures come from Slack’s guide. Actual service delivery, production feature flags, and a live send failure were not exercised. The earlier [composer investigation](slack-composer.md) covers keyboard preferences, the pending-message row, and retry behavior.

## The draft row’s Schedule action

An eligible draft row shows a `schedule-send` icon with the tooltip **Schedule message**. For an already scheduled message, the tooltip reads **Reschedule message**. Activating the icon opens the **Schedule message** dialog directly. It shows the time zone, a date and time control with quarter-hour suggestions, **Cancel**, and **Schedule Message**. The client disables submission outside the window from five minutes ahead to 120 days ahead, rounding the bounds down to the minute. Rescheduling starts at the existing time. A fresh draft starts at a recipient-specific time if available, otherwise at the next whole hour within bounds.

The composer’s adjacent Send menu offers presets. They depend on the current weekday and hour. For example, on a Tuesday morning before 8, the standard menu offers 9 that morning, Monday at 9, and a custom time. Between 8 and noon it offers 1 that afternoon in place of 9. Features and recipient context can add tomorrow morning, a time suited to the recipient, or a previously used future time. Choosing a custom time opens the same dialog as the draft row.

Submitting closes the dialog and passes the requested date and parent thread timestamp to the scheduling operation. On success the client reconciles the returned schedule, remembers a custom time, and calls the completion handler. On an ordinary scheduling failure Slack displays a notice telling the sender that their message is available in Drafts to retry. The client handles messaging limits separately.

The row action came from `vZk6` in the original evidence. A second REA pass covered the full `TfGD` dialog, `CPqQ` time and menu rules, and `Xn3C` submission handler from the same shared bundle. Evidence ID `ev_da3826c757b0a8c7074941b0fe8e27c2ef7c58eb812d993324e663a9589f497e`. The extraction manifest and evidence are under `~/.codex-artifacts/slack-drafts-sent/schedule/`.

## Editing a draft

On desktop, the pencil labeled **Edit draft** and a normal click on the draft row both call the same handler with the draft ID. The default destination depends on where the draft was created. An ordinary channel or DM draft opens its conversation. A thread draft opens its original thread, then scrolls the reply editor into view and focuses it. A detached draft from New Message can reopen the Compose view by draft ID. There is no separate inline row editor in this flow. The page also has a bulk selection mode in which activating a row toggles selection.

The conversation editor loads the draft’s existing content. Once focused, it restores the saved cursor position when available, otherwise placing it at the end. The row navigation code explicitly requests focus for thread replies. Focus on entering a channel or DM depends on the destination view. Leaving the editor or switching conversations flushes pending draft updates. An unfinished edit therefore remains a draft without a separate Save action. Sending uses the original destination and the normal send path described above.

The default edit route is in `XCG0` and the scheduled-draft preparation in `rDYk`. REA evidence ID `ev_9a7bc207465f0ea8095d6322eaa40bc04a50d3260562148541f96dcb465de6b2`. The row handler is in `vZk6` in the first evidence record. The editor focus and flush logic is in `fqr4` in the [composer investigation](slack-composer.md). These code paths were inspected statically.

## Deleting one draft

The desktop row’s **Delete draft** trash button opens **Delete draft?**. The body asks whether to delete the draft and shows the destination in bold when available. An unaddressed draft gets the same question without a destination. The footer has an outlined **Cancel** button and a destructive **Delete Draft** button with initial focus. Cancel dismisses the dialog. Confirm dismisses it, removes the draft’s files and clears the draft. For an attached draft it also clears the matching conversation or thread editor. The row handler stops the click from opening the editor. There is no undo action in this handler.

Slack’s [messaging guide](https://slack.com/help/articles/201457107-Send-and-read-messages-in-Slack) documents the hover action. The dialog and its callbacks were verified statically in the shipped desktop web modules `vZk6` and `iXdX`. REA evidence for the latter is `ev_f806363b834b4c6c9d3140e4c1a2b429e65ef24258d955dff02e0eb7ef680993`.
