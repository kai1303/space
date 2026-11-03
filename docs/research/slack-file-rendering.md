# Slack file rendering research

Date: 2026-11-03. User requested reverse engineering Slack file rendering and fixing Space's download-only attachments.

## Evidence and boundaries

Opened a separate tab in the existing signed-in Slack browser profile, preserving the tab used by another task. Inspected the Files navigation and its empty results state. No files were uploaded and no messages were submitted to Slack. The workspace had no files available for a live media-preview interaction; media behavior below comes from the shipped JavaScript and official documentation, not a claim that every path executed.

Exported two already-loaded public JavaScript resources through the browser CDP resource API. The main shared bundle was 15,794,365 bytes with SHA-256 `99402e5748575d853aac121a2ee85345a56bea3a30951b1faf6ee18f426faf90`. The Files view bootstrap was 251 bytes with SHA-256 `dfb78491f79ab2db5258863c081a7099643b8eca80a60f9e13b129b17baa92bc`.

Selected 22 actual Rspack module factories by AST ranges around file preview, thumbnail, snippet and viewer markers. The inert wrappers total 169,087 bytes. The retained provenance records each module ID, parent source range, marker and SHA-256. Slack bootstrap code was never executed by the analyzer and no proprietary source was copied into this repository.

REA 6.8.0 actually ran through its CLI using the existing Node 24.22.1 runtime. Its MCP server was not registered in this session, so no client configuration was changed. Evidence ID: `ev_bba9f4b871e23b11523bb1435e350c85cfc7e0a3e215427ccb9e9c528b832584`. It parsed all 22 files, visited 47,535 AST nodes and returned 659 static extraction findings with no parse failures. These are structural extraction records, not vulnerabilities. Cross-chunk imports and dynamic behavior remain partially unresolved; the semantic graph retains 10,507 unknowns. A loaded module is not proof that every function executed.

Full original inputs, manifest, extraction/provenance, complete REA evidence, summary and progress log are retained outside the repo at `/Users/kai/.codex-artifacts/space-slack-file-render-2026-11-03/`.

## Recovered behavior

- `k0sI`: message file preview routing separates image, document, snippet, audio and video rendering. The video path uses a poster/placeholder, switches into playback on activation, tracks playback state and bounds its displayed height. Image attachments have separate image actions.
- `LN+9`: document previews select larger thumbnails or PDF thumbnails. Missing/deleted files get explicit states. Image aspect ratio influences cover treatment.
- `NXVp`: file thumbnail rendering chooses image/video/document representations and has icon fallback paths.
- `XO7K`: snippets support truncated and expanded content, opening a viewer and plain-text copy behavior. Space implements this with escaped React text and its existing CodeBlock, not Slack's internal HTML preview mechanism.
- `gxDu`: the shared file viewer has MIME-specific image/PDF/video paths, zoom interaction controls, optional previous/next navigation and a filmstrip. It distinguishes full preview data from original download URLs.

Cost-focused follow-up: `gxDu` accepts `cachedRawDataURL`, `fullSizePreviewURL`
and `isRangeRequestEnabled`, passing the range flag into its PDF renderer. The
range flag defaults to false in this wrapper, so this is evidence of an optional
range path, not proof that all Slack PDFs use range requests. `cachedRawDataURL`
is an input override, not evidence of a particular cache eviction algorithm.
The official [file object](https://docs.slack.dev/reference/objects/file-object/)
also exposes separate thumbnail sizes and private original/download URLs.

Space applies these distinctions with bounded WebP derivatives, one shared
derivative for tiny static images, reused filmstrip metadata, and an authenticated
PDF.js custom range transport. It retains fresh selected-viewer access checks
and avoids a global private-file cache. The installed PDF.js transport matches
the [official API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html):
disabling automatic prefetch also requires disabling streaming. See
[asset cost controls](../architecture/assets.md#cost-controls) for actual local
transfer measurements and their limits. These implementation choices are authored
adaptations, not recovered Slack storage or billing infrastructure.

These observations support a separate thumbnail/card representation and full viewer, with a download fallback. They do not establish Slack's private conversion workers, storage infrastructure, exact library versions, malware-scanning implementation or all supported codecs.

## Space implementation

SeaweedFS holds immutable originals and generated raster derivatives. The API classifies actual file bytes, persists preview metadata, and authorizes metadata/content/thumbnail access with the existing channel membership rules. Images use metadata-stripped WebP derivatives; GIFs retain validated animation. PDF rendering uses bundled PDF.js canvas pages. UTF-8 source files use bounded, escaped text. Common audio/video containers use browser media controls. Office documents, archives, unknown formats, decode failures and unsupported browser codecs retain an original download fallback.

The implementation does not execute uploaded HTML/SVG, use Slack's source code, expose storage credentials or make the bucket public. Office conversion, video transcoding and media transcripts are outside this first renderer.

References: [Slack file object](https://docs.slack.dev/reference/objects/file-object/), [adding files](https://slack.com/help/articles/201330736-Add-files-to-Slack), [file access](https://docs.slack.dev/messaging/working-with-files/), [Sharp limits](https://sharp.pixelplumbing.com/api-constructor/), [PDF.js rendering examples](https://mozilla.github.io/pdf.js/examples/).


## Local verification

The actual API/SeaweedFS suite covers image derivatives, PDF bytes, escaped source,
audio/video metadata, unsupported fallbacks, original-byte downloads and private
access. Browser QA used synthetic files in an isolated schema: a generated image
loaded with fit/zoom, a two-page PDF rendered to canvas with page navigation and
125% zoom, source text appeared escaped, and WAV/MP4 metadata loaded with duration
and no media error. A 390×844 PDF viewer had matching 390px client/scroll widths.
The PDF test initially exposed a missing-CORS-header failure on a redirected fetch;
serving bounded PDF bytes through the authorized API resolved it. Short media
fixtures do not establish long-duration playback after URL expiry or every codec.

## Channel file UI follow-up

2026-11-03 review snapshot, before the channel Files implementation below: checked the Space source and opened separate reference tabs
in the existing authenticated browser profile, preserving other tasks' tabs.

1. **Space: file rendering is implemented; channel browsing is missing.**
   `apps/web/src/Chat.tsx` renders `AssetAttachments` per message. The component
   provides cards and the shared image/PDF/text/media viewer. Channel navigation
   currently contains Messages and Memory; its right SidePanels are thread and
   search. There is no channel-wide Files/Attachments tab or paginated asset-list
   route in `apps/server/assets.ts`. The existing reservation POST is not a file
   listing endpoint. A live Space tab intermittently reached its shell but stayed
   in session/workspace loading during this check, so the missing-tab conclusion
   is verified from owning source rather than a complete live Space UI audit.
2. **Slack: channel files belong to a conversation tab.** Opened channel details
   -> Tabs. The actual Manage tabs UI contains Messages, Add canvas, Files & links
   (Hidden in this channel), and Pins (Hidden). Did not change visibility, since
   that control affects what everyone in the channel sees. Current official help
   directs users to Files & links at the top of a channel/DM, not a permanent right
   attachments sidebar.
3. **Slack: a separate Files destination supports workspace browsing.** Opened
   Files from the left rail. Observed search, All/Created by you/Shared with you,
   Types (including PDFs and Images), Sort: Recently viewed, Filters, Starred,
   Canvases and Deleted. Temporarily included Images alongside existing filters,
   observed the empty result state, and restored the original type selection.
   Populated file rows, file actions and current file-viewer placement were not
   exercised because this filtered reference view returned no files. Empty results
   alone do not prove the entire workspace contains no files.

Accepted captures:

![Slack channel tab configuration](/Users/kai/.codex/visualizations/2026/11/03/01a1a08d-7f31-73b1-8a25-65404ae51560/slack-file-tabs-settings.jpg)

![Slack file type filters](/Users/kai/.codex/visualizations/2026/11/03/01a1a08d-7f31-73b1-8a25-65404ae51560/slack-files-type-filters.jpg)

Recommended Space continuation: a visible Files entry for channel-wide discovery,
backed by an authorized paginated list that includes thread attachments. Show
image thumbnails and document rows, file-type filtering, uploader/date, download
and source-message navigation; reuse the existing viewer and bounded derivatives.
Opening this list in Space's right sidebar would be an authored layout adaptation,
not a claim that Slack uses that same placement. Do not derive the complete list
only from messages already loaded in the browser or fetch every original just to
populate the panel. Accessibility testing of a new panel remains implementation
work; this check does not establish keyboard or screen-reader compliance.

Reference: [Slack: adding and finding files](https://slack.com/help/articles/201330736-Add-files-to-Slack).

## Implemented channel Files UI

Visual comparison correction: a later user-approved inspection opened the actual
channel Files & links tab. It occupies the main conversation area and uses
All / Files / Media / Links filter buttons, centered search and Newest / Oldest
sorting. The right-side layout below is a Space adaptation and does not match
that observed shell. See [the live capture and comparison](slack-files-tab.md).

The user approved the continuation above. Space now has the Files navigation
button, responsive right-side file browser, server-side filename/kind filters,
share sorting and pagination, uploader/date metadata, preview/download and source
navigation. It includes thread and older attachments without scanning loaded
history. The existing viewer remains shared and authorized; the panel does not
fetch originals just to show rows. The right-side placement is the approved Space
adaptation of Slack's conversation Files tab.

An independent review and 346-test full run passed. Browser verification used an
isolated production bundle and real API/PostgreSQL/SeaweedFS, including image/PDF
views, pagination, old sources, exact-byte download, live refresh, narrow layout
and membership revocation. See [the implementation and evidence](../architecture/assets.md#channel-files-browser).

![Space channel Files sidebar](/Users/kai/.codex/visualizations/2026/11/03/01a1a08d-7f31-73b1-8a25-65404ae51560/channel-files-desktop.jpg)

![Space channel Files on mobile](/Users/kai/.codex/visualizations/2026/11/03/01a1a08d-7f31-73b1-8a25-65404ae51560/channel-files-mobile.jpg)
