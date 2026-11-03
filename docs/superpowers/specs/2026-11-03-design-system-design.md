# Space design system

Build the frontend foundation for the requested Slack-style workplace before the application screens. The user's instruction to continue and first build the design system selects this scope.

## Deliverables

- `packages/ui`: reusable, typed React components and CSS tokens. Semantic light/dark colors; Lato typography; a 4px spacing scale; control sizes, radii, elevation, focus and reduced-motion behavior.
- Primitives: Button, IconButton, Badge, Avatar/presence, TextField, Switch, Tabs, Menu, Dialog and Skeleton.
- Workplace components: ChannelItem, Message with reactions/reply action, and Composer with validated sending and keyboard behavior. Callbacks pass application state to consumers; UI components do not authorize agents or call APIs.
- `apps/web`: an interactive, responsive gallery covering foundations, component states, and a small assembled conversation. Navigation, theme choice, component search, dialog, menu, switches, tabs, reactions, local demo messages and thread opening work. Demo content is synthetic and does not persist private Slack data.
- Documentation: installation/imports, component examples, accessibility contracts, source observations versus authored adaptations, and verification evidence.

## Evidence and design choices

On 2026-11-03, the user's open Slack web channel in Brave was inspected through the connected browser. This is direct browser evidence, not REA output; REA tools are absent. Observed: Slack-Lato font, 15px/22px body, 13px/18px secondary text, 18px/24px heading controls, 4px spacing increments, common 28px compact controls, 4–8px control radii, aubergine navigation, #1a1d21 main dark surface, #222529 composer/raised surface, #d1d2d3 foreground and #b9babd secondary foreground. Source uses custom theme settings, so these observations are not a universal Slack specification.

Adaptations: locally bundled open-source Lato replaces Slack-Lato; Phosphor regular SVG icons replace Slack's custom icons. Space has its own wordmark. Light theme, semantic feedback colors, gallery layout, responsive adaptations and agent badges are authored choices. No Slack scripts, private conversation content, account details or proprietary font files are distributed.

## Interaction and accessibility

Use native buttons, text inputs, textarea, details/summary menus and modal dialog. Label icon controls; expose pressed/selected/checked states and feedback. Tabs support arrows, Home and End with roving focus. Escape closes native modal/menu; modal restores trigger focus. Composer rejects whitespace and ignores Enter during IME composition; Enter sends and Shift+Enter inserts a new line. Native textarea remains plain text; richer editing belongs to a subsequent module. Theme choice is retained locally with a safe fallback if storage is blocked. Focus remains visible in both themes; respect reduced motion.

## Acceptance and exclusions

Verify component behavior with focused DOM tests, full monorepo typecheck/build and existing contract tests; inspect the gallery in the browser at desktop and mobile widths; check overflow, primary interactions and accessibility. No authentication, backend integration, agent execution, production claims, publishing, or completion of the full Slack clone in this slice. Preserve the existing uncommitted backend; no broad Git staging or baseline commit.
