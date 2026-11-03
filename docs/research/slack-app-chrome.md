# Slack workspace control, rail, and top bar

Follow-up to the user's three browser annotations on 2026-11-03. The earlier sidebar pass copied one 385px rendered width into the app. This pass checks the surrounding controls and smaller viewport behavior against the live Slack client.

## Source evidence

Actual rendered HTML and computed styles are retained outside the repository in `/Users/kai/.codex-artifacts/space-slack-2026-11-03/app-chrome`:

- `895-capture.json`: capture with a requested 895px browser size; Slack's existing 90% zoom produced a **994px CSS viewport**, recorded in the file. This is not a same-CSS-size comparison.
- `topbar-geometry.json`: flex sizing, offsets, and control styles from that capture.
- `895-layout-rule.css`: actual runtime-generated layout rule, `grid-template-columns: 197px auto`, retained after correcting the viewport to **895×853 CSS pixels**. The matching screenshot is `slack-app-chrome.jpg` in the visualization directory.
- `1680-css-layout.json`: fresh desktop HTML/computed styles at 1680×864, including the runtime-generated 385px sidebar rule and the three loaded stylesheet URLs.

The downloaded stylesheet files and their SHA-256 manifest remain in the adjacent `sidebar-style-capture` directory. This pass used live browser inspection and downloaded-source context, not a new REA static JavaScript analysis. Slack's existing workspace and message content was not edited. The source viewport was restored before isolated QA. A final narrow QA-tab check and viewport-reset attempt timed out in browser control; no successful 320px check or final QA-tab reset is claimed.

## Findings and changes

| Marked area | Observed Slack behavior/style | Space change |
| --- | --- | --- |
| Workspace title | Button with a 32px height, 4px/8px padding, 6px radius, 18px/24px weight-900 text; opens a styled menu | Replaced native select with the shared accessible popover. Workspace selection and the existing members screen are available. |
| Workspace popover | 320px menu width; 12px vertical content padding | Same dimensions, aligned to the start of the title control and clamped to the viewport. |
| Rail workspace mark | Actual workspace-switch button, 36px tile and 8px radius | Mark now opens workspace switching. |
| Rail navigation | 70px rail; 52×68px tabs; 36px icon tiles; Home glyph 20px | Preserved measured geometry and put Members inside the same icon tile structure. |
| Top bar | 40px height; history controls left of search; controls 26px with 4px radius; search 28px with 6px radius | Replaced the large desktop wordmark with Back, Forward, and recent-history controls. Search starts at the sidebar boundary. |
| Sidebar width | Dynamic emitted widths: 197px at 895 CSS px, about 221px at 994 CSS px, 385px at 1680 CSS px | Initial proportion is inferred as roughly 24% of the workspace after the rail/frame. Resizing retains the user's proportion and existing 180–450px bounds. |
| Empty conversation | Conversation surface stays separate from workspace chrome | The main area now has its own surface background, preventing the gradient from showing through an empty conversation. |

The 24% rule is an inference from three rendered widths, not a recovered JavaScript sizing function. Space's mobile drawer, available menu entries, and design-system link remain product adaptations. In Slack, the header menu also exposes plan, preferences, settings, mobile sign-in, sign-out, and native-app actions; those capabilities are not claimed here. The rail workspace switcher showed a loading announcement but did not expose a usable menu in the inspected Slack session, so its exact menu contents remain unverified. Existing source evidence establishes the trigger and its geometry.

## Application behavior

`ChatShell.tsx` owns the visual controls and menus. `Chat.tsx` records visited workspace/channel contexts in memory and connects Back, Forward, and the recent-conversation menu. Navigation preserves channel/thread draft ownership. Initial URL context from the concurrent source-message feature is preserved. These controls do not navigate to unrelated browser history or claim durable cross-session history.

Review fixes include keeping search available after same-workspace history navigation, restoring focus to the stable rail switcher after the header picker unmounts, and reading the latest destination when repeated Back actions overlap workspace loading. Regression tests exercise all three. The sidebar width also responds to viewport changes without losing a manual resize when the viewport returns to its prior size.

## Visual verification

The shared in-app session was repeatedly signed out by concurrent QA. Final browser checks therefore used the existing local synthetic QA fixture in a separate Brave session. The app retained normal authentication and access checks.

At 895×853 CSS pixels, Space measured a 40px top bar, 70px rail, 197px sidebar, 28px search control, and 320px workspace popover. The popover started at x79 and stayed within the viewport. The rail switcher and header picker each opened one menu. Live channel Back navigation returned to the correct channel with search still enabled. The main surface computed to `rgb(26,29,33)` in dark mode.

At 390px, the drawer fit the 338px available width and the workspace popover stayed within the viewport. Escape dismissed the menu while keeping the drawer open. The existing mobile presentation is an authored Space adaptation because the observed Slack client has a desktop minimum width.

Screenshots are stored under `/Users/kai/.codex/visualizations/2026/11/03/01a19f82-8391-7ba3-a409-61a31b7bca6b/`, including `slack-app-chrome.jpg` and `space-workspace-menu.jpg`. The final full build passed 11 tasks, UI/web typechecks passed, and the combined UI suite passed 115 tests (61 shared UI, 54 web, including concurrent feature coverage). This pass does not establish full Slack feature or theme parity.
