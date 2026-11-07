# Mention notifications: Slack comparison and Space behavior

Checked November 6, 2026. This pass uses Slack's current official documentation, the retained client/UI investigation in [Slack notifications research](../architecture/slack-notifications-research.md), and current Space source and tests. It does not claim new live multi-account Slack testing or knowledge of Slack's private backend.

## Recipient rules

| Mention | Recipients | Constraints |
| --- | --- | --- |
| `@person` | The selected person, identified by ID | Private-channel and DM recipients must belong to that conversation. Public-channel nonmembers can receive Activity. |
| `@here` | Active channel members | No broadcast notification from a thread reply. |
| `@channel` | Channel members, active or away | No broadcast notification from a thread reply. |
| `@everyone` | Members of the workspace's general channel | Only in that channel; guests cannot use it by default; no broadcast notification from a thread reply. |

Slack asks for confirmation in channels with at least six members. Workspace owners/admins can restrict broadcasts. Paused notifications do not interrupt recipients. Sources: [direct mentions](https://slack.com/help/articles/205240127-Use-mentions-in-Slack), [broadcast mentions](https://slack.com/help/articles/202009646-Notify-a-channel-or-workspace).

Slack distinguishes visible activity from interruption: muted conversations can retain mention badges, and delivery preferences control desktop/mobile notifications. Sources: [muted conversations](https://slack.com/help/articles/204411433-Mute-channels-and-direct-messages), [notification preferences](https://slack.com/help/articles/201355156-Configure-your-Slack-notifications).

## Implementation

Space already had semantic mention autocomplete, stable identity validation, the general-channel identity, six-member confirmation, broadcast permissions, presence-based recipients, thread suppression, an Activity inbox, notification preferences, opt-in browser alerts, atomic delivery claims, and event-driven refresh/reconnect recovery. This change extends those paths:

- New public-channel nonmember mentions now enter Activity as well as the legacy Mentions inbox. These are in-app-only notifications. Nonmembers do not receive ordinary channel posts or followed-thread activity merely because their global preference is “all”.
- Activity visibility rechecks active workspace membership, guest assignments and current channel privacy for every read and read-state mutation. Public mentions can remain visible after a full member leaves a public channel. Other notification categories still require channel membership.
- Desktop claims separately require current channel membership. Joining later does not turn an earlier silent mention into a delayed alert.
- Opening a channel notification uses authorized channel discovery, allowing nonmembers to reach the existing join screen. Reading message history still requires joining; mentions never grant membership.
- Paused mentions remain counted and styled as unread in the legacy inbox, consistent with Activity. Pause suppresses interruption, not catch-up state.
- Guests no longer see `@everyone` in autocomplete, and forged/stale selections are rejected by the send API. Their otherwise-authorized `@here` and `@channel` behavior remains intact.

Message insertion and notification creation remain transactional. Existing uniqueness constraints deduplicate overlapping mention kinds and retries. No new dependency, schema migration, polling, explicit database lock, or distributed lock is introduced.

## Verification and limits

Regression coverage includes public nonmember Activity, read synchronization, no implicit membership, guest/private/workspace revocation, all three broadcast types, thread suppression, direct thread mentions, paused unread counts, guest broadcast denial, duplicate sends, concurrent desktop claims, and navigation through joining to the source message. The websocket test owns a schema-scoped CDC bridge and checks both member and nonmember notification delivery/reconnect recovery.

Validation uses disposable database schemas and temporary PostgreSQL/NATS containers. The shared NATS broker reported insufficient storage during the initial run and was left unchanged.

Final checks: 31 backend/contract tests and 99 frontend tests passed. PostgreSQL adapter build, web production build, and web/test-project typechecks passed. The web build reported bundle-size and dependency `use client` warnings. Temporary test services were removed after verification; no shared migration or deployment was performed.

No historical nonmember mentions are backfilled into Activity; they remain in the existing Mentions inbox. Browser alerts still require an open Space session and explicit browser permission; real operating-system banners and closed-browser/mobile push are outside this verification. `@here` continues to use Space's stored active/away presence. Slack's configurable warning toggle, large Enterprise-channel policy, user-group mentions and per-channel mute settings are not added by this change.
