# Temporal help request demo

Run from the repository root with dependencies installed. The automated test builds the package, starts an isolated Temporal development server, and uses a temporary SQLite mailbox. It uses a Temporal CLI on PATH when available, or the SDK downloads its development server.

```sh
pnpm --filter @space/workflows test
```

To try the workflow interactively, start a local Temporal server in one terminal and leave it running.

```sh
temporal server start-dev
```

Build and start the standalone worker in a second terminal.

```sh
pnpm --filter @space/workflows build
pnpm --filter @space/workflows start
```

In a third terminal, start a request. Copy the printed workflow ID into the claim command.

```sh
pnpm --filter @space/workflows demo start urgent alice "VPN is down"
pnpm --filter @space/workflows demo claim <workflow-id> sam
```

An urgent request posts to `#on-call`. Use `normal` to post to `#help`. Claiming the request posts “Claimed by sam” to Alice's demo mailbox and finishes the workflow. Open the [Temporal UI](http://localhost:8233) to inspect the run, or read the messages from the repository root.

```sh
sqlite3 apps/workflows/workflow-demo.sqlite 'SELECT destination, text FROM messages ORDER BY rowid'
```

The versioned fixture in `template.ts` is the supported template for this demo. Each run receives a snapshot. Both the channel post and the requester notification use the same registered Activity with different input bindings. Messages and claimant names are local test data. Use `TEMPORAL_ADDRESS` for a different local server address and `WORKFLOW_DEMO_DB` for a different mailbox path.

## Send the workflow to Space chat

Apply the Space database migrations and configure the Space API before starting it. Use an existing dedicated Space member for the sender and grant that member posting access to the two destination channels. Messages display the name from the workflow template and a **Workflow** badge.

| Space API environment variable | Value |
|---|---|
| `SPACE_WORKFLOW_TOKEN` | A random secret shared with the worker, at least 32 characters. Generate one with `openssl rand -hex 32`. |
| `SPACE_WORKFLOW_WORKSPACE_ID` | Workspace UUID |
| `SPACE_WORKFLOW_ACTOR_ID` | Dedicated sender's Space user UUID |
| `SPACE_WORKFLOW_HELP_CHANNEL_ID` | Channel UUID for normal requests |
| `SPACE_WORKFLOW_ON_CALL_CHANNEL_ID` | Channel UUID for urgent requests |

Run the standalone worker with `SPACE_WORKFLOW_API_URL` set to the Space API origin and `SPACE_WORKFLOW_TOKEN` set to the same secret. Use HTTPS when connecting across hosts. Set `TEMPORAL_ADDRESS` if Temporal runs elsewhere.

In the CLI terminal, set the same `SPACE_WORKFLOW_API_URL` to select the chat task queue. The CLI only needs access to Temporal. Use the requester's Space user UUID to address the confirmation DM.

```sh
pnpm --filter @space/workflows demo start urgent "$REQUESTER_USER_ID" "VPN is down"
pnpm --filter @space/workflows demo claim "$WORKFLOW_ID" sam
```

After the first command, open the configured on-call channel. After the claim, open the requester's DM with the dedicated sender. Both messages show **IT Help Request** with a **Workflow** badge. Previously started SQLite demos stay on the demo queue.
