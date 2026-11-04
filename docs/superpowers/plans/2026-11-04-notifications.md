# Slack-style Notifications Implementation Plan

> Use superpowers:subagent-driven-development for backend implementation and focused independent reviews. The user's “do the same way” authorizes researching and building the next working increment.

**Goal:** Implement persistent Activity for direct messages, mentions, followed-thread replies and reactions, plus read controls and opt-in browser alerts with pause/privacy preferences.

**Architecture:** A durable recipient-specific notification record is separate from channel unread state and from best-effort desktop banners. Insert activity in the same transaction as messages/reactions, retain existing mention identity/access rules, and reuse workspace resource-update delivery and reconnect refresh. No new polling, explicit database locks or distributed locks. Current unrelated dirty files remain untouched and no commit/deploy is requested.

**Tech stack:** PostgreSQL, existing serializable retry helper, Fastify, React, Socket.IO, browser Notifications API.

## Contract and behavior

- Notification item: `id` numeric string, `kind: 'mention'|'direct_message'|'thread_reply'|'reaction'|'channel_message'`, `channel_id`, `channel_name` viewer-relative for DM, `channel_kind`, `message_id`, `thread_id`, `author_name` of triggering actor, `text` bounded500, `emoji:string|null`, `created_at`, `read_at`, `silent:boolean`.
- GET `/v1/workspaces/:workspaceId/notifications?before=&kind=&unread=true` returns `{items,unread_count,next_cursor,latest_id}`; max50/page, global unread count within authorized workspace, watermark/latest_id for mark-all races. `kind=direct_message` may include mentions/replies whose channel is direct, remaining filters by kind.
- PATCH `/v1/workspaces/:workspaceId/notifications/:id` body `{read:boolean}` returns `{read:boolean}`. POST `/notifications/read` body `{through:string}` marks only IDs <= a previously seen watermark, never a racing later arrival.
- GET/PATCH `/v1/workspaces/:workspaceId/notification-settings` returns `{mode:'mentions'|'all'|'none',desktop_enabled:boolean,preview_enabled:boolean,thread_replies:boolean,paused_until:string|null}`. Defaults mentions,false,false,true,null. Preferences per user, shared across workspaces; reuse existing mention pause to avoid conflicting switches. Validate patches, pause at most7days, no empty update/unknown keys. Pausing suppresses interruption, preserves activity and unread.
- POST `/v1/workspaces/:workspaceId/notifications/:id/claim` body{} returns `{deliver:boolean,notification?:NotificationItem,preview_enabled?:boolean}`. Atomic once-only claim across tabs/sessions, authorize again, exclude read/silent/older than2minutes/currently disabled or paused. Return fresh server-authorized content for banner, not cached text. No lease. Banners are best effort; Activity is durable recovery.
- GET/PATCH `/v1/threads/:threadId/notification-subscription` returns `{following:boolean}`, patch `{following:boolean}`. Automatically follow human thread author/repliers/mentioned humans, but an explicit false must not be reset by later participation. Current thread access required.
- Single message notification per recipient with priority mention > DM > followed reply > all-message preference. No self notifications, no inaccessible recipient. Reactions notify original human author once per message/reactor/emoji, retries or remove/re-add do not spam. Existing mention rows are retained/backfilled into Activity where safe; do not lose legacy endpoints.
- New paths must use constraints/atomic writes and bounded optimistic transactions. Existing message write locks in regular channels are inherited migration work, do not introduce more. Notification mutations and read APIs must not add locks.

## Execution checklist

- [x] Trace Slack Activity → filters/settings → global preferences, channel controls and pause menu without changing user settings or marking Slack items read. Capture shipped JS with REA and record provenance/limits.
- [x] Backend task: add migration040, contracts/exports, NotificationStore and routes; message/reaction hooks; durable update triggers; bounded cursors; preferences, subscription and claim APIs. Tests first for privacy, dedup/idempotency, read watermark race, filters, pause retains activity, once-only claim, revocation, following/explicit unsubscribe, reaction retry, and realtime reconnect. Use random schemas with TEST_DATABASE_URL from .env; no shared migrations.
- [x] Frontend task: `Notifications.tsx` Activity panel with All/DMs/Mentions/Threads/Reactions and Unreads, loading/empty/error states, Load older, mark read/unread, mark all, open target. `NotificationSettings` offers modes, pause15min/1h/resume, previews, thread alerts, explicit Enable desktop alerts permission action and denied/unsupported text. Activity rail badge; shared source-message routing preserves DM destination. Thread header following control.
- [x] Desktop delivery: persistent workspace hook, event-driven reads, initial/reconnect backlog suppression, bounded newest-page processing, visible-current-conversation suppression, server claim dedup before browser Notification. Close notification handles on teardown/revocation; never request permission automatically. Browser alerts require open app, no service-worker/mobile/email promise.
- [x] Red/green UI tests, focused backend regressions, build/typecheck, isolated browser desktop/mobile flow. Inspect independent spec then quality review and fix findings.
- [x] Write `docs/architecture/slack-notifications-research.md` with observed vs inferred behavior, flow, implemented boundaries, test evidence and rollout requirements. No production/parity claims.

## Deliberate boundaries

First increment excludes email/mobile push, OS sounds, keyword rules, recurring timezone schedules, VIP bypass, per-conversation notification overrides, custom saved Activity views and clearing/archiving Activity. These need separate product/delivery policies. Browser banners are at most once after claim, so a tab crash between claim/display may lose a transient banner; the Activity record remains unread and recoverable. Read Activity is independent of timeline read cursors. Legacy mention settings remain compatible.
