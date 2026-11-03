# Slack sidebar: captured styles and implementation

Captured on 2026-11-03 from the user's authenticated Slack web session. This is the active dark workspace theme, not a claim about every Slack theme or viewport.

Follow-up: [workspace controls, rail, and top bar](slack-app-chrome.md) supersedes the fixed 385px initial width below with sizing derived from multiple source viewports, and replaces the native workspace selector with a popover.

## Evidence

Local capture directory: `/Users/kai/.codex-artifacts/space-slack-2026-11-03/sidebar-style-capture`.

- `sidebar.html` and `rail.html` contain the rendered sidebar and app rail subtrees.
- Three actual loaded stylesheet resources were downloaded: `client-boot-styles.88d120a749e8bc58.min.css`, `slack-kit-gantry-v2-styles.594b6e70f477bddd.min.css`, and `helper-gantry-v2-styles.9aa943ade7971743.min.css`.
- `matched-styles.json` records browser CSS-engine matched, inherited, and computed declarations for eight valid sidebar nodes. `sidebar-matched.css` extracts 60 matched rules. `layout-details.json` retains the background and filter details.
- `manifest.json` records source URLs and SHA-256 hashes. Raw workspace HTML stays outside the repository.

This pass used live browser HTML and CSS extraction. Earlier REA JavaScript analysis was reused as context; it was not rerun or presented as a new CSS analysis.

## Mapping to Space

| Element | Captured Slack value | Applied in Space |
| --- | --- | --- |
| Top bar / app rail | 40px / 70px | Same desktop dimensions |
| Sidebar | 385px at the captured viewport | 385px initial width; remains resizable |
| Workspace header | 49px; 18px/24px, weight 900 | Same |
| Conversation filter | 28px height; 8px radius; 13px input | Same |
| Conversation row | 28px height; 15px/28px; weight 400 | Same; unread rows retain weight 700 |
| Row geometry | 8px outer inset; `0 8px 0 24px` padding; 8px gap; 6px radius | Same |
| Selected row | `#7d3986` background; `#efe1f5` text | Same dark tokens |
| Inactive text | `rgba(227,206,235,.8)` | Same dark token |
| Sidebar surface overlay | `rgba(16,18,20,.6)` over workspace gradient | Same layered background |
| Outline / hover | `rgba(239,225,245,.22)` / `rgba(239,225,245,.08)` | Same dark tokens |
| Rail icon / label | 36px tile, 8px radius; 11px/12px label | Same desktop geometry |
| Section affordance | Kind icon changes to caret on hover | 80ms opacity transition; reduced-motion override |

The captured background is reproduced with the radial and conic gradient in `packages/ui/src/tokens.css`. Seven sidebar context colors per theme bring the generated palette to 56 colors per theme. The token exporter now preserves RGB/RGBA declarations.

Shared structure and row rules live in `packages/ui/src/sidebar.tsx` and `packages/ui/src/workplace.css`. Chat shell dimensions and rail styles live in `apps/web/src/chat.css`. Main chat shows the empty Starred, Direct messages, and Apps sections and removes the duplicate account footer. New message closes a thread/search view and focuses the channel composer; it also closes the mobile drawer. Other sidebar consumers keep the previous optional-section behavior.

## Validation and limits

- Full build passed (11 tasks). UI/web tests passed: 76 tests at verification time, including empty sections, a single Add channel action, filtering, New message, and draft/focus behavior.
- Browser computed styles confirmed a 385px sidebar, 49px header, 28px filter and rows, and the captured selected-row colors.
- At 390px, the drawer fits the available 338px below the 40px top bar without horizontal overflow. Filtering and New message were exercised; the composer received focus. Temporary viewport overrides were reset.
- Final desktop screenshot: `/Users/kai/.codex/visualizations/2026/11/03/01a19f82-8391-7ba3-a409-61a31b7bca6b/space-sidebar-matched.jpg`.
- The full repository typecheck encountered unrelated socket/EventTarget overload errors in `tests/integration/agent-connections.test.ts:35` during concurrent work. This does not establish a passing monorepo typecheck.

Space retains its own font and icon assets. The light palette is an authored counterpart, not extracted Slack light-theme evidence. Slack utilities such as Threads, Huddles, Drafts, Saved, and Directories were observed but are not added by this styling change. Empty DM/Apps sections do not imply those backends exist. The search dialog is outside this pass.
