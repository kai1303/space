# AG-UI responses

Space can run an operator-configured [AG-UI HTTP agent](https://docs.ag-ui.com/sdk/js/client/http-agent) through its existing task approval and delivery pipeline. The connector uses `@ag-ui/client` and `@ag-ui/core` 1.0.3. ACP is not part of this integration. Local Codex pairing still reports readiness; this adapter does not execute through the local connector.

## Configure a backend

1. Apply migrations, including `021_agent_responses.sql`, before starting the updated server and worker. Run the repository's normal `pnpm migrate` workflow with the intended `DATABASE_URL`.
2. Set `AG_UI_URL` on the worker to a trusted HTTP/S AG-UI endpoint. Set optional `AG_UI_TOKEN` for bearer authentication. These are server configuration, never browser input. Use HTTPS outside trusted local networks. Compose forwards both variables; a loopback URL inside a container points to that container, not your host.
3. Install an agent definition with skill `ag-ui.run`, connector ID `ag-ui`, and a grant for the intended channel using the existing `FoundationStore` operator API. The owner must have access to that workspace and channel. For example, after building the packages, run this from the repository root with the three IDs exported in the environment:

```sh
pnpm --filter @space/tools exec node --env-file=../.env --input-type=module <<'JS'
import { createPool } from '@space/postgres/database';
import { FoundationStore } from '@space/postgres/foundation';
import { uuid } from '@space/contracts';
const owner = uuid(process.env.SPACE_OWNER_ID);
const workspace_id = uuid(process.env.SPACE_WORKSPACE_ID);
const channel_id = uuid(process.env.SPACE_CHANNEL_ID);
const pool = createPool(process.env.DATABASE_URL);
try {
  const store = new FoundationStore(pool);
  const definition = await store.publishDefinition({
    name: 'AG-UI agent',
    capabilities: { skills: ['ag-ui.run'], controls: { progress_stream: true } },
  });
  const installation = await store.install(owner, {
    workspace_id, definition_id: definition.id, connector_id: 'ag-ui',
  });
  await store.grant(owner, installation.id, { channel_id, skill: 'ag-ui.run' });
  console.log({ installation_id: installation.id });
} finally { await pool.end(); }
JS
```

This creates a new installation each time. Start the updated worker and invoke the granted agent from its source conversation. The agent owner approves the task through the existing approval flow. Without `AG_UI_URL`, no AG-UI connector is registered and the mock continues to work.

## Backend contract

The HTTP client posts standard AG-UI input with `threadId` equal to Space's agent session ID, `runId` equal to the execution ID, and the user's goal as the input message. `forwardedProps` includes `taskId` and `skill`. The backend also receives the context and attachments supplied for the authorized turn. The backend may keep its own session history keyed by `threadId`.

The `Idempotency-Key` header is the execution ID. Retries must replay the same ordered stream, including stable timestamps when supplied. Space derives receipt IDs from the execution and event sequence. Changed replay envelopes are rejected; the adapter cannot make a backend's external effects idempotent. The worker has a 10-second invocation deadline and an attempt token with a 30-second execution deadline. Failures known to occur before invocation may retry; an interrupted external invocation fails uncertain and is never automatically invoked again. A targeted durable deadline settles a crashed attempt. Long-running agents need an explicit deadline-renewal design before raising this limit.

Supported parent-run events:

| Events | Space behavior |
| --- | --- |
| `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR` | Execution lifecycle; run/thread IDs are checked |
| `TEXT_MESSAGE_START/CONTENT/END` | Accumulate assistant Markdown by message ID |
| `TOOL_CALL_START/ARGS/END/RESULT` | Display backend tool activity; END means arguments finished, RESULT means execution completed |
| `STEP_STARTED/FINISHED` | Live progress label |
| `CUSTOM` named `space.ui` | Upsert a card, table, data table, alert, carousel, or document edit by component ID |

The official client expands text/tool chunk convenience events before mapping. Unknown custom events, raw events, reasoning, subagent output, shared-state payloads, and activity surfaces are not rendered. Space does not execute client-side tools. Pending tools at completion are marked interrupted. Interrupt/cancel outcomes fail visibly because resume and mid-run approvals are not implemented. Existing task-owner approval is distinct from those interactions. A truncated stream never counts as success.

## Structured components

Emit a standard CUSTOM event for each complete component. Reusing an ID replaces that component in place:

```json
{"type":"CUSTOM","name":"space.ui","value":{"id":"summary","type":"card","title":"Retention improved","body":"Pro retention reached 98%."}}
```

```json
{"type":"CUSTOM","name":"space.ui","value":{"id":"plans","type":"table","title":"Retention by plan","columns":["Plan","Retention"],"rows":[["Pro","98%"],["Starter","94%"]]}}
```

Use `data_table` for results readers can explore in a message. Supply 1–10 column labels and up to 100 rows, each with one value per column. Cells accept plain text (up to 1,000 characters) or finite JSON numbers. An empty row list is valid. Space sorts a column numerically if all its values are numbers and alphabetically otherwise. The filter matches text across all cells, ignoring case. Sorting and filtering are local to each reader. To update results, send the complete table with the same ID. A row update preserves the current view, and a change to the column labels or order resets it.

```json
{"type":"CUSTOM","name":"space.ui","value":{"id":"plans","type":"data_table","title":"Customers by plan","columns":["Plan","Customers"],"rows":[["Pro",180],["Starter",60]]}}
```

A carousel groups one to ten options under a title. Each card has a unique ID within the carousel, a plain-text title, and a plain-text body. Keep card IDs stable when updating the group.

```json
{"type":"CUSTOM","name":"space.ui","value":{"type":"carousel","id":"rollout","title":"Rollout options","cards":[{"id":"pilot","title":"Pilot","body":"Start with one team."},{"id":"phased","title":"Phased rollout","body":"Add one team each week."}]}}
```

Text-only agents can write the same group as a quoted list.

```markdown
> [!CAROUSEL] Rollout options
>
> - **Pilot** Start with one team.
> - **Phased rollout** Add one team each week.
```

An alert appears in the reply where its event first arrives. Emit the same ID to update it in place. Use `warning` for a condition to review and `error` for a problem that occurred. The title allows up to 200 characters and the optional Markdown body allows up to 8,000.

```json
{"type":"CUSTOM","name":"space.ui","value":{"id":"dependency","type":"alert","level":"warning","title":"Dependency conflict","body":"Review the version of `lodash` before deploying."}}
```

Text-only agents can put a Markdown callout directly between paragraphs. Start the quote with `> [!WARNING]` or `> [!ERROR]` on its own line, then quote the explanation on the following lines.

A document edit carries the two passages as plain text. The active Office editor supplies the review actions. Other agent messages display the comparison read-only.

```json
{"type":"CUSTOM","name":"space.ui","value":{"id":"edit","type":"document_edit","title":"Runbook.docx","original":"Restart all services.","replacement":"Restart the worker."}}
```

Each passage is limited to 16,000 characters, subject to the event and response limits below.

Cards accept only `id`, `type`, `title`, `body`. Static `table` blocks accept only `id`, `type`, `title`, `columns`, `rows`; all cells are strings and each row must match the column count. No HTML, arbitrary component names, JavaScript, or action handlers are accepted. Markdown ignores HTML, permits HTTP/S/mailto links, and renders image alt text without loading remote images. Code fences use Space's existing CodeBlock; tools use ToolExecution.

Limits: 32,000 serialized characters per supported event, 16,000 combined assistant text characters, 30 messages, 30 tools, 20 components, and 64,000 serialized response characters. Tool arguments are limited to 8,000 characters, tool results to 16,000, cards to 8,000 body characters, tables to 10 columns and 100 rows. IDs are limited to 128 characters. Payload validation failures abort the stream; they cannot be swallowed into a successful run.

## Persistence and rendering

The adapter attaches a validated accumulated `response` to ordinary Space execution events. Each snapshot is self-contained, so the existing latest-task history and reconnect cursors remain useful. Structured progress does not create a new conversational message for every chunk. Completion saves `messages.agent_response` transactionally with the final message and receipt. The message payload function exposes it consistently in channel/thread pagination, source-message views, and immutable replay. The completed message replaces its live response activity in the visible timeline. Terminal worker failures retain the last partial response and mark unfinished tools interrupted.

The local gallery at `/#agent-response` includes completed and streaming examples. It is sample data, not evidence of a live backend run.

## Verification

Run the normal package builds first, then:

```sh
pnpm --filter @space/tests exec tsx --test contracts/ag-ui.test.ts integration/ag-ui.test.ts integration/ag-ui-store.test.ts integration/task-flow.test.ts
pnpm --filter @space/ui --filter @space/web test
pnpm typecheck
```

Database tests require `TEST_DATABASE_URL` and create isolated schemas. HTTP tests use a real loopback SSE server and do not call a production agent or perform model inference.


## Code sessions

For a backend that can retain its conversation by AG-UI `threadId`, set `capabilities.persistent_sessions` to `true` on its definition. The grant and owner approval still apply. An approved backend run can use these AG-UI `CUSTOM` events:

| Name | Value and effect |
| --- | --- |
| `space.session.open` | Send `{}` to turn the current run into a named, shared Space session linked to its source thread. Already-managed sessions keep their identity. |
| `space.session.outputs` | Send a Space outputs object containing `files`, `changes`, an optional `preview`, and optional HTTPS `actions`. Space validates and persists managed-session outputs. For example, an agent can supply a unified patch and an action linking to a review on its Git host. |
| `space.session.setView` | Publish one named review tab or replace its content under the same stable key. |
| `space.session.removeView` | Send `{"key":"reports/coverage"}` to remove that tab. Repeating a removal is safe. |
| `space.session.archive` | Send `{}` before a successful `RUN_FINISHED` to end the session. Pending human follow-ups keep it open. Failed or interrupted executions do not archive. |

These operations address the current authorized execution. The server derives the session and installation from the delivery. A backend cannot select a different channel or session in an event. The existing execution deadline applies.

A managed session supports up to eight named tabs alongside its single Changes view. Set an HTML report with the following event.

```json
{"type":"CUSTOM","name":"space.session.setView","value":{"key":"reports/coverage","type":"html","name":"Coverage","content":"<h1>93% coverage</h1>"}}
```

Use `canvas` with Markdown in `content` for a document, or `blocks` with an array of validated Space components in `blocks`. Tab keys accept letters, digits, periods, hyphens, underscores and slashes and must begin with a letter or digit. Replacing a tab keeps its position. The session API returns the latest tabs with their keys and contents. A manager can share a specific tab snapshot in Team. Subsequent provider updates stay in the agent session until the manager explicitly updates the shared version.

A provider can also supply a complete ordered `views` list or repository context in `space.session.outputs`. An omitted field preserves the previous value. An empty list clears the published tabs and an empty context clears the context bar. Repository and pull request links require HTTPS. Base and head branch names label the diff when supplied.

```json
{"type":"CUSTOM","name":"space.session.outputs","value":{"files":[],"changes":[],"context":{"repository":{"label":"acme/web","url":"https://github.com/acme/web"},"base_branch":"main","head_branch":"fix/login","pull_request":{"label":"PR #123","url":"https://github.com/acme/web/pull/123"}}}}
```
