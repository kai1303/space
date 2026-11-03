# Space Connector

This local connector pairs one computer with a Space workspace, reports ChatGPT authorization and Codex readiness, and executes approved chat tasks. Pairing alone grants no channel access. Repository access and file changes are not part of this chat integration.

Requirements: Node.js 22+, pnpm, and the Codex CLI installed on `PATH`.

From this repository:

```sh
pnpm install
pnpm --filter @space/connector build
pnpm --filter @space/connector start --url http://localhost:3000 --pair YOUR_32_CHARACTER_PAIRING_CODE
```

Use the origin and pairing code shown by your Space setup screen. HTTP is allowed only on loopback; other servers require HTTPS. Use `--connect` instead of `--pair` to enter the code at an interactive prompt, including when a platform connection is already saved. After pairing, open the printed **Continue with ChatGPT** URL and authorize in your own browser. Keep the connector terminal running.

On subsequent launches:

```sh
pnpm --filter @space/connector start
pnpm --filter @space/connector start --login
pnpm --filter @space/connector start --logout
```

Stop a running connector with Ctrl+C before reauthorizing or signing out. `--login` reuses the existing account registration. `--logout` attempts renewable-session revocation, then removes local ChatGPT tokens; the stable host ID and account/client mapping remain for later sign-in. It leaves the platform pairing intact.

The connector stores its host ID, platform credential, account/client mapping and OAuth tokens only in `~/.config/space-connector/state.json`, written atomically with `0600` permissions inside a `0700` directory. Only one connector process can use that storage at a time, so rotating refresh tokens have one writer. After an unclean shutdown, a stale lock is reported with its path; confirm every connector process is stopped before removing that lock and restarting. Do not share or commit this directory. Existing Codex auth caches are never read or uploaded.

Space receives its connector credential, readiness status, and responses to approved tasks. `ready` requires successful local OAuth and an actual Codex `initialize`/`initialized` exchange. It does not prove model entitlement or inference success; no model turn runs during onboarding. Token renewal restarts app-server with its new access token in the child environment. A stopped app-server or failed refresh changes status to `error`.

## Chat tasks

In a channel, open a message thread and expand **Ask an agent**. The agent owner can choose **Enable in this channel**, select the paired Codex and `codex.run`, enter a goal, and request a task. The owner approves the task before the connector can claim it. After enabling, the composer also offers the agent's mention tag; existing Navigator ownership rules apply to direct mentions and thread follow-ups.

Responses stream into Space and the final reply is saved in the originating thread. Navigator tasks include up to 16 bounded messages from that thread; manually requested tasks send the entered goal. Each request starts an ephemeral Codex turn with tools disabled, an isolated temporary working directory and isolated HOME/CODEX_HOME. The installed runtime uses a read-only sandbox; this is not a separate OS filesystem read-root jail.

A turn is limited to two minutes. Disconnects, revoked access, expired leases and uncertain acknowledgements stop a run without automatically generating the same response again. A connector reporting an error must be restarted before requesting another task. Existing task-owner approval is separate from unsupported mid-turn tool approvals, which the connector rejects.

If Space rejects the connector credential, create a fresh pairing code in Space and run with `--pair` again. Transient socket disconnects reconnect automatically with a delay capped at 30 seconds. ChatGPT sign-in requires user interaction; the connector never signs in autonomously.

The OAuth implementation follows OpenAI's [OSS sign-in flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [Codex app-server integration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server), and [session management](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

Validation: `pnpm --filter @space/connector test` uses generated signing keys, synthetic OAuth responses and child processes, a real loopback callback and Socket.IO server, and temporary filesystem state. It never signs in to a real account or performs inference.

This implementation uses OpenAI's direct public-client flow for a local open-source connector. It does not use or require a client secret or partner API key. OpenAI's [OSS documentation](https://developers.openai.com/siwc/token-sharing-open-source) directs paid or remotely hosted apps to complete the [Sign in with ChatGPT interest form](https://openai.com/form/sign-in-with-chatgpt-interest/); this local flow does not establish approval for a hosted commercial service.
