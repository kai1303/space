# Slack Files tab comparison

Inspected 2026-11-03 after the user reported that Space's Files UI looked different.

## What the live UI establishes

The signed-in Slack channel's tab settings list `Messages`, `Add canvas`,
`Files & links`, and `Pins`. Files & links is currently hidden. The dialog
explicitly says visibility changes the tabs everyone sees in the channel.
No visibility change was made during the initial inspection. A focused direct
navigation returned to Messages, so it did not establish a live Files layout.

The workspace Files destination inspected earlier is a separate surface. Its
search, All / Created by you / Shared with you navigation, Types and sorting
controls should not be treated as the channel Files tab's exact toolbar.

![Current Slack tab settings](/Users/kai/.codex/visualizations/2026/11/03/01a1a08d-7f31-73b1-8a25-65404ae51560/slack-files-hidden-current.png)

## Shipped code evidence

Exported already-loaded public scripts through the browser's resource API.
Original resources, SHA-256 manifest, AST module ranges and analysis are retained
outside the repository at
`/Users/kai/.codex-artifacts/space-slack-files-tab-2026-11-03/`.
No Slack implementation source was copied into Space.

REA 6.8.0 analyzed four inert module wrappers (159,441 bytes), parsed all four
without failures and visited 47,393 AST nodes. Evidence:
`ev_0374be1de28017f4b6b6be201163e428f8f53056c960c04b0d1f54181973cad0`.
Its 614 extraction findings are structural records, not vulnerabilities.
Semantic coverage is partial, including 10,811 unknowns and a per-file node
ceiling. Two additional navigation modules were extracted afterward and read
directly; they were not part of that REA run.

- The canonical conversation tab ID is `files`.
- The recovered `ResourcesTabView` renders three sections in this order:
  **Files & links**, **Media**, **Recent huddles**.
- Each section has a heading and a **View all** control. Files and media use
  distinct explorer providers and accessible result-list names. Their loading
  placeholders use borderless explorer-list rows.
- Files, media and huddles have separate navigation destinations. Navigation
  code permits channel-file/media views in a secondary pane; this does not
  establish that every Files view occupies the same pane.
- The dispatcher conditionally selects `ResourcesTabView` or another component.
  The condition and the current account's populated layout have not yet been
  resolved. Loaded code alone does not prove a path executed.

## Why Space looks different

Space's current `ChannelFiles.tsx` and `channel-files.css` implement a 390px
right-side panel. It combines images, PDFs and other files into one list, uses
48px thumbnails, displays Preview / Download / View message links on every row,
and places filename search and native type/sort selects above the list.

That implementation was a Space adaptation of Slack's file-discovery behavior.
It is not a faithful reconstruction of Slack's channel-tab composition. It
omits separate media and files/link sections and their View all navigation.
It also does not implement a link index or huddle history. The prior functional
test results establish Space's behavior, not visual parity with Slack.

Before changing layout, capture the actual channel tab and its drilldown in
this account. Keep the existing authorized asset API, bounded thumbnails,
pagination and shared viewer; those do not require a particular panel layout.
Do not claim populated row geometry, media-grid behavior or exact preview
placement from an empty results screen or from loading skeletons.
