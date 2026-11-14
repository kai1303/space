# Space Connector

This local connector pairs Codex, Kiro or Claude on one computer with a Space workspace, reports provider readiness, and executes approved chat tasks. A paired agent inherits its owner’s current conversation access; no separate channel grant is required. Project file tools are an explicit local opt-in with `--project`.

On macOS, [Space Desktop](../desktop/README.md) bundles the runner and can pair directly from the workspace. Install the selected provider CLI on the Mac.

For the standalone repository command, requirements are Node.js 24+, pnpm, and the selected provider CLI installed on `PATH`. Claude uses the installed `claude` executable. Codex is the default; Kiro requires `kiro-cli` with ACP v3 support.

### Adding a local provider

1. Add the provider ID, display name, CLI command, connector ID, run skill and stable definition UUID to [the provider catalog](../../packages/contracts/local-providers.json). Desktop, the pairing API and the session composer use this catalog.
2. Register its factory in [provider-factory.ts](provider-factory.ts). CLI-authenticated providers can reuse `nativeProvider`. Implement the provider’s authentication and return an [AgentRuntime](agent-runtime.ts) for message execution. Report models and supported effort levels from the provider when available.
3. Test pairing, reconnecting and a turn using the provider’s own settings. Features that grant additional access, such as project tools or outbound MCP, need explicit provider support.

For Codex, from this repository:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@space/connector...
pnpm --filter @space/connector start --url http://localhost:3000 --pair YOUR_32_CHARACTER_PAIRING_CODE
```

Use the origin and pairing code shown by your Space setup screen. HTTP is allowed only on loopback; other servers require HTTPS. Use `--connect` instead of `--pair` to enter the code at an interactive prompt, including when a platform connection is already saved. After pairing, open the printed **Continue with ChatGPT** URL and authorize in your own browser. Keep the connector terminal running.

The connector terminal logs connection changes with a UTC timestamp, provider, and Space origin. If a thread cannot reach its agent, check that the origin matches the thread and look for `Space confirmed provider status: ready.` After a disconnect, that line shows when Space has acknowledged readiness again.

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

Space lists the models reported by the signed-in Kiro CLI. When a model is selected, Space checks Kiro’s active session configuration before sending the prompt. The current Kiro ACP catalog has no reasoning-effort setting. Native shell tools and interactive approval require coding mode below. See Kiro's [ACP v3 client guide](https://kiro.dev/docs/cli/v3/acp-migration/) and [agent profile reference](https://kiro.dev/docs/custom-agents/configuration-reference/).

## Claude

In **Members**, choose **Local runner → Claude → Connect Local Claude**. Install Claude Code on your `PATH`, then run the command shown in Space and enter its pairing code.

```sh
pnpm connector --provider claude --url http://localhost:3000 --connect
pnpm connector --provider claude          # reconnect
pnpm connector --provider claude --login  # sign in again
pnpm connector --provider claude --logout # sign out of Space's Claude profile
```

On first pairing the connector launches `claude auth login`. Complete Claude's own sign-in in your browser and terminal. The connector checks `claude auth status` and starts your installed, unmodified Claude Code executable. Your Claude subscription account can be used through this native sign-in flow. The connector uses the SDK as a local protocol client for streaming and session control.

Claude owns authentication in the private `~/.config/space-connector-claude/claude-home/` profile. Space's server receives pairing credentials and task events. Login tokens remain under the native CLI's control. Sign-out applies to this Space profile. Each provider can run in a separate terminal.

By default Claude receives supplied conversation context and its own retained session history. Add `--project /absolute/path` to enable the selected folder's file tools. Private session mappings are scoped to the Space installation, Claude account and selected project. Start a new Space session after changing account or project. Ready confirms local sign-in and initialization. Model access is checked on the first task.

## Project file tools and activity

Stop the current connector, then select the project folder explicitly on each launch:

```sh
pnpm connector --project /absolute/path/to/project
pnpm connector --provider kiro --project /absolute/path/to/project
```

The selected directory is resolved locally and is never accepted from a Space task. The local runtimes expose the maintained MCP filesystem server for reading text, listing/searching files, creating directories, and writing/editing files within that root. Native shell, unrelated integrations and approval escalation remain disabled. The file server checks path and symlink boundaries; this is a tool boundary, not a general OS sandbox. Reads and edits reach the selected project. Do not use a folder you have not authorized the agent to access.

A project changes the private session namespace. Start a new Space agent session after enabling tools or selecting a different project; an earlier chat-only session is not silently rebound to a folder. Returning to the same project and identity can resume its saved sessions. Codex ignores project-local runtime configuration; Kiro uses the generated allowlist profile. Kiro waits for the project MCP server to become connected before starting inference.

Space shows Working, Thinking, Responding or Using tools above the shared session composer, based on provider events. States can repeat. Reasoning contents are not forwarded. Tool inputs/results use the existing expandable timeline; older details are shortened to keep accumulated snapshots within the response budget. Completed, stopped and failed turns clear their activity. Unexpected or unconfirmed in-flight failures close the runtime before another tool turn can start.

## Coding from Space

Opt in locally when starting any of the three providers:

```sh
pnpm connector --coding --project /absolute/path/to/project
pnpm connector --provider claude --coding --project /absolute/path/to/project
pnpm connector --provider kiro --coding --project /absolute/path/to/project
```

Start a new Space agent session after changing mode or project. Each coding turn asks the computer owner to approve the selected project in Space before native tools run. The card names the session audience: session visibility controls who sees discussion and outputs, separately from local project access. Provider requests for additional command, file or permission access appear as Allow once / Deny cards. Decisions are bound to the current execution and connection, and the card remains visible until the connector acknowledges it. Stop, disconnect or loss of access invalidates outstanding requests.

Coding mode enables the provider's native tools for editing files, running tests and Git commands, with a thirty-minute turn deadline. Space shows bounded command activity and file changes using its existing timeline and Changes view. Codex uses its workspace-write sandbox and on-request approval policy; Claude enforces native-tool permission hooks; Kiro uses its ACP permission requests. These provider controls are not a uniform OS filesystem read-root jail. Select only a project you intend to expose to that agent, and review native requests for access beyond it. Credentials and native session history remain local.

The provider CLIs must already be installed and signed in through their Space connector profiles. Git identity, repository access and any necessary local credential helper must be configured for the connector's execution environment. Space does not import desktop chats, copy Git credentials, or provide a folder picker in this release. A public session does not give its other participants authority to approve the computer owner's tools.

Set `SPACE_PULL_REQUEST_URL` when starting a coding connector to offer a link to your project's pull request or branch comparison page after a turn produces changes. Use the HTTPS URL for the repository and branch selected for this connector. Participants open the link using their own Git hosting account and confirm any PR creation there. Space stores and shares the URL with session participants, so URLs with credentials, query strings, or fragments are rejected.

## Conversation permissions

A connected agent inherits its owner's current access to conversations in its workspace. It can use its declared skills wherever the owner is a current member, including private channels and DMs the owner participates in. No separate channel enablement is needed. Losing membership, disabling the installation or revoking the connection prevents further authorized execution. Other users' requests still require the owner's approval.

`GET /v1/channels/:channelId/agents` returns owned installations and their effective skills. Connected entries include `inherits_owner_access: true`; the historical `granted_skills` field contains all supported skills for these entries. The legacy enable endpoint accepts `enabled:true` as an idempotent no-op. `enabled:false`, and explicit grant/revoke APIs for a connected installation, return `agent_inherits_owner_access` instead of pretending to restrict it. Revoke the connection or disable the installation to turn it off.

Unpaired installations, such as operator-managed hosted endpoints, retain explicit channel grants. Channel memory still requires its own opt-in and access role; DMs have no channel memory.

## Chat tasks

Select the paired agent’s mention from the composer and send a request. Space creates a managed agent session linked below that message. Open the link to follow up in the session composer. The owner's requests autoapprove; other people's requests require the installation owner's approval. Ordinary thread discussion does not send agent follow-ups.

After project approval, a managed coding session shows the selected Git project's folder name and checked-out branch in its context bar. A coding agent can publish one named review tab per successful turn by ending its response with a `<space-review>` block. This uses the same stable keys, content types and limits as the [provider tab API](../../docs/architecture/ag-ui.md#code-sessions). A later turn can replace or remove the tab. The channel displays the accompanying summary.

Responses stream into Space. Named agent sessions retain their own Codex conversation and working directory across turns and connector restarts; their conversation and outputs stay inside the session view. The private `~/.config/space-connector/codex/` directory stores session history and atomic `0600` mappings from Space session IDs to Codex thread IDs. Storage is isolated by platform, workspace, installation, pairing credential and authenticated ChatGPT account/client identity, with `0700` directories. Before any model turn, the connector saves the thread mapping, obtains Space’s session-readiness acknowledgment, and records readiness locally. A stop before that acknowledgment can safely reuse the same unused thread. Missing or damaged saved state fails the turn without creating a replacement conversation. Signing out removes OAuth tokens and retains this account-bound session data.

Legacy standalone tasks still start fresh ephemeral Codex threads and temporary working directories. Navigator tasks include up to 16 bounded messages from the originating thread; manually requested tasks send the entered goal. Default launches have tools disabled and use a connector-owned HOME/CODEX_HOME, separate from existing Codex desktop data. The installed runtime uses a read-only sandbox; this is not a separate OS filesystem read-root jail.

Stopping or ending a managed session interrupts its exact Codex turn and waits for acknowledgment and completion before accepting another task; other sessions keep working. Chat turns are limited to two minutes; coding turns to thirty minutes. Disconnects, revoked access, expired leases and uncertain acknowledgements stop a run without automatically generating the same response again. A connector reporting an error must be restarted before requesting another task. Task-owner approval and coding tool approvals are separate. Outside coding mode, native permission escalation is rejected.

If Space rejects the connector credential, create a fresh pairing code in Space and run with `--pair` again. Transient socket disconnects reconnect automatically with a delay capped at 30 seconds. ChatGPT sign-in requires user interaction; the connector never signs in autonomously.

The OAuth implementation follows OpenAI's [OSS sign-in flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [Codex app-server integration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server), and [session management](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

Validation: `pnpm --filter @space/connector test` uses generated signing keys, synthetic OAuth/ACP responses and child processes, a real loopback callback and Socket.IO server, and temporary filesystem state. Kiro tests cover CLI onboarding, streaming, restart/resume, account isolation, readiness acknowledgments, cancellation during setup and prompts, and rejected tool/malformed/oversized responses. They never sign in to a real account or perform inference. Live authenticated Kiro inference, restart/resume, streaming Stop, and post-Stop recovery were verified locally on 2026-11-04; see [the E2E report](../../docs/real-kiro-e2e-qa.md) for evidence and the remaining browser-only channel setup gap.

This implementation uses OpenAI's direct public-client flow for a local open-source connector. It does not use or require a client secret or partner API key. OpenAI's [OSS documentation](https://developers.openai.com/siwc/token-sharing-open-source) directs paid or remotely hosted apps to complete the [Sign in with ChatGPT interest form](https://openai.com/form/sign-in-with-chatgpt-interest/); this local flow does not establish approval for a hosted commercial service.
