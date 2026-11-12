# Chat asset storage

Static chat files are stored in a private SeaweedFS bucket. PostgreSQL owns file
metadata, chat scope and access decisions; SeaweedFS owns bytes. Files do not pass
through the API request body. The adapter uses the AWS S3 SDK against the pinned
`chrislusf/seaweedfs:4.52` image.

## Local setup

```sh
docker compose up -d postgres redis seaweedfs
# Export .env.example values in the shell running `pnpm server`.
# Both host-run storage endpoints are http://127.0.0.1:8333.
pnpm migrate
pnpm server
pnpm web
```

Configure all six variables, or unset all six to disable uploads:

| Variable | Purpose | Local host-run value |
| --- | --- | --- |
| `ASSET_STORAGE_ENDPOINT` | API-to-S3 URL | `http://127.0.0.1:8333` |
| `ASSET_STORAGE_PUBLIC_ENDPOINT` | Browser-to-S3 URL used in signatures | `http://127.0.0.1:8333` |
| `ASSET_STORAGE_BUCKET` | Private bucket | `space-assets` |
| `ASSET_STORAGE_ACCESS_KEY` | Server credential | `space_local_dev` |
| `ASSET_STORAGE_SECRET_KEY` | Server credential | `space_local_dev_secret` |
| `ASSET_STORAGE_ORIGINS` | Exact allowed frontend origins, comma separated | `http://127.0.0.1:5173,http://127.0.0.1:5174` |

The displayed credentials are local development defaults. Use separate generated
credentials for a deployment. The API rejects partial configuration at startup.
Turbo forwards these variables to server `dev` and `start` tasks. Vite must never
receive storage credentials.

Compose sets the API's internal endpoint to `http://seaweedfs:8333` and preserves
the browser endpoint separately. Its health check waits for master readiness and
the S3 listener before starting the API. API startup ensures the bucket exists
and installs CORS for the configured frontend origins. This API owns that bucket's
CORS configuration; use a dedicated bucket.

## API

| Method and path | Behavior |
| --- | --- |
| `GET /v1/assets/config` | Returns `enabled`, `max_file_size` and `max_files` for the composer. |
| `POST /v1/channels/:channelId/assets` | Reserves an authorized channel upload and returns `AssetUpload`, including its signed POST form. |
| `POST /v1/assets/:assetId/complete` | Accepts `{}`, verifies and seals the stored bytes, then returns file metadata. |
| `GET /v1/assets/:assetId/download` | Checks current chat access and redirects to a signed attachment URL valid for 60 seconds. |
| `GET /v1/assets/:assetId/preview` | Returns byte-validated preview metadata; legacy attachments use an atomic processing claim. |
| `GET /v1/assets/:assetId/content` | Returns PDF bytes on the authenticated API origin for canvas rendering; redirects validated image/media representations to short-lived signed URLs. |
| `GET /v1/assets/:assetId/thumbnail` | Authorizes and redirects to a generated WebP image thumbnail. |

Each file is limited to 25 MiB; a message accepts at most five files. Reservation
allows at most 20 unattached files per workspace and uploader. File metadata and
attachment references are persisted by migration `009_assets.sql`.

## Upload and download behavior

1. An authenticated caller reserves a file in a specific chat scope. The server
   generates the object key and records expected size and original display name.
2. The browser sends a multipart form directly to SeaweedFS using a signed POST
   valid for at most five minutes and never beyond the stored reservation deadline.
   Signing reserves a one-second margin and refuses an expired or nearly expired
   reservation with `410 upload_expired`. The policy permits only the generated staging key,
   exact reserved byte count and `application/octet-stream`. Files must contain
   between 1 byte and 25 MiB. The file is the last multipart field.
3. Finalization claims the asset with an atomic conditional update, then releases
   the database connection. It checks staging `HEAD`, reads at most 25 MiB with
   `If-Match` bound to the staging ETag, and seals the server-only final key using
   `If-None-Match: *`. Existing sealed bytes are reused, never overwritten on retry.
   Final metadata is `application/octet-stream` and `Content-Disposition: attachment`.
   The final length is verified; browser credentials cannot overwrite the final key.
4. Messages refer to file IDs and metadata. A file is available only after
   finalization and attachment through the authorized chat scope.
5. The API checks current access before issuing a signed GET valid for 60 seconds.
   Downloads use attachment disposition, a safely encoded filename and
   `application/octet-stream`. Anonymous object reads are forbidden.

A missing staging object produces `409 upload_not_ready`; size
validation failures produce `409 invalid_upload`. Provider failures produce
`503 storage_unavailable`, without provider credentials or response details.
Deleting an absent object succeeds.

A signed URL is a bearer capability until it expires. Access changes prevent new
URLs from being issued; an already issued URL remains usable for at most 60
seconds. Files download as attachments; the application does not render uploaded
HTML, SVG or arbitrary documents inline.

## Self-hosting and persistence

Compose runs `weed mini -dir=/data` with the named `seaweedfs_data` volume. Master,
volume and filer data, including filer metadata, live beneath `/data`. Only the
S3 gateway is published, on `127.0.0.1:8333`; the master, filer and administration
ports are not published. WebDAV, the admin UI and extra catalog endpoints are
disabled.

For remote browsers, place only the S3 gateway behind an HTTPS reverse proxy and
set `ASSET_STORAGE_PUBLIC_ENDPOINT` to that exact externally reachable origin.
Preserve the original host and signature-bearing query parameters through the
proxy. Configure exact HTTPS frontend origins. SeaweedFS documents its
`-s3.externalUrl` option for reverse proxy signature handling; validate signed
POST, signed GET and preflight from the actual deployment origin. Keep internal
filer, volume, master and administration interfaces private.

Back up **both PostgreSQL and the whole SeaweedFS `/data` volume**. A metadata-only
backup cannot restore file bytes. Stop writes or use coordinated snapshots before
copying the volume, retain matching database backups and test restores. This
single-node Compose service has no replica or failover.

The API runs cleanup every 60 seconds in batches of 20. Unattached reservations
expire after 24 hours; cleanup deletes their staging object, final object and
database row. Once an asset is ready or attached, its staging object is removed
after the five-minute upload credential expires. Attached final objects are kept
indefinitely. Cleanup depends on the API running and storage being available;
monitor failed cleanup and disk usage. Do not delete final objects solely because
they appear old without checking database references.

Migration 024 adds processing tokens and deadlines. Completion, preview generation,
PDF conversion and cleanup use 30-second claims renewed every five seconds. All
storage calls run outside transactions; metadata publication/release is fenced by
the claim token. Expired claims can be recovered after a crash. Contending requests
poll for at most 15 seconds without reserving a connection; overload returns
`503 asset_processing_busy`. At most four asset jobs per API pool buffer/copy/decode
bytes concurrently. Access is rechecked after storage work. Upload admission retains
its short database-only transaction for quota enforcement.

## Verification

`pnpm --filter @space/server test` checks signed policy constraints, configuration,
filename safety, conditional finalization and sanitized failure mapping.

Run `pnpm --filter @space/server test:storage` with all six local
`ASSET_STORAGE_*` values exported for the reproducible SeaweedFS integration test.
It uses random object keys and cleans them up. It verifies signed POST, exact size
and key rejection, conditional copy, immutable final bytes after staging overwrite,
anonymous read/list/write denial, safe attachment downloads and allowed/disallowed
CORS preflights. It bootstraps the configured bucket and replaces its CORS, so use
a dedicated local test bucket. This is local verification; remote TLS/proxy
configuration and disaster recovery remain operator checks.

References: [SeaweedFS mini quick start](https://github.com/seaweedfs/seaweedfs/wiki/Quick-Start-with-weed-mini)
and [supported S3 operations](https://github.com/seaweedfs/seaweedfs/wiki/Amazon-S3-API).

With `TEST_DATABASE_URL` and all six `ASSET_STORAGE_*` variables exported, run
`pnpm test:assets` for the PostgreSQL authorization/lifecycle suite and a real
API-to-SeaweedFS upload, completion, message, history and download check. This
suite uses random database schemas and object keys and cleans them up. Ordinary
`pnpm test` runs the asset contract and API tests without requiring SeaweedFS.

Local browser verification on 2026-11-03 used an isolated QA schema, Better Auth,
the real Vite frontend and SeaweedFS: file selection reached Ready, an attachment-only
message sent, history survived reload, and downloading returned identical bytes.
The QA schema and files were removed afterward. This does not verify a remote
HTTPS reverse proxy or backup restoration.


## File previews

Run `pnpm migrate` before starting the updated API: migration `010_asset_previews.sql`
adds nullable preview metadata without rewriting existing message history.
Completion generates previews after the original is sealed; existing attachments
are generated on first preview request. All three preview routes enforce the
same current channel membership and uploader-only rules for unattached files as
the original download endpoint.

### Channel Files browser

The channel's **Files** button opens a right sidebar beside Messages on wide
screens. Below 1150px it uses the conversation area, with a close button and
Escape to return to messages. Closing returns focus to Files and preserves
unsent message/upload drafts. Files, thread and message-search panels are
mutually exclusive. The panel includes filename search, file-type filters,
newest/oldest share ordering, lazy thumbnails, uploader/date/size, pagination,
refresh, previews, original downloads and source-message navigation.

`GET /v1/channels/:channelId/assets` accepts `q`, `kind`, `sort`, `limit` and
`after`. Kinds are `all`, `image`, `pdf`, `text`, `audio`, `video`, `other`;
sort is `newest` or `oldest`; the default page is 30, maximum 100, and the UI
requests 24. `q` is a literal, case-insensitive filename match, maximum 255
characters. `%`, `_` and backslashes are escaped rather than treated as search
operators. `after` is the preceding page's asset UUID. Responses contain
`items` and `next_cursor`; rows add `preview_kind`, `message_id`, `thread_id`,
`shared_at` and uploader ID/name to the basic attachment metadata.

Only ready assets already attached to messages appear. Thread replies and older
history are included independently of the browser's loaded messages. Cursor
ordering uses message share time plus asset UUID and retains PostgreSQL timestamp
precision. The cursor anchor is channel-scoped. Every request checks current
channel/workspace membership using read-only queries, including during storage
outages. Rows exclude storage keys, signed URLs and full text-preview bodies.
Listing does not generate previews or read file objects. Null legacy preview
metadata appears as Other until the existing authorized preview path classifies
the file. Thumbnails and selected previews load separately and remain protected.

Migration `015_channel_files.sql` adds a partial channel/message asset index.
Apply migrations through the normal `pnpm migrate` command, rebuild/restart the
API and update the frontend bundle. Existing asset lifecycle and preview
migrations are still prerequisites.

The panel reuses the existing image/PDF/text/media viewer, including fresh access
checks when opening or changing files. Filmstrip thumbnails are lazy. Incoming
attachment messages refresh an open list; if a preview is open, refresh waits
until it closes so it does not interrupt reading. A source already in loaded
history is scrolled to and focused; an older source opens the authorized original
message view. A missing source rechecks channel access before clearing drafts,
so an invalid source link alone does not revoke an otherwise valid conversation.
Known access loss clears the list, viewer, source dialog, cached history and
in-flight history responses and stops the subscription.

Verification on 2026-11-03: the repository suite passed **346 tests**, plus
typecheck/build. The isolated production-bundle browser check used Better Auth,
PostgreSQL and real SeaweedFS with 29 attached files, an excluded unattached file,
thread attachments and sources beyond the initial 100 history events. It verified
24-to-29 pagination without duplicates, sorting/search/type filters, empty states,
image zoom, two-page PDF navigation/zoom, a byte-identical browser download,
loaded/older source navigation, live refresh without interrupting a PDF, draft
preservation, channel switching, keyboard focus and Escape. At 390×844, client
and scroll widths were both 390px; the panel fit the available 338px beside the
52px rail. Removing the test member while a viewer was open cleared all private
UI; the original download then returned `not_found`. API tests additionally prove
read-only listing while writers hold workspace/channel locks and precise tied-time
pagination. Test workspaces, objects, temporary server and browser tabs are cleaned
after verification. Evidence is retained under
`/Users/kai/.codex-artifacts/space-channel-files-2026-11-03/`.

| File | Display |
| --- | --- |
| JPEG, PNG, WebP, AVIF | Metadata-stripped WebP thumbnail and display image, with fit/zoom in the viewer. Images fitting 360×240 share one display object. |
| GIF | First-frame WebP thumbnail and original animation after bounded decoding. |
| PDF | Locally bundled, lazily loaded PDF.js canvas with page navigation and zoom. |
| UTF-8 text/code | Escaped source with syntax highlighting and a bounded inline snippet/full preview. HTML and SVG stay source text. |
| Recognized audio/video | Browser-native playback controls; unsupported codecs retain the original download. |
| DOCX, XLSX, PPTX, ODT, ODS, ODP | Read-only ONLYOFFICE viewer when configured. |
| Archives, unknown/corrupt files | Explicit unavailable preview and original download. |

Kinds come from file bytes; the upload's declared MIME type does not grant inline
rendering. Image decoding caps total pixels at 40 million and frames at 500;
images outside these limits keep a download fallback. Thumbnails fit inside
360×240; display images fit inside 1600×1200, without enlargement. Generated keys
are `previews/:id/thumbnail.webp` and `previews/:id/display.webp`, and cleanup removes
them when their unattached asset expires.

Text metadata is bounded at 256 KiB UTF-8. The viewer further caps rendering at
20,000 UTF-16 units, 32 KiB UTF-8 and 1,000 lines, preserving Unicode boundaries
and showing a truncation notice. The original remains downloadable. PDF canvases
are capped at 16,777,216 pixels and 8,192 pixels per side. Unsupported/corrupt
content becomes a durable fallback; storage outages remain retryable.

PDF canvas fetches use authenticated byte ranges through the API with
`application/pdf`, attachment disposition, no-store and nosniff. This avoids a
cross-origin redirect/CORS failure found in the real browser while keeping direct
navigation a download. Images/media continue to use signed redirects and retain
the configured private bucket/origin restrictions. Browser codec support varies;
reopening a viewer obtains fresh content URLs. Long-running media behavior after
signed URL expiration and remote HTTPS/proxy configuration are not covered by the
short local playback fixtures.

### Cost controls

PDF.js uses a custom range transport with 64 KiB chunks, streaming and automatic
prefetch disabled. It starts without an eager full GET; parsing may coalesce
chunks or need data from multiple pages. The endpoint authorizes every request,
supports single closed/open/suffix byte ranges with 206/416 headers, and offers
HEAD without reading storage. A GET without Range still returns the complete
PDF for compatibility (bounded at 25 MiB). SeaweedFS reads reject ignored or
inconsistent provider ranges rather than falling back to a full download.

For a `.pdf` filename, completion probes at most 4,100 bytes of the sealed
original. Actual detected bytes decide the kind; misleading extensions fall
back to normal classification. PDFs with other names still work through the
full classifier. This reduces the storage read at completion without bypassing
the existing finalized-size check or exposing raw uploaded content.

Static images fitting 360×240 are encoded once and stored only at `display.webp`;
both thumbnail and content routes use that object. Larger images keep distinct
360×240 and 1600×1200 derivatives. GIFs retain their separate first-frame thumbnail
and original animation. Existing extra thumbnail objects are left in place;
cleanup remains safe for either layout. The filmstrip reuses the mounted cards'
metadata. The selected viewer still revalidates access on every open/navigation,
including text previews. No private content cache is shared across messages or
sessions, and original downloads and retention rules are unchanged.

The 2026-11-03 local browser measurement used an authored 48-page, 7,061,013-byte
PDF, real PDF.js, an isolated API/PostgreSQL schema and SeaweedFS. Rendering page
1 transferred 3,259,925 PDF bytes across 50 authenticated 206 reads, 53.8% fewer
PDF bytes than the previous full fetch. The synthetic document spreads page
objects throughout the file, so parsing still needs many ranges. Completion read
4,100 bytes. This measures document transfer, not the PDF.js bundle, network
headers, upload/copy operations or dollar savings. Results depend on PDF layout,
pages viewed, server request overhead and the deployment's bandwidth/storage
costs; small PDFs or reading every page may offer little transfer reduction.

The authored 1200×700 PNG fixture was 48,127 bytes; its WebP card was 3,710 bytes
and display was 17,552 bytes. A tiny image stored one 150-byte derivative instead
of two identical 150-byte objects. A two-attachment regression check reduced
metadata fetches on first viewer open from five to three while retaining fresh
authorization. These are scoped measurements, not an estimate of total bill
savings. Generation and browser request records are retained under
`/Users/kai/.codex-artifacts/space-preview-cost-2026-11-03/`.

No additional schema migration is needed for these cost changes. Rebuild/restart
the API and update the web bundle; installations without preview metadata still
need migration 010 described above. Remote HTTPS/proxy range forwarding remains
a deployment check.

See [Slack renderer research](../research/slack-file-rendering.md) for actual REA
provenance, recovered component behavior and observation limits. No Slack code is
shipped with Space. This renderer does not include Office conversion, video
transcoding, transcription or malware scanning.


Before the cost pass, the 2026-11-03 renderer baseline passed 244 tests with sequential
package execution, plus typecheck/build and all 11 real API/Seaweed checks.
Parallel CPU load can make the existing Shiki color-token assertion hit its
500-ms per-line tokenization limit; the original text remains intact, and the
production tokenizer limit was preserved.

The cost pass separately passed 30 frontend preview tests, 18 storage/preview
unit tests and all 12 API/SeaweedFS tests, plus repository typecheck/build and the
browser checks above. Full-suite attempts also encountered unrelated concurrent
profile/memory/UI changes, stale migration-count expectations and a memory MCP
input mismatch; they do not establish a clean full suite. No live application
deployment was performed.

## Inline PDF message thumbnails

PDF cards now show a lazy first-page image below their filename and PDF label.
Filenames open the shared viewer; original download has a separate labeled
control. Image cards respect natural dimensions within their existing bounds.
Malformed or unavailable thumbnails leave the PDF icon, viewer and download
usable. The viewer still fetches authenticated PDF ranges only after activation.

The first authorized PDF `/thumbnail` request reads the sealed original once,
renders page 1 with Poppler and stores `previews/{id}/thumbnail.webp` at at most
360×240. PDF preview JSON records `thumbnail: true` or `false`. An atomic processing
claim deduplicates simultaneous requests across API instances without retaining a database lock. Failed
document conversion is cached; storage outages and missing/busy renderers remain
retryable. Access is checked again after conversion before signing the result.
The thumbnail JSON supports existing PDF assets; processing claims require migration 024.

Conversion admits two jobs per API, a 25MiB input, first-page-only 720px raster,
8s wall timeout and temporary-directory cleanup. Linux uses `prlimit` with
512MiB address space, 5 CPU seconds and 4MiB output-file size. The Docker runtime
installs `poppler-utils`, `util-linux-misc` and `font-liberation`; rebuild the
server image to activate them. Native development needs `pdftoppm` and fonts on
PATH, plus `prlimit` on Linux. Unsupported, encrypted and over-budget documents
retain the icon/viewer/download path. Office attachments open in the separately configured ONLYOFFICE service.

Verification: 26 server, 19 asset API and 32 frontend preview tests passed,
plus 2 real API/SeaweedFS tests, typecheck and server/web builds. The Alpine
runtime rendered visible first-page text as a non-root user under the resource
limits. An initial missing-font check produced a blank page, which the runtime
font package corrected. One cold macOS invocation exceeded the wall limit;
subsequent native conversion checks passed without raising that limit.

The isolated production-bundle browser showed the thumbnail, opened the PDF
from its filename, navigated to page 2, returned focus, and fit at 390px without
horizontal overflow. A 1,104-byte fixture required one original read for
conversion and one range read for the activated viewer; eight thumbnail requests
and a page reload caused no additional original reads. This is cache behavior
evidence, not a general bandwidth or billing benchmark. Artifacts are retained
at `/Users/kai/.codex-artifacts/space-inline-file-render-2026-11-03/`.

The broad suite was not clean: chat startup, a connector timeout and migration
count assertions failed while unrelated outbox/migration work changed the shared
checkout. Affected asset/preview checks above passed after the final change.

![Inline PDF card](/Users/kai/.codex/visualizations/2026/11/03/01a1a08d-7f31-73b1-8a25-65404ae51560/channel-inline-pdf.png)


## Opening Office attachments locally

Add these variables to the environment of the Space API and Docker Compose. Generate
the shared secret once with `openssl rand -hex 32` and store it in the ignored
local `.env` file.

```dotenv
ONLYOFFICE_URL=http://127.0.0.1:58080
ONLYOFFICE_STORAGE_ENDPOINT=http://seaweedfs:8333
ONLYOFFICE_CALLBACK_BASE=http://server:3000
ONLYOFFICE_JWT_SECRET=<generated secret>
```

```sh
docker compose -f compose.yaml -f compose.office.yaml up -d onlyoffice
pnpm migrate
```

Restart the API with the same environment. For a containerized API, include both
Compose files when starting the server. The browser connects to `ONLYOFFICE_URL`.
The document server fetches a signed object URL on `ONLYOFFICE_STORAGE_ENDPOINT`
(defaults to the API's internal storage endpoint). Use HTTPS for the browser URL
when Space runs on HTTPS.

Opening an Office attachment requests `GET /v1/assets/:assetId/office-session`.
Space checks current access, signs a view-only configuration, and gives the viewer
60 seconds to fetch the original. The ordinary download remains available if the
viewer is disabled. Markdown attachments render inside the text preview with the
same size limits as source code.

For channel documents, a reachable `ONLYOFFICE_CALLBACK_BASE` enables **Edit** for the uploader.
The uploader can enable **Channel editing** to let other current members with posting permission
join the same live editing session. Use the address of the Space API as seen by Document Server.
Compose uses `http://server:3000`. With a native API, route the document server to that API's
`/v1/office/callback` and `/v1/office/files/` endpoints. They verify the signed outgoing
requests from ONLYOFFICE Docs 10. The browser still uses the same authenticated Space routes.

The last editor closing triggers finalization. Space validates the returned format and size and
atomically replaces the last saved working copy in `office_edits` (up to 25 MiB per attachment).
Normal downloads return that copy. The original remains in object storage and is available under
**Original upload**. There is no intermediate version history. Revoking channel editing retires
the shared session key, so finish the current session before disabling sharing.

The viewer turns off ONLYOFFICE chat (`permissions.chat`) and plugins
(`customization.plugins`). Both would run outside Space's channel access checks.

`pnpm --filter @space/tests test:office:e2e` opens every Office format from
`tests/fixtures/office` in a real browser. It needs a running document server
and SeaweedFS, plus `TEST_DATABASE_URL`, `NATS_URL`, the `ONLYOFFICE_*` variables
above and the `ASSET_STORAGE_*` variables. For editing tests, set `OFFICE_TEST_BIND_HOST` and
`OFFICE_TEST_CALLBACK_HOST` to a private interface reachable from Document Server. The test
opens two browser contexts, checks propagation, downloads their combined changes and reopens
the saved file. CI does not run it.
