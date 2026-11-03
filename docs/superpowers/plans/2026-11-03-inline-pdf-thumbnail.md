# Inline PDF Thumbnail Implementation Plan

**Goal:** Show a reusable first-page PDF thumbnail in channel messages.

**Architecture:** An authenticated, lazy thumbnail request performs one bounded
Poppler conversion and persists the WebP and success/failure metadata. Existing
message cards and shared viewers consume the same asset endpoints.

**Tech Stack:** TypeScript, PostgreSQL JSONB, SeaweedFS, Poppler, Sharp, React.

- [x] Add and run failing server conversion, API cache/access and React card tests.
- [x] Implement `apps/server/pdf-thumbnail.ts`, PDF metadata and the locked
  `AssetStore.pdfThumbnail` path; extend the existing thumbnail route.
- [x] Add runtime Poppler/prlimit/font packages in Dockerfile. Preserve cheap PDF
  classification, original downloads and full-viewer ranges.
- [x] Add lazy clickable PDF thumbnails and separate preview/download controls in
  `AssetAttachments.tsx` and bounded styles in `asset-attachments.css`.
- [x] Run affected tests, typecheck/build, real SeaweedFS checks and browser QA.
- [x] Document limits and record evidence. Leave changes uncommitted for review.

79 focused checks passed. Repository-wide tests have unrelated chat startup,
connector timing and migration-count failures in the changing shared checkout;
see the architecture document and retained logs. No deployment was performed.
