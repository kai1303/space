# Sidebar navigation: Slack reference and Space implementation

Reviewed the authenticated Slack web app on 2026-11-04. This is a workspace-specific observation: Slack navigation can differ by role, plan and rollout.

## Navigation

| Surface | Observed Slack | Space |
| --- | --- | --- |
| Main rail | Slackbot, Home, DMs, Activity, Files, To-dos, Agents & tools, Admin | Same eight positions; Spacebot is Space's agent entry point |
| Home shortcuts | Threads, Huddles, Drafts & sent, Saved, Directories | All five, with selected states |
| Home conversation groups | Starred, Channels, Direct Messages, Apps | Same four groups; personal conversation stars are persisted |
| Files sidebar | All files, Canvases, Deleted, Starred | All files and persistent personal Starred; see the [Files comparison](slack-files-research.md) |
| Agents sidebar | All agents, Workflows, Apps | Same destinations; current agents/connectors are real Space installations |
| Directories | People, Channels, External, Invitations | Same tabs; real workspace people and discoverable channels |
| Admin | Popup of workspace administration actions | Popup for workspace settings, member management, and apps/agents |

Search remains in the topbar and channel header. Member management remains available from Directories, Admin and workspace actions. On narrow screens, selecting a Home shortcut closes the conversation-navigation overlay. The main rail scrolls when necessary.

## Default screens and behavior

Threads lists participated/followed conversations with replies and opens the existing shared thread panel and composer. It does not mount one reply composer per overview card. Saved opens source messages and supports removal. Message actions can save messages and create personal to-dos; retrying message-to-do creation preserves a previously edited or completed task. To-dos has add, filter, completion and editable details with bounded pages.

Drafts & sent shows Drafts, Scheduled and Sent. Channel, DM and thread drafts sync across the author’s devices through PostgreSQL and a private realtime subscription. Opening a draft restores its rich text and completed uploads in the original composer. The server checks destination access on reads and writes. Concurrent edits keep the local version available for resolution in Drafts. Encrypted DM drafts use the author’s linked devices. Agent-session drafts stay local. Sent uses authorized, newest-first message pages.

Files lists only ready assets attached to messages in conversations the viewer can access, reuses the existing preview/download UI, and links to source messages. Search, ownership, type, sender, conversation, date and sort operate on the server before pagination; personal stars and view history persist. Directory People excludes agent participants; installed agents have their own catalog. Channels can be joined and opened through existing authorization checks. The DMs inbox and Activity reuse their existing flows and shared conversation rendering.

## Explicit capability boundaries

The following screens describe unavailable capabilities rather than simulate them: audio/video Huddles, scheduled sending, external organizations, invitation tracking, workflow builder and a third-party app marketplace. Canvases and deleted-document recovery are not exposed in Files. Huddles offers a real channel discussion route. Spacebot helps users choose installed agents and a channel; it is not a separate AI service impersonating Slackbot. Connecting an agent opens the existing pairing UI and does not automatically expand its access.

The shared `NavigationIcon` component contains 33 local SVG icons captured from Slack's rendered interface, including the rail's outline/filled variants and bot glyphs. Icons are decorative; controls supply accessible names. Geometry lives in `packages/ui/src/navigation-icons.tsx`, with no runtime Slack asset requests.

## Data and recovery

Migration 041 adds actor-owned saved-message, starred-conversation and to-do tables and resource invalidation triggers. Every collection read and write rechecks active workspace membership and, when applicable, channel membership. Internal agent-session messages are excluded from human-message collections. Message/file cursors use descending timestamp plus UUID, preserving microseconds. Starred pages are bounded and the selected conversation's star state is read independently so a star outside the current sidebar page can still be removed.

Reads refresh through existing resource subscriptions, reconnect/focus recovery and explicit user pagination. There are no recurring resource scans, new explicit database locks or distributed locks. To-do refresh rereads only the loaded range, capped at 240 rows; a newly created row outside that range retains its last confirmed response until its page is loaded. This is not full cross-device synchronization for arbitrary unvisited to-do pages.

## Verification

Component tests cover navigation, access revocation, stale responses, page transitions, mutation retries, draft isolation and icon variants. Hub integration tests cover actor/channel isolation, revocation, concurrent idempotent toggles, to-do ownership and create-only retries, exact star state, and chronological keyset boundaries. Authenticated browser checks covered all eight main entries, all five Home shortcuts, contextual submenus, shared-thread opening, draft restore, saved removal, starring and To-do creation/completion.

The initial broad test attempt encountered CDC publication delays (one broker timestamp showed a 39.4-second delay). A subsequent healthy-bridge run passed all 349 contract/integration tests with concurrency four. The original cause of that earlier delay was not established; no timeouts or assertions were relaxed.
