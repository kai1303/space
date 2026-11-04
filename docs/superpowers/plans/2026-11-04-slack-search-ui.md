# Slack search UI implementation plan

**Goal:** Apply the observed Slack search interaction and visual hierarchy to Space's working Typesense message search.

**Evidence:** Live signed-in Slack browser observation on 2026-11-04: top-aligned search palette; Enter opens a wide results view; From/In/link/thread/date filters; author/avatar/channel/timestamp result rows; highlighted terms; source navigation. REA was unavailable (runtime/registration diagnostics); evidence is CUA browser inspection, not REA extraction. No Slack message content or screenshots are copied into product fixtures.

**Architecture:** Keep the existing authenticated Typesense API, revision hydration, pagination and result navigation. Search entry is a compact shared Dialog; submission expands into a wide search surface within that dialog, preserving modal focus/escape handling. This adapts Slack's full-page results to Space's current dialog-based navigation. UI filter chips compose supported query syntax. Counts describe loaded results; sorting remains newest first. No unsupported source tabs, AI actions or total counts.

**Files:** `apps/web/src/features/search/MessageSearch.tsx`, `message-search.css`, colocated UI tests; `apps/web/src/app/Chat.test.tsx`; `tests/e2e/search.test.ts`; architecture documentation.

- [x] Add tests that typing alone makes no search request, Enter submits, filters combine without duplicating operators, literal quoted text remains intact, highlights are safe, and pagination resets after filter changes.
- [x] Implement palette/result modes and accessible From/In/date popovers, link/thread toggles, query highlighting and compact result rows using existing UI primitives.
- [x] Preserve cancellation, bounded result storage, current scope, error/retry and keyboard dismissal tests; update integration tests to submit searches.
- [x] Run real-service browser E2E with Enter, filters, highlighting, source navigation, isolation, pagination and a narrow viewport. Capture and visually inspect Space screenshots.
- [x] Run frontend typecheck/build and focused Chat/search regression tests; document observed fidelity and limitations.

## Verification

- Real Chromium E2E passed with the actual authenticated API, PostgreSQL, JetStream and Typesense (22.95 seconds total). Covers Enter submission, older history, cross-channel/reply source navigation, access isolation, link/thread filters, highlighting, pagination and 390px mobile overflow.
- Nine focused search UI tests passed; frontend typecheck and build passed.
- Combined Chat/search run: 83 passed and one Activity timeout. That Activity test passed on an isolated rerun; an intervening Vitest worker startup timeout ran no tests. The final single-worker search run passed all nine tests.
- Desktop and mobile screenshots visually inspected at `tests/test-results/typesense-search.png` and `tests/test-results/typesense-search-mobile.png`.
- Existing Typesense backend behavior was preserved. This UI adaptation uses the shared modal rather than Slack's full-page navigation; sort remains newest first and result counts describe loaded items.
