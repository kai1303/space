# Slack Files comparison and Space implementation

Space now has a usable file library with server-side search and filters, personal stars, view history, file details, previews, downloads and links to the source message. The design follows the authenticated Slack Files hub observed in Brave on 2026-11-04, while retaining Space's theme and attachment model.

## UI comparison

| Area | Slack observed in Brave | Space before | Space now |
| --- | --- | --- | --- |
| Navigation | All files, Canvases, Deleted, Starred | Similar labels, with unavailable destinations | All files and working Starred; unsupported destinations removed |
| Results | Compact rows with an icon, title, metadata and action menu | Attachment collection cards | Compact rows with thumbnails/type icons, uploader, conversation, date and actions |
| Search and ownership | Search and All / Created by you / Shared with you | Search over loaded pages | Search across authorized files; matching ownership controls |
| Filtering | Type multiselect; From, In and Date dialog | Loaded-page type filter | Custom checkbox type menu with server-side combined types, person, conversation and inclusive date-range filters |
| Sorting | Recently viewed and Last updated | Loaded-page chronological sort | Recently viewed, Newest shared and Oldest shared across the result set |

The source was [Slack's authenticated Files hub](https://app.slack.com/client/T0F6QDEJD/unified-files). This workspace showed a Slackbot canvas template and a free-trial banner. Its menus and available file categories may vary by plan or rollout. The upgrade banner is not part of Space's implementation.

## Behavior comparison

Search and filters apply before pagination, so files beyond the loaded page can be found. Changing a filter resets the result cursor and cancels outdated reads. Filter-dialog changes apply on Done; Clear filters resets the selection. Date ranges include the entire selected end day in the browser's local timezone.

Stars are personal, persist on the server and appear in Starred only after the server confirms the write. Recently viewed uses personal view timestamps, falling back to the sharing timestamp for unviewed files. Preview navigation retains the initial result order while history updates, and a later preview is recorded after an in-flight history write finishes. The latest pending preview is retained; this is not a log of every transient selection.

Preview opens the existing shared attachment viewer. File details expose the filename, uploader, conversation, sharing date, MIME type and byte count. View message opens the original message, and Copy message link creates an access-controlled conversation deep link. Downloads use the existing authorized asset endpoint.

## Functional scope and remaining differences

| Capability | Implementation |
| --- | --- |
| Accessible shared files | Ready attachments on ordinary messages in conversations the viewer can access |
| Search | Case-insensitive filename search with literal wildcard characters; no file-content search |
| Personal organization | Persistent per-user stars and view history, isolated by workspace and actor |
| File types | Images, PDFs, text/snippets, audio, video and other files; multiple types can be selected together |
| Paging and refresh | Keyset paging; 24 rows per page, at most 240 loaded rows; existing event subscriptions and reconnect recovery |
| Directory filters | User-triggered directory paging, up to 500 choices per selector |
| Access changes | Server authorization on reads/writes; revoked subscriptions clear results, previews and open filter details |
| Canvases and lists | No collaborative document/list editor in this Files module |
| Deleted | No document trash or restoration; Slack's observed Deleted screen specifically described canvases and lists |
| Slack date shortcuts | Custom date range instead of Slack's presets |
| Last updated | Uses sharing time because Space's attachments are immutable; no document revision model |

Slack's observed canvas-template menu included saved items, to-dos, details and split view. Space's uploaded-attachment actions are an adaptation; Slack's ordinary uploaded-file preview was not exercised in this workspace.

## File type dropdown reconstruction

The live Slack dropdown was inspected again in Brave on 2026-11-04. These are DOM/computed-style and interaction observations, not recovered original source. REA tools were absent; its diagnostic reported incompatible Node 25.2.1 and registration drift. No REA/client configuration was changed.

| Observed Slack behavior or measurement | Space implementation |
| --- | --- |
| 280px menu width; 32px rows; 12px vertical panel padding | Same dimensions, with viewport width/height limits |
| 4px corners; dark surface `#212428`; subtle outline and shadow | Same dark surface and geometry; light-theme surface uses Space tokens |
| 15px Lato text; 16px checkmark and 20px type icon | Shared `MultiSelectMenu` uses those dimensions with local icons |
| Selected rows use `#1d9bd1` in the dark theme | Same selected color; visible hover and keyboard focus states |
| Trigger shows `0 Types`, `1 Type`, or the selected count, even when all types are selected | Count-based trigger for Space's six attachment categories |
| Toggling checkboxes applies immediately without closing | Matching behavior; combined types are ORed on the server before pagination |
| Reset Filters appears when the selection differs from the default, restores defaults, and leaves the menu open | Restores all six Space types while retaining search and other filters; restores keyboard focus to the first row |
| Escape closes and returns focus to the trigger | Existing Popover provides Escape, outside dismissal, arrows, Home/End and Tab; the checkbox component adds text typeahead |

Slack's observed default was six selected categories out of eleven. Space defaults to all six supported attachment categories; it does not advertise canvases, lists, skill sets or external document integrations as working file types. This is the intentional data-model adaptation. The sort and directory selectors retain their existing controls.

`kinds=image,pdf` selects both types, `kinds=` selects none, and omission selects all. The API still accepts legacy `kind=pdf` callers. Unknown, duplicate or oversized lists and simultaneous `kind`/`kinds` parameters are rejected. No database migration is needed for this dropdown update. A ResizeObserver repositions floating menus when a newly visible reset row changes their size; it does not fetch data or poll resources.

## Storage and authorization

Migration `042_file_library.sql` adds `hub_file_state`, keyed by workspace, user and asset, with the existing durable resource-delivery trigger. Atomic star/view upserts update only their respective fields so simultaneous actions preserve both values. No recurring resource polling, explicit database locks or distributed locks were added. PostgreSQL's normal transactional write locks still apply.

Reads preserve timestamp microseconds in keyset cursors. Filtering and state writes reuse current workspace/channel access checks, and internal agent-session messages are excluded. No production throughput claim is implied by the local tests.

## Verification

Brave E2E testing used a separate local Files E2E account/workspace and synthetic text/image files. Verified upload and send, list appearance, filename search, type/ownership filters, From/In/inclusive dates, starring and reload persistence, Starred navigation, text/image previews, recent ordering, file details, original-message opening and downloading. The downloaded PNG matched its source byte for byte. Copy message link showed success; clipboard round-trip was not verified.

Component tests cover stale reads, filter application, persistent stars, failed writes, access revocation, preview navigation during a pending write and the existing attachment viewer. API integration coverage verifies filtering before pagination, literal search characters, personal state, concurrent star/view writes, authorization, chronological fallback and cursor boundaries.

The dropdown's shared UI run passed seven tests across `multiselect-menu.test.tsx` and `popover-motion.test.tsx`; Files and attachment components passed another 31 tests. The complete `workspace-hub.test.ts` integration run passed all 15 tests, including multiple-type pagination and empty selections. Its revocation fixtures transfer primary ownership before deactivating the former owner, preserving the current workspace ownership constraint. Contracts, Postgres, server and web builds passed, including the web typecheck.

The updated dropdown also passed Brave checks for combined image/text results, a single type, zero selected types, reset without closing, keyboard typeahead and Space selection, Escape focus return, and outside-click dismissal. Live computed styles matched the observed Slack width, row height, padding, font size, corner radius, dark surface and selected color.

```sh
pnpm --filter @space/web exec vitest run src/WorkspaceCollections.test.tsx src/AssetAttachments.test.tsx
pnpm --filter @space/ui exec vitest run src/multiselect-menu.test.tsx src/popover-motion.test.tsx
# With TEST_DATABASE_URL set for the local test database:
pnpm --filter @space/tests exec tsx --test integration/workspace-hub.test.ts
pnpm --filter @space/web build
```

The browser checks ran against a local built preview at port 5174 to avoid concurrent development-server reloads. Migration 042 was applied locally. This change has not been deployed to production.
