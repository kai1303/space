# Agent Sessions Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan inline, task by task. The user has already approved implementation in the chat.

**Goal:** Multiple persistent Codex agent sessions per Space thread, with conversation and outputs in one integrated view.

**Architecture:** Extend agent_sessions for title/state/creator/skill/managed metadata. Reuse tasks as turns, current approvals and scoped delivery; persist Codex thread IDs locally and resume them. Add a thread sessions view using existing message/composer/output primitives and realtime subscriptions.

**Tech Stack:** PostgreSQL/Drizzle, Fastify/Socket.IO, React, Codex app-server stdio.

## 1. Contracts and storage
- [x] Add session summary/detail/turn contracts and validated optional response outputs.
- [x] Add migration 030_agent_sessions.sql; retain existing sessions as legacy runs. Add thread revision hints for session and turn changes.
- [x] Add scoped list/create/read/send/stop/end methods and routes. Session-bound turns share existing approval/outbox paths and never become human-thread messages.
- [x] Regression test two sessions per thread, independent histories, unchanged retry keys, grants/tenancy, owner approvals, concurrent send rejection and stop/end.
- [x] Follow the newly added architecture principles with managed-session revision checks, bounded serializable transaction retries, and concurrency/regression verification; apply migration031 locally.

## 2. Persistent connector
- [x] Add private atomic local session mappings keyed by Space session UUID, inside an installation/account-specific Codex home.
- [x] Use thread/start with ephemeral:false for a new managed session and thread/resume for later turns. Keep ephemeral legacy task behavior and all current tool restrictions.
- [x] Test same-session resume, two-session separation, restart persistence, missing/corrupt state and safe interruption using synthetic app-server processes.

## 3. Integrated session UI
- [x] Add an independent Agent sessions panel, opened from its source thread, with a session list, creation form and independent rich composer. November4 correction replaces the original thread tab.
- [x] Render user prompts, streaming/saved agent responses and approvals as the session conversation. Integrate activity/preview/files/changes with safe existing renderers; Stop and End remain inside this view.
- [x] Preserve drafts while switching views; subscribe to thread revisions, clear immediately on revocation and expose retry on transient failures.
- [x] Test create/switch/send/approve/end, outputs and reconnect/revocation.

## 4. Verify and run
- [x] Run affected contract, connector, database and web tests, typechecks and builds.
- [x] Apply migration to the local dev database, restart only affected processes and inspect the working session UI in the browser.
- [x] Verify real same-session follow-up across a connector restart if local authorization is available; report synthetic/live boundaries honestly.

No automatic commits or pushes; preserve concurrent workspace changes.

## Verification evidence

- November4 independent-panel correction:226 web tests and100 shared UI tests passed; web build passed. Browser verified the thread header button, independent panel, Back to thread, and retained session draft. Screenshot: `agent-session-separate-panel.png` in the same visualization directory below.

- Web:225 tests; shared UI:100 tests; connector:51 tests; focused session/local-Codex/outputs backend batch:27 tests. Seven-package typecheck and eight-package build passed. Independent review fixes were re-reviewed.
- Final revision concurrency checks:88 related backend regression tests passed, plus the added concurrent event/Stop test. Managed SQL capture found no explicit locking query; forced database conflicts returned409 after five rolled-back attempts. Final typechecks/builds and independent review passed.
- Live local browser: created two sessions in one thread, first session returned SPACE_SESSION_7391 before and after connector restart (PID93283 to93608), second returned SESSION_ISOLATED. Stopped a running real model turn and received SESSION_CONTINUES in a later turn on the same session. End retained history and removed its composer.
- Screenshot: `/Users/kai/.codex/visualizations/2026/11/03/01a1a1a5-5a00-7b21-8625-ad3030d7f787/agent-sessions-working.png`.
- Migrations030 and031 applied to local development database; local API and connector restarted. After the final API restart, the retained first session returned SESSION_CAS_OK on a third turn. Repository tools remain disabled. No production deployment, commit or push.
