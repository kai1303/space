# Slack workplace interaction slice

User-selected scope: continue reverse engineering the chat composer, search, color tokenization and left sidebar. Extend the existing system with reusable components and a full-size local `/workspace` preview, preserving the gallery at `/`.

## Evidence

Direct browser observation on 2026-11-03: composer is a `contenteditable` `.ql-editor` with 15px/22px type, 8px/12px padding, minimum 38px content area. Toolbar offers bold, italic, underline, strike, links, ordered/bulleted lists, quote, inline code and code blocks. Link dialog has Text and Link fields. Bottom row includes formatting visibility, attachments, emoji, mentions and send. Search opens a 780px modal near the top, has keyboard selection and quick filters; selecting current-channel filter inserts an `in:<channel>` token. Enter on a synthetic query opens a secondary results pane; the observed empty state says nothing turned up. Sidebar has rail, workspace header, conversation filter, utility links, collapsible Starred/Channels/Direct Messages/Apps, selected row, unread state and adjustable width (180–450, step 10).

Computed root `--dt_color-*` variables include base/brand/theme palettes that do not necessarily equal a component's effective dark colors. The editor-scoped `--sk_primary_background` is 26,29,33 and `--sk_primary_foreground` is 209,210,211. Preserve palette/semantic/context distinctions rather than flattening the root palette into a theme.

REA 6.8.0 CLI actually analyzed two browser-exported, already-loaded static assets (search-in-channel view and channel-list view), not application source. Evidence ID `ev_57b28c8c5fa2beaf562b7051257fbac54ab7f53f2e62a7efeb6fba62c670d695`: 254392 bytes, 2 parsed files, 25 modules, 714 findings, no parse failures; graph coverage partial. Bootstrap code was never executed. Cross-chunk imports, server search, permissions and complete application behavior remain unknown. Raw assets/evidence stay in `/Users/kai/.codex-artifacts/space-slack-2026-11-03`, outside the repository.

## Implementation

- Shared `RichComposer`: Quill 2 chosen as an implementation dependency (Slack's exact version is unknown), custom Slack-like toolbar and action rows, real text selection/formatting, safe link dialog, lists/quote/code, emoji and mentions, local file metadata chips, undo/redo via editor history, Enter/Shift+Enter/IME handling and pending/failure behavior. Safe structured text operations and a React renderer preserve formatting without injecting HTML. Audio/video/scheduling are outside the executable scope.
- Shared search: native modal with query combobox, keyboard suggestions, quick filters and a separate results pane. Pure local matching supports quoted terms, `in:`, `from:`, `has:link`, `is:thread`; unsupported syntax is explicit. Search synthetic records only. No claim to Slack's server ranking or authorization.
- Shared sidebar: channel/person/app groups, collapse/expand, conversation filter, unread and presence, selected item, keyboard focus navigation and pointer/keyboard resize.
- Token inspector: searchable semantic token table with resolved values, role descriptions, clipboard copy and JSON download. Distinguish authored theme values from source observations. Add context tokens for editor/search/sidebar, not a second duplicated color source.
- Workspace preview: synthetic channels/messages, rich sent messages, local attachment metadata, per-channel draft restoration, searches across synthetic messages/channels, result navigation and theme switching. The four requested features are the primary deliverables; no backend, Slack writes or production auth.

## Checks

Test query parsing/filtering, unsafe link rejection and structured text normalization; sidebar collapse/filter/resize; rich-text rendering; draft isolation/restoration. Browser-test real Quill selection/formatting, link validation, emoji/mentions, attachment metadata, sending, IME/Shift+Enter boundaries, search filters/results/empty state and keyboard modal controls. Inspect desktop/mobile and both themes. Run UI tests and monorepo typecheck/build. Capture screenshots and document observations separately from implementation choices.
