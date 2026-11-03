# Image and PDF preview cost optimization

User authorized continuing Slack research and optimizing Space's image/PDF costs.

Design: preserve private originals, upload validation, fresh authorization on viewer open and on content requests, and no-store responses. Reuse card metadata for the viewer filmstrip (selected viewer still revalidates access). PDF.js will use its custom range transport with 64 KiB requests against the same-origin, authenticated content endpoint, avoiding an initial full-file GET. Existing full PDF GET/download behavior stays compatible. Add strict single-range parsing, validate provider range responses, and bound each read. No new dependencies, public bucket, global private-content cache, conversion workers, or retention policy changes.

Tasks:
- [x] Backend: SeaweedFS bounded byte-range reads; authenticated PDF 206/416 and HEAD; regression and real-storage checks. Normal PDF completion now probes at most 4,100 actual bytes instead of the full sealed original.
- [x] Frontend: PDF range transport, cancellation/error handling; filmstrip metadata reuse while retaining selected-viewer authorization; regression tests.
- [x] Review Slack evidence and image derivative sizes; keep the existing 360px/1600px WebP split. Tiny static images fitting 360×240 now encode/store one shared display object, with legacy-compatible thumbnail routing.
- [x] Independent spec/security review, scoped tests, typecheck/build, real SeaweedFS and browser verification; document measured transfer/request differences and limits.

Verification: 30 frontend preview tests, 18 storage/preview unit tests and all 12 API/SeaweedFS tests pass. Whole-repository typecheck and build passed. An actual browser rendered an authored 48-page PDF using only authenticated206 requests, verified next page/125% zoom, tiny/large image decoding and close focus return. Temporary QA schema, objects, server and browser tab were removed.

Measured PDF page-one transfer: 7,061,013 -> 3,259,925 bytes (53.8% reduction; 50 ranges). Completion classification read4,100 bytes. Tiny image: one150-byte WebP instead of two. Two-file viewer metadata: five -> three requests. Full measurements and limits are in docs/architecture/assets.md.

Full-suite attempts encountered concurrent unrelated work: new UserProfile test/module availability, MemoryConnections and Conversation UI behavior, migration-count expectations (13 vs12), and memory MCP input shape. The attachment reopen test was updated to wait for the shared Dialog's newly asynchronous close and passes. These checks do not establish a clean full-repository suite. No production deployment, remote proxy verification, new dependency/schema migration, commits or destructive retention changes.
