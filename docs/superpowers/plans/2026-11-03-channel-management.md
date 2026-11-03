# Channel management implementation plan

**Goal:** Build persisted channel details, membership management, leave/rejoin, and archive/restore from the observed Slack channel flow.

**Architecture:** Extend the existing ChatStore and authenticated channel routes. Reuse the channel/workspace membership policy and shared Dialog, Tabs, Avatar, and Button components. Keep details UI in its own component; wire its mutations back into the channel list and composer state.

**Evidence:** Live Slack `#random` About/Members/Settings and name/topic/description/add-people forms were inspected through DOM and computed CSS. Captures are in `/Users/kai/.codex-artifacts/space-slack-2026-11-03/channels/`. Details width is 580px, field editor width 520px, corner radius 8px. No Slack data was changed. Space retains existing creator/workspace-admin management permissions and existing channel naming compatibility. Channel invitations select existing workspace people.

**Tech stack:** React, Fastify, Drizzle/PostgreSQL, Socket.IO, existing Space UI.

- [x] Write and run failing API tests for persisted details, strict partial updates, permissions, private visibility, members, leave/rejoin, archive/read/send/restore and agent task protection.
- [x] Add migration 017 for topic, description and archive timestamp; expose typed summaries/details/member pages and routes. Serialize mutations using existing workspace/channel locks. Block archiving while active agent work exists and block new tasks in archived channels.
- [x] Run API tests, contracts/typecheck, and existing chat integration tests.
- [x] Implement accessible About/Members/Settings dialog, field editors, searchable workspace member picker, removal/leave/archive confirmations and restore. Update channel header/topic, sidebar name and composer/thread read-only state. Refresh channel summaries on focus and periodically to reflect other clients.
- [x] Run browser E2E against real HTTP/WebSocket/PostgreSQL using synthetic users: edit/cancel/reload, member search/add/remove, permissions, public/private leave/rejoin, archive/restore, messages and thread replies, keyboard and small viewport checks. Fix failures and rerun.
- [x] Run final typecheck/build and relevant suites. Record exact coverage and limitations in `docs/channel-management-e2e.md` with screenshot evidence.

Implementation stays inline because this workspace contains concurrent uncommitted work. No integration/commit actions are part of this task.
