# Full coding sessions in Space

## Outcome

Space is the discussion and review UI for local Codex, Claude, and Kiro coding sessions. A user can ask an agent to inspect and edit a project, execute commands and tests, review changes, and commit/push an explicitly requested change. Private sessions remain creator-private; conversation sessions retain their source conversation's access. Neither audience grants authority over a computer.

## Selected approach

Extend the existing native runtime adapters and session transport. Reuse their persisted provider sessions, streaming timeline, outputs sidebar, task approval, and event-driven updates. Compared with replacing every native tool with a new common MCP execution server, this preserves provider coding behavior with less custom execution machinery. A mandatory container would isolate execution more uniformly but would no longer use the user's existing local development environment; it is not required for this local release.

Local coding is explicitly enabled with a selected project. Chat-only launches retain their restrictions. Coding-enabled sessions use the project as their working directory and native provider permission controls. The first use of coding capabilities in a session requires the installation owner's approval, separate from another participant's task request. Approval identifies the project and audience. Provider requests for commands, file changes, or extra permissions are forwarded to that same owner through Space. Arbitrary remote paths cannot change the locally configured project. Permission controls must not be described as an OS read-root jail; provider sandbox support and limitations must remain explicit.

## Approval protocol

Use a shared bounded request shape: UUID id, kind (`project`, `command`, `file_change`, `permissions`), title (200 characters), details (8,000 characters). The connector attaches task and execution IDs from the current invocation. Persist pending requests against the exact active execution and connection. Only the installation owner with current session access may allow or deny. A duplicate identical request is idempotent; changed content or a conflicting decision is rejected. Persist decisions before delivering them, and use an explicit decision receipt to close the UI state.

The browser observes approvals through existing thread updates; it does not poll. Connector waits are abortable and bounded, outside the serialized event-RPC queue. Stop, revocation, connection loss, or provider exit cancels pending requests. A decision for an old execution cannot authorize a replacement. Reconnecting catches up current durable state; it never repeats a command whose outcome is unknown. Pending approvals are visible after browser reload. No new database or distributed locks.

## Runtime behavior

All three adapters support native file inspection/editing and command execution in coding mode, normalize tool activity into the existing timeline, retain session mappings, and expose resulting changes where available. No blanket bypass mode or unscoped session approval. Claude checks tools with hooks as well as permission callbacks because auto-approved tools can bypass callbacks. Kiro negotiates capability/permission options. Codex forwards supported command and file approval requests scoped to the active thread and turn. Unknown requests fail closed.

Coding turns have a bounded 30-minute runtime allowance with server delivery deadlines exceeding that allowance. Approval waits count toward the limit. Existing two-minute chat turns remain bounded. Output is bounded without aborting a legitimate coding run merely because it exceeds 30 tool calls. Cancellation stops the provider turn and tracked commands; interrupted work remains visible and is never silently retried.

## UI and ownership

Keep session product behavior in `features/agents`; use shared UI exports and existing signed-in realtime ownership. Show pending tool requests with project/command details, owner-only Allow once and Deny actions, and waiting state for other participants. Reuse the session conversation, tool timeline and Changes panel. Local paths and tool output may be visible to the session audience; do not promise local-only processing or retroactive deletion on revocation.

## Acceptance

Automated coverage must exercise all three adapters, command/file tool events, allow/deny/cancel, absent coding opt-in, stale approvals, unauthorized decisions, browser reload, stop, bounded output, and restart/resume. Run relevant contract, connector, API/integration, UI, type and build checks.

Live acceptance uses Codex through the actual Space UI and local connector. Ask it to make a useful README.md update, commit that README change, and push a dedicated `codex/` branch to `kai1303/space`. The user explicitly authorized this push. Preserve unrelated changes and do not push directly to the default branch. Verify the remote commit and show the session, retaining its ID/link and visual evidence. Do not substitute a manual assistant commit/push for this agent-driven test. Record separately which providers received synthetic tests and live authenticated tests.

## Implementation boundaries

This release enables coding on the locally selected project and owner approvals per session. A multi-folder picker, native desktop folder browser, arbitrary plugin parity and importing desktop provider histories are separate extensions. Existing source access remains the authority for session visibility; changing a private session to public is not automatic.

## Protocol references

- https://learn.chatgpt.com/docs/app-server#approvals
- https://code.claude.com/docs/en/agent-sdk/permissions
- https://kiro.dev/docs/cli/v3/acp-migration/
