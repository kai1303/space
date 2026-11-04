# Slack Sidebar Parity Implementation Plan

> **For agentic workers:** Use superpowers:dispatching-parallel-agents for independent backend, personal-view, and directory-view implementation. Root owns navigation integration and browser validation.

**Goal:** Match the observed Slack navigation and give every Space destination a useful default screen connected to available capabilities.

**Architecture:** Keep the existing authenticated Chat shell, conversation components, realtime subscriptions, permissions and upload rendering. Add bounded, authorization-filtered workspace collection endpoints for threads, sent messages and files, plus owner-scoped saved messages and to-dos. Home shortcuts keep the conversation sidebar visible. Main rail destinations get their own contextual navigation. Spacebot is the Space adaptation of Slackbot; it routes users to their installed agents rather than impersonating Slack's service.

**Tech Stack:** React, existing @space/ui and Motion, Fastify, PostgreSQL, Socket.IO resource updates.

## Reference evidence

Live Slack inspection on 2026-11-04: 8 rail items (Slackbot, Home, DMs, Activity, Files, To-dos, Agents & tools, Admin); Home has Threads, Huddles, Drafts & sent, Saved, Directories above Starred, Channels, Direct Messages, Apps. Admin is a popup, not a page. Files has All files, Canvases, Deleted, Starred. Agents has All agents, Workflows, Apps; directories has People, Channels, External, Invitations. Threads shows parent/recent replies with a composer. Drafts has Drafts, Scheduled, Sent. To-dos uses a list/detail split. DMs retains its list alongside the shared conversation. Activity has All, DMs, Mentions, Threads tabs.

Space adaptations must say when unsupported capabilities are unavailable (calling, scheduling, external organizations, canvases, third-party workflows). Do not add fake success actions, paid-plan prompts or Slack branding. Preserve existing agent and chat UI decisions.

## Tasks

- [x] Backend: `packages/contracts/workspace-hub.ts`, `adapters/postgres/workspace-hub.ts`, migration 041, `apps/server/workspace-hub.ts`, API registration and integration tests. Bounded cursor pages; actor membership and channel access on every read/write; idempotent saved and todo mutations; no new explicit/distributed locks or polling.
- [x] Personal views: `apps/web/src/WorkspaceCollections.tsx`, tests and CSS. Threads, Saved, Sent, Files and To-dos use the hub endpoints. Show loading/error/empty/populated states, filtering, pagination, links to source, saved removal, todo creation/completion and a detail pane.
- [x] Workspace views: `apps/web/src/WorkspaceDestinations.tsx`, tests and CSS. Directories People/Channels/External/Invitations, agent catalog installed/available plus Workflows/Apps, Spacebot agent entry screen, Huddles honest unsupported state. Use current APIs and existing pairing/member dialog.
- [x] Root integration: extend `ChatShell.tsx` rail to 8 entries; remove redundant Search/Members rail entries while retaining global search and directory/member access. Admin popup routes to actual workspace settings, members and agents. Extend shared `WorkspaceSidebar` with all 5 shortcuts and selected states. Keep Home shortcut view separate from channel selection. Add drafts list connected to user-scoped composer draft storage. Wire save-message and star-conversation actions.
- [x] Review DMs and Activity against captured Slack defaults; adjust relevant existing UI without replacing shared conversations.
- [x] Validate focused component and authorization/concurrency tests, then build/typecheck and full relevant suite. Apply additive migration locally, restart API if required. Click every sidebar destination in authenticated browser, inspect narrow layout, capture final screenshot, document remaining product capability differences.

## Shared endpoint contract

All paths below start `/v1/workspaces/:workspaceId/hub`. GET returns `{items,next_cursor}` with bounded `limit` and optional `after`.

- GET `/threads`, `/sent`, `/saved`: `HubMessage` with `id,channel_id,channel_name,thread_id,text,author_name,created_at,reply_count` and optional document.
- GET `/files`: `HubFile` with `id,channel_id,channel_name,message_id,filename,content_type,byte_size,preview_kind,created_at`.
- GET `/todos`: `HubTodo` with `id,title,completed,created_at,updated_at`.
- POST `/todos/:id`: `{title,completed}` upsert owned ID; response HubTodo.
- POST `/saved/:messageId`: `{channel_id,active}` idempotent toggle.
- GET `/starred`: page of `{id}` channel IDs; POST `/starred/:channelId`: `{active}` toggle.

Personal views export `WorkspaceCollections({view,workspace,onOpen})`, with view threads/saved/sent/files/todos and onOpen({channel_id,message_id}). Root renders drafts and passes Sent through this component. Workspace destinations export `WorkspaceDestinations({view,workspace,viewer,onOpenChannel,onOpenMembers,onOpenAgents})` for directories/agents/spacebot/huddles.

## Verification

Run focused tests with one worker; use database test schemas following existing integration helpers. Assert outsider and revoked-channel denial, actor isolation, duplicate-save idempotency, todo ownership, stable bounded pages. UI tests assert source navigation and meaningful mutations, filters and empty states. Final command: `pnpm exec turbo run build typecheck --concurrency=2`; then `pnpm exec turbo run test --concurrency=1` using the existing local test database environment. Preserve unrelated dirty thread-link cleanup. Do not commit or push as part of this goal without a new instruction.


## Delivery notes

Added 33 captured navigation SVGs after the user requested Slack icons. Sidebar stars return authorized conversation metadata and support paged navigation; selected conversation state uses an exact read. Message-to-do creation uses a per-user deterministic ID and create_only semantics, preserving later edits/completion on retries. Threads overview opens the existing shared panel instead of mounting a composer per card. Full capability boundaries and browser evidence are recorded in docs/architecture/slack-sidebar-research.md.
