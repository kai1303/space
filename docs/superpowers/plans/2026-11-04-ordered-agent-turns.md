# Ordered agent turn timeline

Approved follow-up: preserve text → tool → text → tool → final-answer order for Codex and Kiro, reusing the existing session conversation, composer, Markdown and expandable tool timeline.

Keep `messages` and `tools` as the response payloads and add optional ordered `items` references with stable IDs. Validate each referenced message/tool exists exactly once and enforce the current bounded response limits. Responses without order metadata retain their existing rendering. Store snapshots and replay through the existing durable JSON response path; no migration, polling or new execution permissions.

- [x] Add failing contract, connector, renderer and persistence checks for interleaved order and stable updates.
- [x] Record first appearance of message/tool IDs in each connector; split Kiro text blocks at new tool calls and retain Codex message IDs.
- [x] Render ordered references with stable keys and existing tool components; preserve expanded tool state during later text updates.
- [x] Verify terminal failures/Stop and snapshot budgets preserve valid references. Keep existing activity and backpressure behavior.
- [x] Run focused tests/builds, review, and authenticated read-only provider checks; verify ordered session UI and replay.

This change covers chronological presentation. Per-event lifecycle persistence, new delta transport, expanded tool permissions and configurable long-turn limits remain separate follow-ups.
