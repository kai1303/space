# Space Connector

This local connector pairs Codex or Kiro on one computer with a Space workspace, reports provider readiness, and executes approved chat tasks. Pairing alone grants no channel access. Project file tools are an explicit local opt-in with `--project`.

Requirements: Node.js 24+, pnpm, and the selected provider CLI installed on `PATH`. Codex is the default; Kiro requires `kiro-cli` with ACP v3 support.

For Codex, from this repository:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@space/connector...
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

The adapter launches ACP v3, resolving the installed `kiro-cli-chat` companion when present so Kiro can run with its isolated HOME. It requires session loading and verifies that Kiro selected the generated `space-chat` profile before reporting readiness. Without `--project`, this profile disables tools, MCP, powers, resources and hooks. The client advertises no filesystem or terminal callbacks and rejects permission requests and unexpected tool events. Kiro’s own `fetch_cloud_config` status notifications are recognized as housekeeping, without authorizing model tools. Project access requires the local `--project` option described below. This is a tool restriction, not an OS filesystem jail. Session updates are bounded and coalesced while awaiting Space's acknowledgments. Stop waits for the outstanding setup request or prompt cancellation to settle before accepting another turn; uncertain transport failures require restarting the connector and do not replay inference.

Kiro uses its own authentication and model defaults. Model selection, native shell tools, provider-specific commands and interactive tool approval remain unsupported. See Kiro's [ACP v3 client guide](https://kiro.dev/docs/cli/v3/acp-migration/) and [agent profile reference](https://kiro.dev/docs/custom-agents/configuration-reference/).

## Project file tools and activity

Stop the current connector, then select the project folder explicitly on each launch:

```sh
pnpm connector --project /absolute/path/to/project
pnpm connector --provider kiro --project /absolute/path/to/project
```

The selected directory is resolved locally and is never accepted from a Space task. Both runtimes expose the maintained MCP filesystem server for reading text, listing/searching files, creating directories, and writing/editing files within that root. Native shell, unrelated integrations and approval escalation remain disabled. The file server checks path and symlink boundaries; this is a tool boundary, not a general OS sandbox. Reads and edits reach the selected project. Do not use a folder you have not authorized the agent to access.

A project changes the private session namespace. Start a new Space agent session after enabling tools or selecting a different project; an earlier chat-only session is not silently rebound to a folder. Returning to the same project and identity can resume its saved sessions. Codex ignores project-local runtime configuration; Kiro uses the generated allowlist profile. Kiro waits for the project MCP server to become connected before starting inference.

Space shows Working, Thinking, Responding or Using tools above the shared session composer, based on provider events. States can repeat. Reasoning contents are not forwarded. Tool inputs/results use the existing expandable timeline; older details are shortened to keep accumulated snapshots within the response budget. Completed, stopped and failed turns clear their activity. Unexpected or unconfirmed in-flight failures close the runtime before another tool turn can start.

## Enable a channel

Pairing and provider sign-in do not grant channel access. The current chat UI has
no channel-enablement control; the former **Ask an agent** control is not mounted.
Until a replacement ships, the installation owner must configure grants through
the authenticated HTTP API. Use the owner's normal Space user session, not the
connector credential. No model invocation is needed to configure a grant.

1. Read `GET /v1/workspaces` and `GET /v1/workspaces/:workspaceId/channels` to find
   the workspace and channel IDs.
2. Read `GET /v1/channels/:channelId/agents`. This returns the caller's owned
   installations, supported `skills` and current `granted_skills`. Use its `id`
   as `installationId` below; do not use the connector or provider name as an ID.
3. Send the following request with the same authenticated user session:

```http
POST /v1/agents/connections/:installationId/channels/:channelId
Content-Type: application/json

{"enabled":true,"skill":"codex.run"}
```

For Kiro, use `kiro.run`; other connectors must use a skill advertised by that
installation. Set `enabled` to `false` to revoke the same skill. The owner must
have access to the channel. Direct messages cannot enable agents, and archived
channels cannot receive new grants. Re-read the channel's agent list to confirm
the selected skill appears in `granted_skills`.

## Chat tasks

Enable the paired agent in the channel, then select its mention from the composer and send a request. Space creates a managed agent session linked below that message. Open the link to follow up in the session composer. The owner's requests autoapprove; other people's requests require the installation owner's approval. Ordinary thread discussion does not send agent follow-ups.

Responses stream into Space. Named agent sessions retain their own Codex conversation and working directory across turns and connector restarts; their conversation and outputs stay inside the session view. The private `~/.config/space-connector/codex/` directory stores session history and atomic `0600` mappings from Space session IDs to Codex thread IDs. Storage is isolated by platform, workspace, installation, pairing credential and authenticated ChatGPT account/client identity, with `0700` directories. Before any model turn, the connector saves the thread mapping, obtains Space’s session-readiness acknowledgment, and records readiness locally. A stop before that acknowledgment can safely reuse the same unused thread. Missing or damaged saved state fails the turn without creating a replacement conversation. Signing out removes OAuth tokens and retains this account-bound session data.

Legacy standalone tasks still start fresh ephemeral Codex threads and temporary working directories. Navigator tasks include up to 16 bounded messages from the originating thread; manually requested tasks send the entered goal. Default launches have tools disabled and use a connector-owned HOME/CODEX_HOME, separate from existing Codex desktop data. The installed runtime uses a read-only sandbox; this is not a separate OS filesystem read-root jail.

Stopping or ending a managed session interrupts its exact Codex turn and waits for acknowledgment and completion before accepting another task; other sessions keep working. A turn is limited to two minutes. Disconnects, revoked access, expired leases and uncertain acknowledgements stop a run without automatically generating the same response again. A connector reporting an error must be restarted before requesting another task. Existing task-owner approval is separate from unsupported mid-turn tool approvals, which the connector rejects.

If Space rejects the connector credential, create a fresh pairing code in Space and run with `--pair` again. Transient socket disconnects reconnect automatically with a delay capped at 30 seconds. ChatGPT sign-in requires user interaction; the connector never signs in autonomously.

The OAuth implementation follows OpenAI's [OSS sign-in flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [Codex app-server integration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server), and [session management](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

Validation: `pnpm --filter @space/connector test` uses generated signing keys, synthetic OAuth/ACP responses and child processes, a real loopback callback and Socket.IO server, and temporary filesystem state. Kiro tests cover CLI onboarding, streaming, restart/resume, account isolation, readiness acknowledgments, cancellation during setup and prompts, and rejected tool/malformed/oversized responses. They never sign in to a real account or perform inference. Live authenticated Kiro inference, restart/resume, streaming Stop, and post-Stop recovery were verified locally on 2026-11-04; see [the E2E report](../../docs/real-kiro-e2e-qa.md) for evidence and the remaining browser-only channel setup gap.

This implementation uses OpenAI's direct public-client flow for a local open-source connector. It does not use or require a client secret or partner API key. OpenAI's [OSS documentation](https://developers.openai.com/siwc/token-sharing-open-source) directs paid or remotely hosted apps to complete the [Sign in with ChatGPT interest form](https://openai.com/form/sign-in-with-chatgpt-interest/); this local flow does not establish approval for a hosted commercial service.
