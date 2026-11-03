# File Previews Implementation Plan

> **For agentic workers:** Use subagent-driven-development for independent preview engine and frontend units. Primary agent owns persistence, routes, integration and research. Preserve concurrent untracked work; no commits.

**Goal:** Render uploaded attachments in chat with Slack-like previews and an accessible file viewer.

**Architecture:** Generate byte-validated preview metadata and safe image derivatives when an upload completes; lazily backfill old assets. Store derivatives in SeaweedFS and metadata in PostgreSQL. The frontend requests authorized preview information and renders image/PDF/text/media viewers with download fallbacks.

**Tech Stack:** Existing Fastify/Drizzle/React, Sharp, file-type, PDF.js, existing Dialog/CodeBlock.

- [x] Reverse engineer loaded Slack file modules with the REA CLI, preserving provenance, evidence and observed/inferred limits.
- [x] Preview engine/storage: write failing tests, add bounded Seaweed read/write/inline operations and a byte classifier/image generator. Interface generateAssetPreview(storage,id,name,key,size) returns AssetPreview; preview keys deterministic previews/:id/display.webp and thumbnail.webp. Never execute HTML/SVG; sanitize image derivatives.
- [x] Contracts/database/routes: add AssetPreview union, asset preview JSON migration010, atomic preview persistence during completion, locked lazy legacy backfill, content/thumbnail authorization and cleanup. Update migration-count fixtures. Write failing DB/API tests before implementation.
- [x] Frontend: shared attachment cards and viewer for channels/threads, image thumbnails, PDF.js pagination/zoom, escaped bounded text/code, native audio/video controls, unsupported/error fallback, filename/download/close and keyboard navigation. Write failing component tests first.
- [x] Integrate: test real Seaweed signed previews, authorization, malformed payloads, derivative cleanup and old messages. Browser-test image/PDF/text/media fixtures; run full tests, typecheck/build, independent spec and quality reviews. Document actual scope and limits.


## Review corrections

Independent spec/code review approved after limiting full text rendering by line,
character and UTF-8 byte counts, preserving Unicode boundaries, and adding the
validated file type label. Actual browser testing found a PDF redirect CORS
failure not reproduced by Node transfers. A real API regression first failed
302 versus 200; PDF content now stays on the authenticated API origin with a
25-MiB read bound and attachment disposition. Browser PDF canvas, page navigation,
zoom and the 390px viewport then passed.

Concurrent channel-memory work added migration011; it was preserved. Legacy
upgrade fixtures now expect all eleven migrations. No commits or remote deployment.


## Final verification

- `turbo run test --concurrency=1`: all 244 tests passed (20 connector, 61 UI,
  54 web, 19 server, 90 backend/contracts), with no skipped or cancelled tests.
- `pnpm typecheck` and `pnpm build` passed.
- `pnpm test:assets`: all 11 API/PostgreSQL/real-Seaweed checks passed.
- Real Seaweed storage integration passed byte limits, private derivative access,
  signed inline MIME/disposition/CORS and tamper rejection.
- Browser image and PDF previews rendered; PDF page navigation/125% zoom and
  390×844 layout passed. WAV/MP4 loaded duration and readyState without error.
- Independent spec/quality review approved after corrections. QA schemas,
  objects and browser tab were cleaned; normal viewport/CORS restored.

Parallel package execution intermittently exposed an existing Shiki tokenization
wall-clock limit in its syntax-color assertion. Sequential package execution
passed the same tests. The production highlighter limits were preserved.

Office conversion, transcoding/transcripts, long media playback after URL expiry,
remote HTTPS/proxy behavior and backup restoration remain outside verification.
