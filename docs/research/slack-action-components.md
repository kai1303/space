# Slack action components

Researched 2026-11-03 from the user-selected Slackbot web conversation, its loaded Rspack bundle and stylesheet, REA 6.8.0 static analysis, and official Slack API references. Browser observations and static findings are separate evidence types.

## Button layouts

| Pattern | Rendered structure and behavior | Basis |
| --- | --- | --- |
| Actions block | A wrapping row below message content. The inspected client shows the first five elements and “+ N more” at seven or more elements. Loading/error indicators sit beside the row. Default control size is small; spacing is 8px. | REA `aFwj`, captured CSS |
| Card block | Icon/title/subtitle, optional body/subtext, footer actions. Danger actions go left. Other actions go right, with primary furthest right. Footer gap 8px; content padding and row gap 12px. | REA `4iTW`; [Card block](https://docs.slack.dev/reference/block-kit/blocks/card-block/) |
| Section accessory | A single button alongside section text. This is separate from a footer row. | [Button element](https://docs.slack.dev/reference/block-kit/block-elements/button-element/) |
| Hover/context actions | Share, more-options and similar icons. The inspected wrapper exposes them while hovered, focused or its menu is open. | Captured `rZZS`; outside the selected REA Actions analysis |
| Slackbot live-call approval | Short “needs your okay” heading, detail lines, tool display names, then affirmative/negative buttons. Defaults Yes/No; custom labels allowed. Destructive tools change the affirmative style to danger. Right-aligned actions have a 12px gap and 20px top spacing. | REA `GptLiveApprovalCard` in `XJKj`, captured CSS; not an exercised live approval |

The Card API allows at most **three** footer buttons. The standalone [Actions API](https://docs.slack.dev/reference/block-kit/blocks/actions-block/) allows up to **25** interactive elements; that contract differs from the client's overflow presentation. Do not apply the Card footer ordering to every Slack surface: the separate live-call approval component renders affirmative then negative controls.

`ButtonElement` receives action/block identity, text/value, optional URL, accessibility label, disabled state and confirmation configuration. It tracks click processing/loading; the Actions block can display loading/error feedback. Configured confirmation is a separate step. Resolving an operation and updating the message belong to the app. The loaded style resolver defaults to outline; primary/danger and newer default/ghost variants are supported. Captured current desktop CSS fills its primary/danger design-system buttons; public button docs describe green/red outline/text treatment, so surface/client evidence is needed for exact appearance.

## Code block findings

Live Slackbot rendering and REA `Oxuj` show a language label and copy icon, a single rounded surface, line numbers, horizontal scrolling and lazy Shiki highlighting. The measured dark surface is `#212428`, radius 12px, monospace 12px/18px. The line-number gutter is sticky and excluded from selection. Copy receives the original string. Filename/wrap controls were absent from this component.

The shipped `1AnO` theme maps comments, strings, constants, entity names and punctuation to semantic colors. Scoped dark values resolve to `#df847c`, `#81bc69`, `#899bdc`, `#cfa1de` and `#9a9b9e`. These were resolved at the code block, not the document root. Composer preformatted blocks and shared file snippets are separate renderers; see [message formatting](https://slack.com/help/articles/202288908-Format-your-messages-in-Slack) and [file snippets](https://slack.com/help/articles/204145658-Create-or-paste-code-snippets-in-Slack).

## Tool timeline findings

The live completed search has one summary line that expands into separate tool points joined vertically. REA `/Dnj` confirms: no points means no timeline; one tool without substeps cannot expand; multiple tools or substeps can. Active collapsed headers can show the latest point; expanded multi-tool headers fall back to “Using N tools.” Completed headers use their summary or “Used N tools.” Icons are deduplicated and capped at the most recent three. Substeps can expose a separate sources action.

Captured CSS gives active collapsed headers a 1s shimmer, cubic-bezier `.22,.01,.77,.99`, with gradient position from 100% to -100%. Raw JSON input/output cards and per-call duration badges are absent from the observed timeline. Space's initial demonstration used those conventions and was replaced.

## REA evidence and provenance

An existing Node 24.22.1 runtime ran the existing REA 6.8.0 CLI; no MCP/client configuration changed. Browser/CDP exported the already-loaded `gantry-v2-async-client-boot-shared.3ac2d197375862a1.min.js` bundle. Babel selected exact factory ranges, retaining module IDs inside an inert Rspack wrapper. The extraction and REA did not execute Slack bundle code. Raw source, original offsets, source hashes, selected-file hashes and complete records remain outside the repo at `/Users/kai/.codex-artifacts/space-slack-2026-11-03/`.

| Scope | Parent Evidence ID | Result |
| --- | --- | --- |
| Code, theme, timeline | `ev_ff1bd067723ca03a8be13178eab927e58882db566c19c80bc60476cf830f2c64` | 3 modules, 46 findings, 0 parse failures |
| Live-call approval | `ev_0cf7145691107a6a2fd910cc0e35e051f2a9cdce0cd85e1f559a6dc17aef93ae` | 1 module, 78 findings, 0 parse failures |
| Actions, ButtonElement, channel-section card | `ev_9024d5846695b48b8deea1b14ac66d3ad95a2df5724c5396b2b688428a045fd9` | 3 selected modules, 352 findings, 0 parse failures |
| General Card renderer | `ev_aac5bf6d4d037bfe9cc7f57239fae17cb82f34e3b0a162b24186ec5897f30528` | 1 module, 24 findings, 0 parse failures |

Records use matching `agent-render-rea-rspack-*`, `agent-approval-rea-*`, `action-buttons-rea-*` and `action-card-rea-*` filenames. Manifests: `agent-module-provenance.json`, `agent-approval-provenance.json`, `action-button-provenance.json`, `action-card-provenance.json`. Earlier partial extraction records are separately named and are not the final evidence above. Selected syntax parsing completed, while application/semantic relationships remain partial because imported factories/server behavior are outside scope. Static findings do not prove runtime execution. Actual approval submission, destructive operations, generic-card interaction and responsive Slack behavior were not exercised.

## Space boundaries

CodeBlock and ToolExecution follow these source-grounded structures, using Space's existing fonts and Phosphor icons. Five code grammars load lazily; unknown/large code and grammar failures retain escaped plain text. React renders tokens without injected HTML. The code palette joins generated theme tokens.

AgentApproval follows the static live-call content structure with custom action labels in the gallery. Scope context, terminal states, save-error retry, native disabled controls, request identity isolation and reduced motion are Space adaptations. Ticket/Alert are shared Space components, without a claim that they reproduce Slack work-object or alert-block renderers. Gallery data and callbacks are synthetic/local.
