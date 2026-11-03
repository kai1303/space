# Channel management verification — 2026-11-03

Implemented persisted channel details (name, topic, description), member listing/search/add/remove, public leave/rejoin, private leave/invitation, and archive/restore. About, Members and Settings use the shared accessible dialog and tabs. Archived channels retain message and thread history and hide composers; server checks reject new messages, replies, member additions and agent tasks. Existing creator/workspace-admin permissions remain in force.

## Slack evidence

Inspected the real Slack `#random` channel dialog, About/Members/Settings tabs and rename/topic/description/add-people forms through live DOM and computed CSS. No Slack changes were submitted. Local source captures are under `/Users/kai/.codex-artifacts/space-slack-2026-11-03/channels/`.

Measured geometry used: details dialog 580px wide, field editors 520px wide, 8px corners, 36px tab strip, 15px/22px field typography, 22px/30px heading. Space uses its existing theme tokens and icons. Adaptations: only implemented tabs/actions are displayed; existing channel naming remains compatible; invitations select existing workspace people; management follows Space's creator/admin policy. Private channels must retain at least one active manager. Archiving requires pending/running agent tasks to be resolved first.

## Verified results

| Check | Result |
| --- | --- |
| Real browser checks | 43 passed |
| Additional HTTP/PostgreSQL assertions | 13 passed |
| Chat and channel-management integration tests | 23 passed |
| Full web test suite | 131 passed across 17 files |
| Workspace typecheck | 19 tasks passed |
| Production build | 11 tasks passed |

Browser tests used the compiled React app, actual Fastify API, PostgreSQL and Socket.IO with synthetic owner/member/invitee/outsider accounts. No API or socket responses were mocked in these browser runs. The normal app at `http://127.0.0.1:5173/chat` was also checked against the updated API and migration 017. Its previous synthetic profile test session was restored, with channel details left open.

The browser covered:

- Saving rename/topic/multiline description, immediate header/sidebar updates, cancellation, reload persistence and channel-ID copying.
- Member list/search/empty results, excluding existing members and other workspaces from invitations, add/remove and cancelled removal.
- Regular-member restrictions on edits, invitations, removals and archiving; HTTP attempts independently confirmed the restrictions.
- Public leave/cancel/rejoin, removal of loaded content on leave, private-leave warning, removal from discovery and immediate fallback to another conversation.
- Sole private manager departure blocked with an actionable message.
- Real root message and thread reply, archive cancellation/confirmation, preserved history, both composers hidden, reload persistence, restore and successful subsequent message.
- Cross-client membership revocation and re-invitation; revoked drafts do not return. A final regression used a 60-second socket reconciliation interval so channel-list discovery detected revocation first, verifying the draft is cleared in that ordering too.
- Native modal focus, Escape and focus return after animation, arrow-key tab navigation, light/dark rendering, 390px dialog/editor fit and reachable Save action. Device overrides were reset.
- No browser warnings/errors were captured in the inspected log window.

An initial Escape/focus probe ran before the close animation completed. It was rerun after the transition and passed; raw browser evidence retains that early probe and its resolution.

## Regression fixes

1. Private leave now selects an available conversation instead of displaying the first-channel empty state.
2. Private channels cannot lose their last active creator/admin/owner membership.
3. Agent eligibility uses `FOR NO KEY UPDATE`, preserving archive serialization while allowing foreign-key key-share locks. A deterministic real-PostgreSQL test reproduced `40P01` before this fix and passes after it.
4. Channel discovery clears revoked drafts/uploads even when it wins the race against socket revocation. The regression failed with a restored private draft before the fix and passes afterward.
5. Field and people-search focus is set after the native dialog opens. Refresh responses cannot overwrite newer local channel mutations.
6. The historical message-migration fixture now inserts historical columns explicitly, so newer channel fields do not invalidate its pre-migration database setup.

## Evidence and limits

Raw browser/HTTP results, scripts, fixtures and screenshots: `/Users/kai/.codex-artifacts/space-channel-e2e-20261103/`. Synthetic credentials in fixture files are local test data. Screenshots include `desktop-about.png`, `mobile-about.png`, `light-about.png` and `main-app.png`.

Channel metadata from other clients refreshes on window focus and every 10 seconds while visible. This build does not add channel deletion, visibility conversion, notification preferences, email invitations or agent channel membership. Tests establish local behavior, not production deployment or load capacity. Existing bundler `use client` notices and the Node test runner's localstorage notice remain non-fatal.

New routes: `GET/PATCH /v1/channels/:channelId` and `GET /v1/channels/:channelId/members`. Membership mutations reuse existing routes. Migration 017 adds topic, description and archive timestamp with backward-compatible defaults.
