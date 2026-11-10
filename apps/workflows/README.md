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
