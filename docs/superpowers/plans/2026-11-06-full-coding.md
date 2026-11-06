# Full Coding Sessions Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Follow test-first implementation and review each task before integration.

**Goal:** Run local Codex, Claude and Kiro coding workflows through Space, then demonstrate an agent-authored README commit and GitHub push.

**Architecture:** Extend native adapters with opt-in coding and owner-approved tool requests. Persist approval decisions under current session/execution authorization and deliver them with existing event-driven transport. Retain chat-only defaults, session recovery and bounded execution.

**Tech Stack:** TypeScript, React, PostgreSQL/Drizzle, Socket.IO, existing WAL/JetStream resource updates, Codex app-server, Claude Agent SDK and Kiro ACP.

### Task 1: Approval contract and durable backend

- [ ] Add `packages/contracts/local-tools.ts`: bounded request parser, decision/status types, 30-minute coding deadline constant; export from index.
- [ ] Add migration 060 and `adapters/postgres/tool-approvals.ts`: requests keyed by UUID, exact execution/connection binding, owner-only decision, idempotence and conditional transitions. Trigger existing resource updates for the source thread.
- [ ] Add session read/decision APIs and connector request/decision receipt transport. Never wait for a human inside the serialized task RPC queue.
- [ ] Test unauthorized actors, changed duplicate requests, concurrent decisions, terminal/stale execution, reload and disconnect. Use existing integration DB isolation.

### Task 2: Runtime adapters

- [ ] Add optional runtime controls callback for approvals, propagate through session-runtime and turn-scoped runtime wrappers.
- [ ] Add `--coding` requiring `--project`, isolate coding session namespace, preserve existing chat mode.
- [ ] Gate first coding session use on project approval; forward native requests using Allow once/Deny only. Use current local owner policy and exact invocation context.
- [ ] Enable scoped native file/command tools in Codex, Claude and Kiro; normalize command output, file changes and errors into existing bounded timeline.
- [ ] Replace two-minute coding deadlines consistently, preserve stop and uncertain-outcome handling; keep chat limits.
- [ ] Run new failing provider fixtures first, then connector suite. Include wrong thread/turn, denial, cancellation, resumed sessions and tool bursts.

### Task 3: Session UI and integration

- [ ] Add `features/agents/ToolApprovals.tsx` with owner-only actions, read-only waiting state, stale response handling and accessible labels.
- [ ] Connect approval state to existing session updates; preserve composer drafts and view cleanup.
- [ ] Test owner/participant behavior, allow/deny, pending state after remount, and completed/expired requests.
- [ ] Run build/typecheck, relevant API tests and provider tests; review spec compliance and code quality.

### Task 4: Live acceptance and evidence

- [ ] Launch isolated updated app/connector without overwriting existing credentials or disrupting unrelated sessions.
- [ ] Use an isolated Git checkout/branch for the README exercise, with the existing authorized GitHub identity.
- [ ] Start the Space session, submit the README/commit/push prompt, answer only the approvals already authorized by the user, and follow to completion.
- [ ] Verify resulting README diff, commit, remote branch and session history. Display session to user and save concise evidence.
- [ ] Document actual validation and remaining limits; do not claim unperformed provider E2E or production verification.
