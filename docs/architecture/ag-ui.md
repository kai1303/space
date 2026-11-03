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

This creates a new installation each time. Then start the updated worker and request `ag-ui.run` from **Ask an agent** in a thread. The agent owner approves the task through the existing approval flow. Without `AG_UI_URL`, no AG-UI connector is registered and the mock continues to work.

## Backend contract

The HTTP client posts standard AG-UI input with `threadId` equal to Space's agent session ID, `runId` equal to the execution ID, and the user's goal as the input message. `forwardedProps` includes `taskId` and `skill`. No channel history or local filesystem is sent. The backend may keep its own session history keyed by `threadId`.

The `Idempotency-Key` header is the execution ID. Retries must replay the same ordered stream, including stable timestamps when supplied. Space derives receipt IDs from the execution and event sequence. Changed replay envelopes are rejected; the adapter cannot make a backend's external effects idempotent. The current worker uses its existing 10-second invocation deadline and at most three attempts, with a 30-second delivery lease. Long-running agents need a separate lease-renewal change before raising this deadline.

Supported parent-run events:

| Events | Space behavior |
| --- | --- |
| `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR` | Execution lifecycle; run/thread IDs are checked |
| `TEXT_MESSAGE_START/CONTENT/END` | Accumulate assistant Markdown by message ID |
| `TOOL_CALL_START/ARGS/END/RESULT` | Display backend tool activity; END means arguments finished, RESULT means execution completed |
| `STEP_STARTED/FINISHED` | Live progress label |
| `CUSTOM` named `space.ui` | Upsert a registered card/table by component ID |

The official client expands text/tool chunk convenience events before mapping. Unknown custom events, raw events, reasoning, subagent output, shared-state payloads, and activity surfaces are not rendered. Space does not execute client-side tools. Pending tools at completion are marked interrupted. Interrupt/cancel outcomes fail visibly because resume and mid-run approvals are not implemented. Existing task-owner approval is distinct from those interactions. A truncated stream never counts as success.

## Structured components

Emit a standard CUSTOM event for each complete component. Reusing an ID replaces that component in place:

```json
{"type":"CUSTOM","name":"space.ui","value":{"id":"summary","type":"card","title":"Retention improved","body":"Pro retention reached 98%."}}
```

```json
{"type":"CUSTOM","name":"space.ui","value":{"id":"plans","type":"table","title":"Retention by plan","columns":["Plan","Retention"],"rows":[["Pro","98%"],["Starter","94%"]]}}
```

Cards accept only `id`, `type`, `title`, `body`. Tables accept only `id`, `type`, `title`, `columns`, `rows`; all cells are strings and each row must match the column count. No HTML, arbitrary component names, JavaScript, or action handlers are accepted. Markdown ignores HTML, permits HTTP/S/mailto links, and renders image alt text without loading remote images. Code fences use Space's existing CodeBlock; tools use ToolExecution.

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
