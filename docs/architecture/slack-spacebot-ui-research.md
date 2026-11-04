# Spacebot UI reference

Reviewed November 4, 2026, against the authenticated Slack web app's Slackbot new-conversation view. No Slack message was sent.

## Observed in the browser

- Slackbot uses a small bot icon beside a 22px greeting, with a single central interaction area approximately 768px wide.
- The main surface is quiet and spacious. The welcome view does not stack a large logo, introductory paragraphs, agent cards, and a second continuation card.
- Slackbot's sidebar contains conversation and artifact navigation. Its composer sends to Slackbot itself; that is a product capability, not merely a visual treatment.

## Reverse-engineering evidence

Captured the loaded `gantry-v2-async-client-slackbot-sidebar-view.fce0717a4dc70cf2.min.js` through the browser debugger, then disabled the debugger. Analyzed the 30,344-byte shipped JavaScript using `rea-agents@6.8.0 analyze-javascript-application`.

- Evidence: `ev_516a7f9cf6c8a960a0c7e528d0629895fda7ee38c7b1d9bf96fafb5c8b09b3e0`.
- Artifact SHA-256: `92da6dc9758d16350c64f059285ed9d9b9480c2c654cf528e05c3c2983e3153b`.
- One JavaScript file parsed, zero parse failures. Coverage of the entire application is partial; this is not a reconstruction of Slack's backend or full Slackbot implementation.
- Layout conclusions above come from the rendered UI and computed styles. Static analysis does not establish server behavior.

Local reference screenshots and the REA evidence bundle are retained under `~/.codex/visualizations/2026/11/04/01a1a574-8389-78f0-9f0f-30339aad1abc/spacebot-slack-fix/`. Captured third-party source is not added to this repository.

## Space adaptation

Spacebot keeps its existing role: select an installed agent and open a real channel. The view adopts Slackbot's compact greeting and single central area, with agent selection, availability, and channel navigation grouped together. It does not add a nonfunctional chat composer or invented conversation history.

Selected states use Space's theme tokens. Offline, sign-in-required, connection-error, and unknown availability states explain the situation and offer the existing connection-management action. Opening a channel remains available for team discussion. Online agents retain the instruction to mention an agent enabled in that channel. Disabled installations show the pairing empty state.

## Verification

- 19 focused tests passed across `WorkspaceDestinations.test.tsx` and `ChatShell.test.tsx`, including switching agents, live presence changes, connection states, pairing, and channel navigation.
- Web production build and TypeScript check passed. Build reports large-chunk and dependency `use client` directive warnings.
- Browser checks confirmed member-management and channel navigation, dark/light rendering, and a 390px layout with equal main client/scroll widths of 338px.
- Selected-agent text contrast: dark 9.00:1; light 15.18:1. Light secondary text: 5.59:1.
- Live paired agent was offline. Online and multiple-agent behavior were tested with fixtures, not a live agent turn.
