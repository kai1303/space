# Agent activity and project tool verification

Verified locally on 2026-11-04. No production deployment was tested.

## Behavior

Agent session activity appears above the existing shared composer. Runtime events distinguish working, thinking, responding and tool use; states may repeat. Only activity labels are forwarded from reasoning events. The existing expandable tool timeline renders inputs and text results. Completed, failed and stopped turns clear their activity while preserving valid partial responses.

Project file access requires local `--project` selection. The canonical folder participates in retained session identity. Native shell and unrelated tools remain disabled. Default launches retain chat-only behavior. The maintained MCP filesystem server supplies file tools and checks path boundaries; this is not an OS filesystem read-root jail. The connector now requires Node 24+, and CI uses Node 24.

## Automated checks

- 81 connector tests passed under Node 24.22.1, including actual filesystem-server reads/writes, outside-path and symlink escape denial, reasoning/text/tool mapping, delayed Kiro MCP startup, cancellation during setup, retained identity isolation, partial failure output and snapshot budgets.
- The tool-detail truncation boundary sweep fails against the earlier implementation and passes against the corrected implementation, including uneven JSON escaping and field-specific character limits.
- 56 contract tests, 23 shared UI/tool tests, 79 focused web tests and 27 PostgreSQL/session integration tests passed.
- Connector, UI and web typechecks passed. UI, web, API and PostgreSQL packages built successfully. Whitespace checks passed.

## Authenticated provider checks

Codex and Kiro each used the real project `read_text_file` MCP tool to read only the first three lines of README.md, then returned `PROJECT_TOOL_OK`. Both emitted a completed tool record. Kiro CLI 2.32.0 ACP v3 required waiting for the project MCP connection and recognizing its deferred tool-discovery and wrapped call formats; regression fixtures cover these observed messages. Live Kiro tests used an isolated temporary copy of its Space-owned authentication state, leaving the other running Kiro connector unchanged.

## Space platform check

The local API and Codex connector were restarted after confirming no queued/running Codex tasks. The local database was behind the source at migration 35; existing migrations 36–39 were inspected and applied. No new activity migration was required.

A real mention in #hi created a managed session. Codex read README.md through the project file tool and returned `SPACE_PROJECT_TOOL_OK`. Persisted task events include working, thinking and responding activity. A follow-up in the same session displayed queued activity above the composer and cleared it after returning `400`. After restarting the connector with the final adapter, another follow-up read only the first README line, rendered its plain text result in the tool timeline, and returned `TOOL_RESULT_RENDER_OK`. The completed session remains open in the browser.

## Limits

Provider smoke tests performed reads only. Writes were exercised against a disposable test folder with the real file server. Kiro's authenticated tool invocation was tested directly through its adapter, while the browser/platform check used Codex. Remote CI and a production deployment were not run. Concurrent notification work in the shared repository is outside these results.

## Whole-turn streaming follow-up

Additional tests on 2026-11-04 exercised alternating text/tool phases without changing production behavior:

- Both authenticated adapters emitted the observed provider order `BEFORE_READ → read_text_file → BETWEEN_READS → read_text_file → TURN_STREAM_OK`. Each read only the first line of README.md and package.json; both calls completed and all public text markers survived.
- Codex retained three text blocks in ten accumulated snapshots. Kiro retained one concatenated block in seven snapshots. These are single-run observations, not performance benchmarks.
- Neither live run's coalesced snapshots included `using_tools`: these file calls completed quickly enough that start and completion were combined. The final tool records remained correct. Deterministic slower fixtures confirmed `using_tools` during an active tool.
- The actual shared renderer, mounted in jsdom, kept the earlier text DOM node but inserted the tool timeline above it. Therefore the final view loses the provider's interleaved order even though the source events arrive correctly.
- A Kiro fixture confirmed that running `tool_call_update` content is exposed before tool completion. The current adapter replaces the stored result with each supplied update; it is not an append-only tool-output event log. Codex's current mapper handles MCP tool start/completion rather than intermediate MCP progress.
- 83 connector tests and all six agent-response renderer tests passed, including the new alternating-turn cases. Whitespace checks passed. Browser UI was not exercised again for this follow-up; the authenticated adapter runs and mounted renderer test are separate evidence.

Recommended next implementation: introduce one ordered collection of stable text/tool items per turn; retain lifecycle events even when text is batched; render those items in arrival order. Then add normalized incremental tool output, incremental browser updates with checkpoint-based display recovery, and paging for long outputs. Preserve existing authorization, cancellation, bounded delivery, and the rule against automatically replaying uncertain agent actions.

## Ordered timeline implementation

The chronological presentation gap above is now fixed using optional stable `items` references alongside the existing message/tool payloads. Legacy saved responses remain readable. Kiro splits text at new tool calls; Codex retains its native message identities. Only adjacent tools share an expandable timeline, preserving the earlier text nodes and open tools as later output arrives. No database migration or execution permission change was needed.

- Fresh checks passed: 84 connector tests, 57 contract tests, 25 shared UI/tool tests, 76 focused web tests and 28 storage/session tests. The latter verify ordered replay, duplicate receipts, terminal failure and Stop preserving references while clearing activity and interrupting active tools. UI/web builds and the contracts typecheck passed. A read-only code review found no actionable issues.
- Authenticated Codex and Kiro runs each produced three separate text blocks and two completed project reads in `message → tool → message → tool → message` order, matching the observed provider sequence. Terminal snapshots had no activity. Codex emitted ten snapshots and Kiro seven in these individual runs; these counts are observations, not performance benchmarks.
- The local API and project-bound Codex connector were restarted after checking they had no queued/running tasks. A browser follow-up rendered `BEFORE_READ → read_text_file → BETWEEN_READS → read_text_file → TURN_STREAM_OK`. The saved session was reopened after a page reload to verify display recovery.

Lifecycle-event retention, normalized incremental tool output, delta transport and long-output paging remain follow-ups. Fast transitions may still be coalesced. Live provider checks remained read-only; the Kiro check used its adapter rather than the browser platform path. Concurrent notification work is excluded from these results.
