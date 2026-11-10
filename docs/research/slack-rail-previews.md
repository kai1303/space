# Desktop navigation hover previews

Inspected the signed-in Slack web client on November 10, 2026. Each test moved the pointer over the rail without navigating, then inspected the rendered overlay. The workspace had eight visible tabs. Membership, preferences and available destinations can affect other workspaces.

| Tab | Slack observation | Space implementation |
| --- | --- | --- |
| Slackbot | Overview, Agenda, calendar connection and recent Slackbot conversations | Spacebot shows recent accessible agent sessions. New message opens Spacebot’s agent/channel chooser. Agenda uses upcoming Space to-do reminders. |
| Home | No card with Home or Agents & tools selected | Navigation only |
| DMs | Recent conversations, snippet, time and Unreads. Selecting DMs removes its preview trigger. | Bounded direct-message list, server-side unread filter, explicit row selection opens the conversation |
| Activity | Notification feed with an Unreads filter | Workspace notifications, unread filter, explicit row selection opens the source |
| Files | File rows, Starred filter and per-row More actions | Accessible workspace files, starred filter, source links and star controls |
| To-dos | To-dos card with a medal and an empty list message | Open personal to-dos, source navigation, completion and the observed empty state. Populated Slack rows were not exercised. |
| Agents & tools | No card while selected or from Home | Navigation only |
| Admin | An Admin Tools menu including workspace settings and member management | Hover and click open the same Space administration actions |

## Layout and interaction

In a 1680 × 864 CSS pixel viewport, standard cards measured 360 px wide by 562 px high (65vh). Their left edge was at x=67, next to the 70 px rail. The header was 44 px high. The Slackbot card was content-sized at 314 px. Downloaded CSS defines a 12 px radius, 160 ms fade and 8 px horizontal entrance. The 36 px icon tile stays in place, and its glyph scales to 1.15 over 125 ms. Single-line tabs measured 52 × 68 px with a 4 px icon-to-label gap and 8 px vertical padding.

The shared PeekTrigger module in the captured Slack client bundle defaults to a 300 ms opening delay. It handles Escape, tracks whether another preview has opened, and uses pointer geometry to allow movement into the panel. That default is static evidence, not a per-tab latency measurement. REA parsed the isolated module from gantry-v2-async-client-boot-shared.3ac2d197375862a1.min.js. Evidence ID `ev_b782d8c893df1e9d8de0c7d4eeb6f969425c0647f76647a44e46a05c899b8429`. The local REA output is saved under `~/.codex-artifacts/space-slack-rail-2026-11-10/peek-trigger-rea.json`. See the [earlier capture and stylesheet provenance](slack-sidebar-styles.md).

Space mounts one panel on demand. A pointer bridge and a short close delay allow entry from the rail. ArrowRight or ArrowDown opens a preview from its trigger, Escape dismisses it, and direct tab activation navigates. Touch activation goes straight to the destination. File, notification and conversation data use the signed-in workspace’s existing endpoints and event subscriptions.

## Activity and moving between tabs

A second inspection of the signed-in client measured a populated Activity row at 120 px high. Its 36 px avatar sits 16 px from the left edge. The sender and a smaller timestamp share the first line; the next two lines are the message excerpt. The final line has a 16 px activity icon and a bold source. The 44 px header holds a labeled 28 × 18 px Unreads switch. An empty result centers “All caught up” in the body. These measurements are from the browser. Space uses its own avatars, notification types, and tokens.

Space keeps the popover surface mounted when moving between preview tabs. Only its contents change. A fresh card uses the 300 ms dwell and 160 ms entrance described above. Once open, a 65 ms dwell avoids opening every tab the pointer crosses, and the card moves toward the next trigger over 120 ms. Those handoff timings are Space choices. Keyboard and reduced-motion navigation reposition directly.

The [request benchmark](slack-rail-query-benchmark.md) measures opening, filtering, and revisiting these cards, plus a live update and an explicit file mutation.
