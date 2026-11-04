# Multiple Agent Providers Implementation Plan

> Execute inline with focused regression checks after each task.

**Goal:** Connect Codex and Kiro to Space's existing chat and session flow.

**Architecture:** Shared provider metadata and existing durable task delivery, with separate Codex and Kiro runtime adapters. Kiro runs ACP v3 with a private tool-free profile and independent local authentication/state.

**Tech Stack:** TypeScript, PostgreSQL/Drizzle, Socket.IO, React, Node child processes, ACP JSON-RPC.

- [x] Add failing contract, enrollment, UI and connector tests for Kiro selection and provider binding.
- [x] Add provider metadata in packages/contracts/agent-connection.ts; migration036 persists pairing provider and routes both local connectors. Update enrollment, session creation, Navigator and worker exclusion. Run enrollment/session tests including concurrent claims.
- [x] Add Members provider selector and provider-specific instructions; generalize local-agent discovery and session choices while retaining the legacy local-codex endpoint. Run focused web tests.
- [x] Add failing ACP tests using synthetic subprocess streams: initialization, tool-free mode, streaming, persistence, cancellation, denied requests, malformed/oversized responses and capabilities.
- [x] Implement apps/connector/kiro.ts and local Kiro authentication. Share the existing private atomic mapping storage, preserving Codex paths. Extend CLI with --provider and separate provider roots; bind claims to the expected provider and validate runtime skill.
- [x] Run connector tests, integration coverage for both providers, build and typecheck; inspect the final incremental diff and document setup and validation limits.

Concurrent workspace work generalized enrollment and routing through trusted connector descriptors and advertised persistent-session capabilities (migration037). The Kiro integration uses that model. Runtime types and private session storage are shared through agent-runtime.ts and session-storage.ts; Codex keeps its existing on-disk paths.
