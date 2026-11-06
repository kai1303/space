# Full Coding Sessions Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Follow test-first implementation and review each task before integration.

**Goal:** Run local Codex, Claude and Kiro coding workflows through Space, then demonstrate an agent-authored README commit and GitHub push.

**Architecture:** Extend native adapters with opt-in coding and owner-approved tool requests. Persist approval decisions under current session/execution authorization and deliver them with existing event-driven transport. Retain chat-only defaults, session recovery and bounded execution.

**Tech Stack:** TypeScript, React, PostgreSQL/Drizzle, Socket.IO, existing WAL/JetStream resource updates, Codex app-server, Claude Agent SDK and Kiro ACP.

### Task 1: Approval contract and durable backend

- [x] Add `packages/contracts/local-tools.ts`: bounded request parser, decision/status types, 30-minute coding deadline constant; export from index.
- [x] Add migration 060 and `adapters/postgres/tool-approvals.ts`: requests keyed by UUID, exact execution/connection binding, owner-only decision, idempotence and conditional transitions. Trigger existing resource updates for the source thread.
- [x] Add session read/decision APIs and connector request/decision receipt transport. Never wait for a human inside the serialized task RPC queue.
- [x] Test unauthorized actors, changed duplicate requests, concurrent decisions, terminal/stale execution, reload and disconnect. Use existing integration DB isolation.

### Task 2: Runtime adapters

- [x] Add optional runtime controls callback for approvals, propagate through session-runtime and turn-scoped runtime wrappers.
- [x] Add `--coding` requiring `--project`, isolate coding session namespace, preserve existing chat mode.
- [x] Gate first coding session use on project approval; forward native requests using Allow once/Deny only. Use current local owner policy and exact invocation context.
- [x] Enable scoped native file/command tools in Codex, Claude and Kiro; normalize command output, file changes and errors into existing bounded timeline.
- [x] Replace two-minute coding deadlines consistently, preserve stop and uncertain-outcome handling; keep chat limits.
- [x] Run new failing provider fixtures first, then connector suite. Include wrong thread/turn, denial, cancellation, resumed sessions and tool bursts.

### Task 3: Session UI and integration

- [x] Add `features/agents/ToolApprovals.tsx` with owner-only actions, read-only waiting state, stale response handling and accessible labels.
- [x] Connect approval state to existing session updates; preserve composer drafts and view cleanup.
- [x] Test owner/participant behavior, allow/deny, pending state after remount, and completed/expired requests.
- [x] Run build/typecheck, relevant API tests and provider tests; review spec compliance and code quality.

### Task 4: Live acceptance and evidence

- [x] Launch isolated updated app/connector without overwriting existing credentials or disrupting unrelated sessions.
- [x] Use an isolated Git checkout/branch for the README exercise, with the existing authorized GitHub identity.
- [x] Start the Space session, submit the README/commit/push prompt, answer only the approvals already authorized by the user, and follow to completion.
- [x] Verify resulting README diff, commit, remote branch and session history. Display session to user and save concise evidence.
- [x] Document actual validation and remaining limits; do not claim unperformed provider E2E or production verification.

## Acceptance evidence — 2026-11-06

- Full build and typecheck passed. Connector suite: 132 passing tests; workspace/session/approval UI: 46 passing tests; focused contract/backend suites: 42 passing tests across the original run and the CDC-corrected rerun. The first broad backend run hit the shared JetStream storage reservation limit. A dedicated broker plus per-test-schema WAL bridges resolved the infrastructure failures; test resources were cleaned up.
- Live Space session: `d056879b-beb9-4723-b1e2-ac756d70534b`, in the local Files E2E workspace. Created through Discuss with agent from a self-DM; project approvals identify its private audience.
- Real Codex read both READMEs, changed only root README.md, passed `git diff --check`, created commit `3b6f4259a25c2dd11dde15b1f8463451ca625a2f`, and pushed `codex/space-coding-readme-e2e` to `kai1303/space`. Independent `git ls-remote` matched that SHA. Native commit/push approval requests were approved once through Space.
- Live testing exposed an approval transport bug: spreading a complete Invocation sent fields outside the strict request schema. Commit `3e89997` fixes serialization to explicit execution identity; its full-invocation regression failed before and passed after the fix. Earlier failed attempts remain visible in session history.
- Git's isolated HOME needed a repository-local helper that invokes the existing gh/keychain identity with its original home. No provider or GitHub credentials were copied into the repository. The first push failed authentication; after setup correction, a follow-up turn resumed the same native conversation and pushed successfully.
- Reloading while project consent was pending preserved the approval. The Changes view retained the 22-line README diff across turns and reload.
- Live inference acceptance covers Codex. Claude and Kiro are covered by protocol/provider fixtures, including permission denial, attribution, cancellation and bounded tool bursts; authenticated live coding E2E for those providers and production rollout remain unverified.
