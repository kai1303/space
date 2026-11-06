# Claude provider implementation plan

Goal: add Claude as a local agent alongside Codex and Kiro, as approved in chat.

Architecture: use the Claude Agent SDK behind `AgentRuntime`; reuse pairing, durable events, session mappings and project filesystem MCP. Authenticate through the installed Claude Code CLI's native local login, as clarified by the user. Use a private Claude profile and hash account identity for session scoping. Keep chat-only defaults, explicitly selected project tools, one active turn, bounded output and deadlines. Do not inherit user/project Claude settings or credentials. No new polling or coordination locks.

1. Add failing contract, CLI, UI and enrollment cases for Claude. Extend the provider registry, pairing mismatch guard and provider constraint in migration 055; preserve existing concurrent edits.
2. Add a tested SDK runtime in `apps/connector/claude.ts`. Verify streaming, project tool restrictions, account-scoped private session resume, durable readiness before inference, cancellation, backpressure and failures. Use isolated credentials/settings and sanitize provider errors.
3. Connect CLI startup and native local sign-in guidance; update the connection dialog and connector documentation.
4. Run connector tests, contract tests, focused PostgreSQL/Socket.IO and UI tests, typechecking and builds. Validate SDK initialization without paid inference; report live inference separately.

The approved scope uses the existing project-file tool boundary. Native shell and interactive mid-turn approval are unsupported, as with the other local providers.
