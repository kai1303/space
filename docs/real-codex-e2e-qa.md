# Real Codex E2E verification

Tested on 2026-11-03 against the local Space API, PostgreSQL, Redis and web app.
The user completed real OpenAI authorization. No mock OAuth responses or fake
Codex process were used for this run.

| Check | Observed result |
| --- | --- |
| Pair production connector with QA workspace | Passed; owned agent installation created |
| Real ChatGPT registration and authorization | Passed; validated credentials stored locally |
| Installed Codex App Server | Version 0.146.0 initialized successfully |
| Space directory and browser UI | Real Codex E2E appeared as Online, auth status ready |
| Real model turn | `gpt-5.6-sol`, returned by the runtime as its default model; turn completed |
| Exact output | `SPACE_CODEX_E2E_OK` |
| Tool use | Zero tool items |
| Stop connector | Space changed the installation to Offline |
| Restart with `pnpm connector` | Saved authorization refreshed, Codex initialized and Space returned to Online without another browser sign-in |
| Inference after restart and refresh | A second real turn completed with the same exact output and zero tool items |

The two model checks started at 09:12:53 UTC and 09:14:40 UTC. Both exited
successfully with `status: completed`, `exact_response: true`, `tool_items: 0`
and no Codex error.

The inference check called the production `startCodex` runtime with the connector's
locally stored OAuth access token. A small test client then used `model/list`,
`thread/start` and `turn/start`, and checked `turn/completed` plus the exact output.
The test thread was ephemeral, used an empty temporary directory and a read-only
sandbox, and instructed the model not to use tools. It sent no repository content.
Tokens, account details and authorization codes are excluded from this report.

This verifies the real account-to-runtime path and Space enrollment/readiness.
It does not demonstrate a chat message being routed from Space to Codex: task
dispatch and results delivery are not implemented yet. Revocation and stale-socket
fencing were previously verified by integration tests; this real-account run
preserved the pairing and left the connector running.

## Space chat dispatch and follow-up, 2026-11-03

The paired production connector was enabled for `hi` in the browser's current
`kai-test` workspace through the new explicit channel grant control. The browser
posted a supported agent mention asking for the exact response `SPACE_AGENT_OK`.
Local Codex returned that response in Space. A follow-up in the same thread asked
what exact token it had just replied with, without including the token in the
follow-up request; Codex returned `SPACE_AGENT_OK` again.

Both tasks were observed as `completed`, with matching saved responses and `done`
outbox deliveries. The browser showed both real agent replies after a frontend
reload, confirming persistence and contextual continuation. The connector, API,
and worker remained running. This covers tool-free chat execution; repository
access, file modification, midrun approvals and production reliability remain
outside this verification.

Relevant automated checks passed: 51 server/integration tests, 36 connector tests,
39 chat UI tests, workspace typecheck, backend package builds and frontend build.
The connector regression suite includes delayed-ready acknowledgment, stale
connection fencing, terminal/renewal ordering, unacknowledged events and lease loss.
