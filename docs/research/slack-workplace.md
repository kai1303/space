# Slack workplace: composer, search, colors, sidebar

Date: 2026-11-03. The requested four areas were inspected in the user's existing Slack web session, then reconstructed as a local frontend at `/workspace`. The existing design-system gallery remains at `/`.

## Evidence and boundaries

Browser inspection captured visible states, accessibility roles, computed styles and already-loaded assets. No messages were submitted to Slack. A synthetic search was submitted to observe the empty-results pane; the transient search view was then cleared. No account credentials or private message content were copied into this repository.

REA **actually ran** through its version-pinned CLI, using the previously acquired Node 24.22.1 runtime. Two static scripts already loaded by Slack were exported through the browser's CDP resource API and analyzed without running their bootstrap code:

| Input                  |   Bytes | SHA-256                                                            |
| ---------------------- | ------: | ------------------------------------------------------------------ |
| Search-in-channel view |  18,075 | `3535921d341f0a72e661bc34a2ad0323d26594563c6f7a7bceaff0da312fee0f` |
| Channel-list view      | 236,317 | `ffb3dfcb76b1473319b591eeb4637232f917206a9c28cf82b6d719de1bdd68ff` |

Evidence ID: `ev_57b28c8c5fa2beaf562b7051257fbac54ab7f53f2e62a7efeb6fba62c670d695`.

REA reported 2 parsed files, 25 module records, 714 extracted findings and no parse failures. These findings are static extraction records, not security vulnerabilities. Graph coverage is **partial**: unresolved cross-chunk imports, dynamic destinations, permissions, server-side search and full application routes remain unknown. The observation of a loaded bundle does not prove every recovered function executed.

Full raw evidence, the source manifest and static inputs are retained outside the repository in `/Users/kai/.codex-artifacts/space-slack-2026-11-03/`. REA MCP registration was unnecessary for this CLI analysis and remains unchanged.

## 1. Chat input composer

The subsequent [standard channel/DM composer pass](slack-composer.md) adds direct REA analysis of the composer/editor modules and supersedes this overview for detailed fidelity and current gaps.

**Observed:** a `contenteditable` element with `.ql-editor` and `.ql-container` classes; 15px type, 22px line height, 8px/12px padding and 38px minimum editable height. There are separate formatting and action rows. Controls cover bold, italic, underline, strike, links, ordered/bulleted lists, quote, inline code and code blocks. The link dialog exposes Text and Link fields. Actions include attachment, formatting visibility, emoji, mention and send; recording and scheduling controls are also visible.

**Implemented:** `RichComposer` uses the public Quill 2.0.3 package with Space's own toolbar and theme. Slack's exact editor package/version has not been established. Selection formatting, edited link labels, lists, quotes, code blocks, emoji, textual mentions, keyboard send and multiline entry work. The UI keeps per-conversation rich-text and attachment-metadata drafts. Send callbacks are serialized; failed submissions retain the editor content.

Messages are represented as bounded text operations with allowed formatting attributes. `RichContent` renders React elements; it does not inject HTML. Only HTTP, HTTPS and mail links are retained. Adjacent code lines and list items are grouped correctly. The existing simpler `Composer` remains available for plain-text examples.

Attachments in this preview are **metadata only** (name, size, type); file bytes are not uploaded, retained or downloadable. Mentions insert local text and notify nobody. Audio/video recording and scheduled delivery are explicitly unavailable. Drafts and demo messages live in memory and reset on reload. Over-limit drafts remain intact for editing even though submission is blocked. The authored 10,000-character send limit is not claimed to be Slack's limit.

Implementation: `packages/ui/src/rich-composer.tsx`, `rich-text.tsx`, `workplace.css`.

## 2. Search

**Observed:** a roughly 780px modal at the top of the workspace, a query combobox with suggestions, keyboard-selection hints, recent searches and quick filters. In-this-channel inserts a styled `in:<channel>` query token. Submitting the synthetic current-channel search opened a separate secondary results pane. Its empty state offers different keywords, typo checks and filter adjustments. More-filter choices include From me, Includes me, Has a link and Threads only.

**Implemented:** a native modal with combobox suggestions, keyboard selection, recent searches, filter chips, result navigation and a separate results pane. Header channel-search seeds the correct channel filter. Supported local syntax:

```text
in:design-system shared
from:"Alex Morgan" "shared language"
from:me has:link
is:thread
https://example.com/design-system
```

Free terms combine with AND; matching is case-insensitive substring matching. Rich-link URLs are indexed even when their visible label differs. Quick filters replace same-kind tokens exactly. Malformed or unsupported filters show an error rather than silently widening a search. Blank input cannot activate invisible suggestions.

These are authored local-search rules over synthetic records. Ranking, stemming, enterprise scopes, Slack authorization and backend search APIs were not reconstructed. Includes-me/activity filters are omitted because this preview has no corresponding data model.

Implementation: `packages/ui/src/search.ts`, `search-dialog.tsx`; results and selection in `apps/web/src/Workspace.tsx`.

## 3. Color tokenizer

**Observed:** Slack has multiple color layers. Root `--dt_color-*` definitions include palette, brand, base and themed values; some root base values remain light even in the current dark UI. The editor's contextual `--sk_primary_background` resolves to `26, 29, 33`, foreground to `209, 210, 211`, and highlight to `29, 155, 209`. Copying the root palette alone would not reproduce the effective component colors.

**Implemented:** the system maintains palette → semantic role → component context. Additional editor/search tokens resolve differently by theme. In dark mode, editor background/toolbar are `#222529`, border `#797c81`, placeholder `#b9babd`, and search background `#1a1d21`. Light values are authored counterparts. Lato and Phosphor remain documented open-source substitutions.

The UI build generates `@space/ui/tokens.json` from the same `tokens.css` used by components, resolving aliases and rejecting unresolved values. The inspector shows **41 color tokens per theme**, supports name/value filtering, copies CSS variable references and exports a theme JSON file. There is no duplicate manually maintained palette file.

Implementation: `packages/ui/src/tokens.css`, `copy-styles.mjs`, `apps/web/src/TokenInspector.tsx`.

## 4. Left sidebar

**Observed:** a separate app rail; workspace header; conversation filter; utility links; Starred, Channels, Direct Messages and Apps groups; collapse state; current conversation; unread indicators; and a resizable boundary. The native width control advertises 180–450px with 10px steps and a current value around 390px.

**Implemented:** `WorkspaceSidebar` provides the named groups, selected/unread states, presence, conversation filtering and collapse/expand. A selected item stays visible when its group is collapsed. Arrow keys move focus between conversation buttons; Enter selects. The separator supports pointer drag plus ArrowLeft/ArrowRight/Home/End within the observed bounds. The full-size preview starts at 390px; mobile uses a dismissible drawer and hides its controls from accessibility navigation while closed. Star/unstar, direct-message selection and local Drafts/Threads indexes work.

Virtualization, sidebar customization menus, real membership and workspace administration remain outside this frontend slice.

## Verification

See [workplace QA](../slack-workplace-qa.md) for command results, browser checks and review fixes. The live preview is `http://127.0.0.1:5173/workspace`; run it with `pnpm web`.

Technical references: [Quill API](https://quilljs.com/docs/api), [Quill Delta](https://quilljs.com/docs/delta), and the installed REA skill. These references inform the reconstruction; they do not establish Slack's internal implementation details.
