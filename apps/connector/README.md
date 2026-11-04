# Space Connector

This local connector pairs Codex or Kiro on one computer with a Space workspace, reports provider readiness, and executes approved chat tasks. Pairing alone grants no channel access. Repository access and file changes are not part of this chat integration.

Requirements: Node.js 22+, pnpm, and the selected provider CLI installed on `PATH`. Codex is the default; Kiro requires `kiro-cli` with ACP v3 support.

For Codex, from this repository:

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

## Kiro

In **Members**, select **Kiro**, then **Connect Local Kiro**. Run the command shown by Space, for example:

```sh
pnpm connector --provider kiro --url http://localhost:3000 --connect
```

Enter the pairing code, then complete the local Kiro sign-in opened by the connector. Space receives no Kiro credentials. This sign-in uses a separate Kiro home; it does not import or sign out your regular CLI/IDE account. Choose the account type in Kiro's own login flow. The provider selected in Space must match the command.

```sh
pnpm connector --provider kiro          # reconnect
pnpm connector --provider kiro --login  # sign in again
pnpm connector --provider kiro --logout # sign out of Space's Kiro home
```

Codex and Kiro can run concurrently in separate terminals. Codex keeps `~/.config/space-connector`; Kiro uses `~/.config/space-connector-kiro`. Each root permits one local connector process. Kiro's isolated `kiro-home` holds CLI-owned credentials and history. Private, atomic session mappings under `kiro/` are scoped to the platform, workspace, installation, pairing credential and Kiro account. Missing history or a changed account fails the turn instead of silently starting over. Keep `--provider kiro` on subsequent launches.

The adapter launches ACP v3, resolving the installed `kiro-cli-chat` companion when present so Kiro can run with its isolated HOME. It requires session loading and verifies that Kiro selected the generated `space-chat` profile before reporting readiness. This profile disables tools, MCP, powers, resources and hooks. The client advertises no filesystem or terminal callbacks and rejects permission requests and unexpected tool events. Kiro’s own `fetch_cloud_config` status notifications are recognized as housekeeping, without authorizing model tools. No repository access is enabled. This is a tool restriction, not an OS filesystem jail. Session updates are bounded and coalesced while awaiting Space's acknowledgments. Stop waits for the outstanding setup request or prompt cancellation to settle before accepting another turn; uncertain transport failures require restarting the connector and do not replay inference.

Kiro uses its own authentication and model defaults. Models, coding tools, provider-specific commands and interactive tool approval are outside this first integration. See Kiro's [ACP v3 client guide](https://kiro.dev/docs/cli/v3/acp-migration/) and [agent profile reference](https://kiro.dev/docs/custom-agents/configuration-reference/).

## Chat tasks

In a channel, open a message thread and expand **Ask an agent**. The agent owner can choose **Enable in this channel**, select the paired Codex and `codex.run`, enter a goal, and request a task. The owner approves the task before the connector can claim it. After enabling, the composer also offers the agent's mention tag; existing Navigator ownership rules apply to direct mentions and thread follow-ups.

Responses stream into Space. Named agent sessions retain their own Codex conversation and working directory across turns and connector restarts; their conversation and outputs stay inside the session view. The private `~/.config/space-connector/codex/` directory stores session history and atomic `0600` mappings from Space session IDs to Codex thread IDs. Storage is isolated by platform, workspace, installation, pairing credential and authenticated ChatGPT account/client identity, with `0700` directories. Before any model turn, the connector saves the thread mapping, obtains Space’s session-readiness acknowledgment, and records readiness locally. A stop before that acknowledgment can safely reuse the same unused thread. Missing or damaged saved state fails the turn without creating a replacement conversation. Signing out removes OAuth tokens and retains this account-bound session data.

Legacy standalone tasks still start fresh ephemeral Codex threads and temporary working directories. Navigator tasks include up to 16 bounded messages from the originating thread; manually requested tasks send the entered goal. All turns have tools disabled and use a connector-owned HOME/CODEX_HOME, separate from existing Codex desktop data. The installed runtime uses a read-only sandbox; this is not a separate OS filesystem read-root jail.

Stopping or ending a managed session interrupts its exact Codex turn and waits for acknowledgment and completion before accepting another task; other sessions keep working. A turn is limited to two minutes. Disconnects, revoked access, expired leases and uncertain acknowledgements stop a run without automatically generating the same response again. A connector reporting an error must be restarted before requesting another task. Existing task-owner approval is separate from unsupported mid-turn tool approvals, which the connector rejects.

If Space rejects the connector credential, create a fresh pairing code in Space and run with `--pair` again. Transient socket disconnects reconnect automatically with a delay capped at 30 seconds. ChatGPT sign-in requires user interaction; the connector never signs in autonomously.

The OAuth implementation follows OpenAI's [OSS sign-in flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [Codex app-server integration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server), and [session management](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

Validation: `pnpm --filter @space/connector test` uses generated signing keys, synthetic OAuth/ACP responses and child processes, a real loopback callback and Socket.IO server, and temporary filesystem state. Kiro tests cover CLI onboarding, streaming, restart/resume, account isolation, readiness acknowledgments, cancellation during setup and prompts, and rejected tool/malformed/oversized responses. They never sign in to a real account or perform inference. Live authenticated Kiro inference, restart/resume, streaming Stop, and post-Stop recovery were verified locally on 2026-11-04; see [the E2E report](../../docs/real-kiro-e2e-qa.md) for evidence and the remaining browser-only channel setup gap.

This implementation uses OpenAI's direct public-client flow for a local open-source connector. It does not use or require a client secret or partner API key. OpenAI's [OSS documentation](https://developers.openai.com/siwc/token-sharing-open-source) directs paid or remotely hosted apps to complete the [Sign in with ChatGPT interest form](https://openai.com/form/sign-in-with-chatgpt-interest/); this local flow does not establish approval for a hosted commercial service.
