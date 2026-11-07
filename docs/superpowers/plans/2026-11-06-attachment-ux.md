# Attachment UI and UX implementation plan

**Goal:** Apply the approved attachment comparison findings on main: useful image draft previews, reorderable files, persistent image descriptions, clear posted cards, and appropriately sized previews.

**Design:** Keep upload and authorization paths intact. Extract the composer attachment presentation into a shared UI component. Use object URLs with cleanup for local thumbnails, Motion for reorder layout, pointer drag and accessible move buttons. Edit descriptions in a dialog and preserve them through upload completion. Send bounded descriptions keyed by attached asset ID and store them in the existing message attachment JSON; include them in retry identity. Existing clients remain compatible.

**Evidence:** Space UI inspected live; Slack attachment menu inspected live. Slack reorderable draft previews and image descriptions are documented in https://slack.com/help/articles/201330736-Add-files-to-Slack. Slack upload/viewer inspection was blocked by extension permissions. This is an adaptation, not verified pixel parity.

- [x] Add failing composer interaction tests for local thumbnails, cleanup, reorder, description editing, disabled controls, and upload errors.
- [x] Add contract, message sender, upload race, and storage/replay tests for bounded descriptions and preserved order.
- [x] Implement shared composer attachment cards and wire RichComposer; preserve local files and latest descriptions when uploads finish.
- [x] Extend message input and persisted attachment metadata without a schema migration; propagate through channel/thread send and file listings.
- [x] Improve posted text snippets, explicit preview actions, image alt text and content-sized text viewer while retaining keyboard/focus behavior.
- [x] Run focused UI/web/contract/integration tests and builds/typechecks; inspect resulting browser UI at desktop and narrow width where available.

Do not alter upload limits, add polling or locks, send Slack messages, or include unrelated dirty main changes in a commit.

## Verification

- Shared UI suite: 210 tests passed before the final pointer refinement; final attachment and composer checks: 23 passed, including cancel/outside-drop behavior.
- Focused web tests: 104 passed (chat, uploads, message sender, previews); the final preview checks passed again (13).
- Attachment contracts: 4 passed. Asset integration suite: 20 passed, including channel and workspace file descriptions, ordered replay and idempotency.
- Contracts, UI, PostgreSQL, server and web builds/typechecks passed. Vite still reports bundle-size and dependency directive warnings.
- Live browser: thumbnail and description editing; pointer dragging and move buttons; 390px description dialog; posted text cards; content-sized text viewer. Preview measured 384px high for the sample, instead of 746px.
- Temporary NATS test instance isolated the suite from the shared NATS storage-capacity failure and was removed afterward.
- Interactive gallery: /design-system#attachment-composer. Screenshot artifacts live in the Codex attachment-fixes visualization folder.
- No Slack uploads/messages, no database migration, no commit or push for this attachment change.
