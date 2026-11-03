# Slack Files tab comparison

Inspected 2026-11-03 after the user reported that Space's Files UI looked different.

## What the live UI establishes

The signed-in Slack channel's tab settings list `Messages`, `Add canvas`,
`Files & links`, and `Pins`. Files & links is currently hidden. The dialog
explicitly says visibility changes the tabs everyone sees in the channel.
No visibility change was made during the initial inspection. After the user
explicitly approved temporarily showing it, opened the real tab and inspected
each attachment filter and the sort menu, then restored it to hidden.

The actual active channel layout is:

- **Files & links is a top conversation tab** beside Messages and Add canvas.
  Selecting it replaces the main message/composer area. It does not open a
  narrow attachments sidebar.
- A **Search** field spans a centered content column, with `max-width: 1000px`
  and 16px horizontal padding. At the captured approximately 1680px viewport,
  the main channel area is approximately 1220px wide and the search field 968px.
- Below search, a radio group contains **All / Files / Media / Links**. The sort
  button sits at the far right of the same content column. Buttons are
  approximately 28px high. The sort menu contains **Newest** and **Oldest**.
- All displays "No files or links found for this channel." The other filters
  produce their corresponding files/media/links empty messages. There is no
  separate section heading or View all control in this account's active tab.

This channel is empty. No file upload or message was submitted. Populated
file rows, media layout, pagination and viewer interaction were not exercised.
DOM geometry is retained as `live-geometry.json` in the artifact directory below.

![Actual Slack channel Files tab](/Users/kai/.codex/visualizations/2026/11/03/01a1a08d-7f31-73b1-8a25-65404ae51560/slack-channel-files-live.png)

![Media filter](/Users/kai/.codex/visualizations/2026/11/03/01a1a08d-7f31-73b1-8a25-65404ae51560/slack-channel-media-live.png)

The workspace Files destination inspected earlier is a separate surface. Its
search, All / Created by you / Shared with you navigation, Types and sorting
controls should not be treated as the channel Files tab's exact toolbar.

![Hidden setting restored](/Users/kai/.codex/visualizations/2026/11/03/01a1a08d-7f31-73b1-8a25-65404ae51560/slack-files-hidden-restored.png)

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
- An alternate recovered `ResourcesTabView` renders three sections in this order:
  **Files & links**, **Media**, **Recent huddles**.
- Each section has a heading and a **View all** control. Files and media use
  distinct explorer providers and accessible result-list names. Their loading
  placeholders use borderless explorer-list rows.
- Files, media and huddles have separate navigation destinations. Navigation
  code permits channel-file/media views in a secondary pane; this does not
  establish that every Files view occupies the same pane.
- The dispatcher conditionally selects `ResourcesTabView` or another component.
  The live capture establishes that the three-section composition is not this
  account's active Files tab. Its condition remains unresolved. Loaded code alone
  does not prove a path executed; do not use those three sections as the current
  reconstruction target.

## Why Space looks different

Space's current `ChannelFiles.tsx` and `channel-files.css` implement a 390px
right-side panel. It combines images, PDFs and other files into one list, uses
48px thumbnails, displays Preview / Download / View message links on every row,
and places filename search and native type/sort selects above the list.

That implementation was a Space adaptation of Slack's file-discovery behavior.
Its placement, width and controls differ from the observed channel tab. Space
also lacks a link index; a working Links filter requires a separate data path.
The prior functional tests establish Space's behavior, not visual parity.

To match the observed shell, render Files & links as the main conversation tab,
use the centered search/results column, place All / Files / Media / Links at
the left and Newest / Oldest at the right, and reproduce the observed empty
states. A separate media filter can group existing image/audio/video metadata;
the exact Slack classification of all MIME types remains unverified.

Keep the existing authorized asset API, bounded thumbnails,
pagination and shared viewer; those do not require a particular panel layout.
Do not claim populated row geometry, media-grid behavior or exact preview
placement from an empty results screen or from loading skeletons.
