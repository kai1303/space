# Workspace switching: Slack evidence and Space fix

Date: 2026-11-03. Scope: switch workspaces without resetting Space’s surrounding navigation, and inspect how Slack handles the same interaction.

## Live Slack observations

An isolated Brave tab used the existing signed-in Slack session. The switcher exposed two workspaces. Switching A → B → A restored A’s `random` channel. A had its Channels group expanded and B had it collapsed; those states remained separate. Both exposed a sidebar width of 380px.

The web switch crossed document lifetimes: B’s `performance.timeOrigin` was `1793704406246.8`; returning to A produced `1793704440212.2`. Both navigation entries had type `navigate` and a workspace-specific `/client/<team>` URL. This is evidence of document navigation in the inspected browser path, not evidence that Slack keeps one React tree mounted everywhere. The observation does not establish exact switch latency.

Slack’s [official switching instructions](https://slack.com/help/articles/1500002200741-Switch-between-workspaces) describe selecting a workspace from the workspace icon and the optional persistent workspace switcher. They do not document React lifecycle or cache internals.

## Shipped JavaScript inspected with REA

The live page referenced `client-boot.61a6c08ab09904bb.min.js?cacheKey=gantry-1793680057` on `a.slack-edge.com/bv1-13-br/`. The response was Brotli-compressed. Its decoded SHA-256 is `f35f3ea0f97a9d1473245fa97e03aae38e9599c250995d378347c07215cbd4a3`.

Babel parsed the downloaded bundle as inert syntax to extract five selected module factories. REA then analyzed the extracted files through its CLI; no bundle code was executed.

| Module | Observed source behavior |
| --- | --- |
| `CyZ5` | Switch handler checks workspace metadata, booted workspaces, failed boots and pending/expired authentication. |
| `qEuO` | `isMultiTeamCapable()` reads that capability from the client environment; named browser targets use `_team_<subdomain>`. |
| `XrtJ` | `openInNewTab()` creates a link with a target, activates it, then removes it. |
| `8EYf` | Selectors expose workspace metadata and booted/failed workspace state. |
| `G0M2` | Stores the destination for navigation to a workspace still booting. |

In `CyZ5`, clients without multi-team capability use the browser-link path. For multi-team-capable clients, an already-booted workspace takes the route-navigation path; an unbooted destination records `bootingTeamId` plus requested route properties. Pending and expired authentication have explicit handling. This supports separate warm and cold paths; it does not prove that all desktop components, scroll positions, or sockets remain mounted.

The static evidence covers six extracted source files (one repeats the switch-handler module), with zero parse failures. Semantic relationships remain partial and dependencies outside this selected subset are unresolved. The Slack desktop runtime was not tested.

Retained artifacts, outside Git:

- `/Users/kai/.codex-artifacts/space-slack-2026-11-03/workspace-switch/runtime-observations.json`
- `modules-provenance.json` in that directory records source offsets and extracted-file digests.
- `rea-navigation-evidence` is the complete Evidence bundle; parent record `ev_aaabd8e2247ea60aaddd0d51bd75cc9fe63cd4eb1eef4326ea04548b094c8427`.
- `rea-navigation-summary.json` is its compact projection.

No Slack messages, drafts, membership, or settings were changed.

## Space implementation

Space’s visible reset came from `WorkspaceChannels key={workspace}`. The key remounted the sidebar and all workspace content on every switch.

The workspace container and shared sidebar now stay mounted. Channel lists, last selected channel, sidebar filter and collapsed sections are held separately by workspace ID for the signed-in session. Returning to a visited workspace immediately restores its navigation while its channel list revalidates. New workspaces use loading placeholders only inside the content area.

Conversation rooms remain keyed by channel: old messages clear immediately, old sockets disconnect, and destination messages and access are freshly loaded. This intentionally does not cache private message history or preserve thread/scroll state between workspace switches. React still renders components when relevant state changes; the fix removes the broad remount and navigation reset.

Late channel-list responses are ignored after switching. Pending create/join results update only the originating workspace, and a late creation cannot select a new channel in a later visit. Denied workspace revalidation removes the cached channel list and conversation. Session changes discard the workspace caches with the existing session-keyed root. Channel-list reads use a mutation version so older revalidation and periodic-refresh responses cannot roll back successful create/join changes; a stale initial read retries against the new version.

## Verification

Regression tests cover stable shell/sidebar/input DOM identity, restoring a selected channel before revalidation finishes, separate sidebar filters and collapse state, drafts, overlapping Back navigation, stale workspace responses, denied cache revalidation, channel creation completing after switching away or returning, and list responses arriving after a successful mutation. The sidebar-remount, sidebar-state, and stale-list regression cases were observed failing before their fixes.

Final checks: **130 web tests passed**, **74 shared UI tests passed**, UI build passed, and the web production build (including TypeScript checking) passed. Vite still reports dependency `use client` directive warnings and large chunks. Read-only review found the stale-list race, which was fixed and re-reviewed with no important remaining findings.

The authenticated Space browser session was unavailable in the isolated QA tab: `/chat` showed the sign-in screen. No end-to-end authenticated browser-switch claim is made. Automated results above verify the component behavior; they do not establish authenticated browser or production behavior.
