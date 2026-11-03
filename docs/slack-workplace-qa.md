# Slack workplace verification

Date: 2026-11-03. Scope: the composer/search/color/sidebar frontend slice and `/workspace` preview.

## Automated results

- `pnpm test:ui`: **24 passing tests** (22 shared UI tests, 2 existing gallery tests).
- `pnpm typecheck`: passes across the workspace.
- `pnpm build`: passes; Quill is emitted as a separate lazy-loaded chunk and the UI build generates the theme-token JSON.

New tests cover combined/quoted search filters, malformed syntax, literal URLs, exact quick-filter replacement, rich-link indexing, blank-input keyboard safety, safe link protocols, allowed rich-text attributes, escaped React rendering, grouped lists/code blocks, sidebar filter/collapse/keyboard resize, and over-limit local draft preservation.

Regression checks were observed failing before corrections: blank input selected an unseen search result; labeled rich links were omitted from search; adjacent code lines rendered as separate blocks. Existing tests continue to cover send validation, IME guards in the plain composer, pending-send deduplication, errors, dialogs, tabs and gallery channel isolation.

## Browser results

Verified in the connected in-app browser, with synthetic local data:

| Area                | Observed result                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Rich formatting     | Selected text becomes a real `<strong>` in Quill; sent content retains the formatting                                                 |
| Link dialog         | Executable URL rejected; Text edits change the visible label; a valid labeled URL remains searchable through `has:link` and URL terms |
| Code block          | Two lines sent as one contiguous `<pre><code>` block                                                                                  |
| Send/multiline      | Enter sends; Shift+Enter leaves the message count unchanged and preserves multiline content                                           |
| Emoji/mention       | Chosen emoji and person text insert at the caret; local message sends correctly                                                       |
| Pickers             | Selection and Escape dismiss; outside pointer action closes an open picker                                                            |
| Drafts              | Rich text restores after selecting another channel; the new channel starts empty                                                      |
| Local attachments   | Synthetic file metadata selected through the native chooser; survives switching channels; attachment-only draft appears in Drafts     |
| Channel search      | Header action opens a query seeded with `in:design-system`                                                                            |
| Search results      | Combined `in:design-system from:me has:link` yields the expected single fixture; a newly sent custom-label rich link is indexed       |
| Search keyboard     | Ctrl/Cmd+K opens; empty ArrowDown+Enter remains in the dialog; Escape closes; suggestions and result selection use native controls    |
| Search empty state  | Synthetic no-match query shows zero results, empty-state guidance and edit-search action in the secondary pane                        |
| Sidebar             | Conversation filtering narrows the list, selection closes the mobile drawer, and ArrowLeft changes the width from 390 to 380          |
| Token inspector     | 41 generated colors; editor-token filtering and clipboard copy work; JSON data contains the matching theme values                     |
| Desktop/mobile      | 1440×1000, 390×844 and 320×740 render without horizontal page overflow; long token rows scroll inside their table container           |
| Dark context tokens | Inspector reports #222529 editor background, #797c81 border and #b9babd placeholder                                                   |
| Browser errors      | No captured warnings or errors in the checked paths                                                                                   |

Independent review found four meaningful issues: incorrect channel-search seed, rich-link indexing, lost attachment drafts, and invisible empty-query selection. All were fixed and re-reviewed with no significant remaining findings. Browser checks reproduced attachment loss before the fix and confirmed retention afterward. Link-label editing was separately corrected and verified end to end.

## Evidence and screenshots

REA analysis evidence and limitations are linked in [the research report](research/slack-workplace.md). Raw scripts and the complete REA record stay outside the repository.

Screenshots are saved under `/Users/kai/.codex/visualizations/2026/11/03/01a19f82-8391-7ba3-a409-61a31b7bca6b/`:

- `space-workspace-desktop.jpg`
- `space-workspace-search.jpg`
- `space-workspace-tokens.jpg`
- `space-workspace-mobile.jpg`

## Limits

No Slack messages were sent. No backend authentication, real-time transport, network file storage, Slack search ranking, recording or scheduling was implemented or verified. New rich-editor IME handling is guarded in code; a real IME hardware composition session was not rehearsed. Drafts/messages and attachment metadata are local in-memory demonstrations. No production or full Slack parity claim follows from this verification.

Final result: passed for the scoped frontend reconstruction.

## Motion follow-up

Motion 14.9.0 is installed in the shared UI and web app. The shared policy has four additional assertions: normal 180/120ms timing, easing, and zero duration for reduced motion. `pnpm test:ui` passes **28 tests** (26 UI, 2 gallery); UI/web typechecks and the full build pass. The current full-repository typecheck reports an unrelated implicit-any callback at `tests/integration/organization.test.ts:84`; that backend test was not changed in this frontend slice. Vite reports ignored dependency `use client` directives and a main chunk above 500KB; this client-only build succeeds.

Browser checks after integration: search receives focus and Escape dismisses; token dialog Escape restores focus to its trigger; emoji picker opens/closes; a submitted message renders once and remains when revisiting its channel; collapsed channel groups retain the current channel; at 390×844, choosing a conversation hides the mobile drawer and the page has no horizontal overflow. The token dialog was also exercised under temporary `prefers-reduced-motion: reduce` emulation, which was reset afterward. No console warnings/errors were captured in these paths.

Browser automation does not expose animation-frame inspection, so exact frame timing was not measured. The 120/180ms easing policy is authored, not extracted from Slack. Native close transitions remain immediate. The saved follow-up screenshot is `space-workspace-motion.jpg` in the artifact directory above.

### Incoming-message follow-up

Message entrances now belong to the shared `Message` component and use ID-based arrival detection instead of a sender-specific marker. Two new hook tests cover batched incoming authors, unchanged history, channel navigation, and messages received while the feed is hidden. They were observed failing for missing arrival detection before implementation. The combined frontend suite now passes 30 tests. The gallery provides a repeatable **Receive a message** preview at `/#message-motion`. Actual backend delivery is still outside this slice.

UI/web typechecks and the full build also pass. Browser replay updated Jamie's preview message on successive clicks without console errors. With reduced-motion emulation enabled, the incoming row rendered at opacity 1 with transform none; emulation was reset afterward. Screenshot: `space-message-arrival.jpg` in the artifact directory above. Exact frame timing remains unmeasured.
