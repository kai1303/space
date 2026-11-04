# Codex and Kiro local providers

Approved scope: add Kiro alongside Codex with the existing chat-only behavior. Members choose a provider when pairing. Pairing fixes the provider; connectors cannot reinterpret it. Existing pairings and saved Codex connections default to Codex. Both providers share channel grants, owner approval, mentions, managed sessions, durable push delivery, cancellation and response rendering.

Use explicit provider metadata (codex.local/codex.run and kiro.local/kiro.run), with separate CLI runtime adapters. Keep the Codex protocol unchanged. Kiro uses ACP v3 over bounded newline JSON-RPC, an isolated local HOME, and a Space-owned profile without tools, resources, MCP or hooks. Require session loading and the selected chat-only mode; reject unsupported requests. Kiro owns local authentication; Space never receives provider credentials. Provider-specific connector roots allow both processes concurrently. Retained Kiro session mappings are scoped by pairing and authenticated identity and committed before inference. Missing mappings fail visibly, without replacing conversations or replaying uncertain inference.

No new polling, database locks or distributed locks. Generalize broker routing and worker exclusion to both local providers. Replace enrollment's existing explicit database locks with the existing bounded serializable transaction helper, preserving concurrent claim idempotency.

Verify contracts, concurrent enrollment, grants, local delivery, session routing, UI provider instructions, bounded ACP streaming, session resume, cancellation, denied tools and malformed responses. Synthetic protocol tests establish adapter behavior; live authenticated inference is a separate validation boundary.
