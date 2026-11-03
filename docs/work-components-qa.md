# Work and agent component verification

Date: 2026-11-03. Scope: TicketCard, Alert, CodeBlock, ToolExecution, AgentApproval and their gallery examples. All examples use local synthetic state.

## Automated checks

`pnpm test:ui` passes 48 tests (46 UI, 2 web). The 18 work-component tests cover controlled ticket callbacks, alert announcements/dismissal, escaped code and exact clipboard arguments, clipboard failure, code language/gutter/highlighting, timeline expansion/single-tool/substep/running/completed behavior, source actions, empty timelines, approval duplicate blocking, failed decisions/retry, terminal states, replacement request identity and destructive/custom labels. New fidelity and request-identity assertions were observed failing before their fixes.

UI/web typechecks pass. The UI build copies the added stylesheet and generates 49 resolved color tokens per theme. The full build succeeds; Shiki core/engine/grammars are split into deferred chunks. Unsupported languages, large code and highlighting failures fall back to plain text. Existing dependency directive/chunk-size warnings remain build warnings.

## Browser checks

- Ticket opens a local detail dialog; marking done updates the controlled examples.
- Error alert has distinct danger background/border, dismisses and can be restored. Restored ticket/alert CSS was checked after a review caught an accidental shared-selector regression.
- Code block highlights real tokens; measured string color is #81bc69 in dark mode and #137700 in light mode. The copy control reports success. Exact clipboard arguments are covered by automated tests; the automation clipboard read surface returned a stale earlier value, so browser-to-host clipboard contents were not independently verified.
- At 320×740, code content scrolls inside its container (361px content / 252px viewport) while the page remains 320px wide. At 1440×1000 the page also has no horizontal overflow.
- Expanded running timeline shows its point list without shimmer; collapsing activates the measured 1s shimmer. Reduced-motion emulation disables it. Emulation and temporary viewport overrides are reset after checking.
- Timeline toggles retain source-style expand/collapse labels and associate the visible summary as an accessible description.
- Approval failed-save simulation retains the request; retry succeeds. A new request restores decision controls. Request IDs are no longer visible card metadata. The content uses the static shipped live-call approval structure, with action-specific labels.
- Light/dark surface and alert/code colors update together. No console warnings or errors were captured on checked gallery paths.

Independent review found the approval identity leak, the lost ticket/alert styles and the hidden timeline summary. Each was corrected. See [the research report](research/slack-action-components.md) for REA Evidence IDs, exact capture scopes and the separation between observed Slack behavior and Space adaptations.

Screenshots live under `/Users/kai/.codex/visualizations/2026/11/03/01a19f82-8391-7ba3-a409-61a31b7bca6b/`: `space-work-components.jpg` and `space-agent-approval.jpg`.

No live backend transport, authorization enforcement, persistence, external issue creation, actual tool execution or real approval action was implemented/verified in this slice. The static live-call approval component was not invoked in Slack. Generic Card footer rules were researched; TicketCard is not claimed as a full Slack work-object clone.
