# Connect a cloud agent

Open **Agents & tools → Connect an agent**. The dialog uses the shared design-system Select for connection type and provider. Local runners use Codex/Kiro setup; cloud runners use trusted custom connector descriptors. Selecting a connection type never creates a pairing. Existing connections are listed separately from setup, and human membership stays in Manage members.

## Register a cloud runner

The API entrypoint accepts `SPACE_CLOUD_CONNECTORS`, a JSON array of descriptors appended to the built-in local providers. Compose forwards it to the API. Configure it consistently on every API replica, then restart the API processes:

```sh
SPACE_CLOUD_CONNECTORS='[{"id":"research.cloud","definition_id":"9a13aa4d-d380-4284-a6c8-03bf0c1c6634","name":"Research","capabilities":{"skills":["research.run"],"controls":{"progress_stream":true},"persistent_sessions":true}}]'
```

Generate a definition UUID for your connector. Definition IDs are immutable: changing the name or capabilities requires a new ID. Advertise only capabilities the runner implements. Configuration is bounded to 64 KiB and 100 total connectors, including built-ins. Duplicate connector/definition IDs, malformed capabilities, empty skill lists, local-provider overrides and unknown fields fail startup. Descriptors contain no credentials or endpoint URLs.

This registers a connector, not a hosted runtime. Your cloud process must implement Space’s existing authenticated Socket.IO `/agents` task/event protocol, including offered delivery IDs, event acknowledgements, execution deadlines, attempt fencing and reconnect handling. See [the connector protocol and authorization boundaries](local-codex-connection.md#interfaces). A generic HTTP API cannot consume these pairings without a compatible runner.

1. Open Space at the deployed HTTPS address reachable from the runner.
2. Choose **Cloud runner**, select the registered provider, and connect.
3. Enter the Space URL and short-lived pairing code in your runner. The runner generates and retains its credential, then claims the pairing through `POST /v1/agent-pairings/claim`.
4. Keep the runner connected outbound to Space. Model credentials remain in the cloud environment. Pairing status updates through the existing realtime subscription; the UI does not poll.
5. The connected runner inherits its owner’s current conversation access. No per-channel skill grant is needed; see [conversation permissions](../../apps/connector/README.md#conversation-permissions). Channel memory requires its own permission.

Opening localhost in the browser does not make Space reachable from a cloud host. The cloud pairing step explains this boundary. Creating a code grants no channel or memory access. Closing or cancelling setup cancels an unused code; claimed pairings hide the consumed code. Connection revocation remains owner-only and server-authorized.

## Hosted endpoints

**Hosted endpoint** explains the existing operator-managed AG-UI integration. Configure `AG_UI_URL` and optionally `AG_UI_TOKEN` on the worker, install the definition and grant its channel access as described in [AG-UI setup](ag-ui.md). This path does not use a pairing code or accept credentials through the browser.

The existing worker deadline and lack of asynchronous job/resume support still apply. This setup change does not extend execution deadlines, add cloud hosting, or prove production cloud-provider behavior. The paired runner protocol and AG-UI transport retain their existing limits.

## Verification

`WorkspaceMembers.test.tsx` covers local/cloud selection, provider preselection, remote instructions, missing cloud configuration, hosted endpoint guidance, pairing failure/expiry/cancellation, workspace isolation and realtime completion. `WorkspaceDestinations.test.tsx` checks direct setup navigation and selected connector forwarding. `apps/server/agent-connectors.test.mjs` checks descriptor configuration and rejection boundaries. These fixtures do not invoke a live cloud model.
