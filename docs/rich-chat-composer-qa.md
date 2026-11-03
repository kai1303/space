# Full composer in connected chat

Date: 2026-11-03. The user requested the full current composer with links, lists and code blocks. Channel and thread inputs now use the same rich toolbar as the design system, with formatted messages saved through the existing authenticated chat transport.

## Changes

- Rich document types are shared through `@space/contracts`. The server validates string inserts, supported formatting attributes and safe HTTP/HTTPS/mail links, rejects embeds/unknown fields, and checks that document text matches the message's plain-text fallback.
- Migration 007 adds nullable JSONB document storage and extends newly created message/history payloads. Existing plain messages and stored events remain readable without backfilling invented formatting.
- REST and Socket.IO forward documents; acknowledgments, replay, channel history and thread history retain them. Idempotency hashes include formatted content, while the hash shape for document-less legacy requests is unchanged. The client changes retry identity when formatting changes.
- `RichContent` renders allowed elements with React escaping. Links, ordered/bulleted lists, quotes, inline formatting/code and code blocks are supported. Code grouping now preserves leading empty lines.
- The frontend blocks documents exceeding 32 KiB serialized UTF-8 before send and retains the draft. Server validation additionally bounds operations and characters. Message POST bodies and inbound socket frames permit 128 KiB to carry both text and its structured document; other HTTP endpoints keep their 32 KiB default.
- Real chat disables file selection with `attachmentsEnabled={false}`. Recording, shortcuts and scheduling remain unavailable. Gallery attachment metadata behavior stays unchanged.

## Verification

`pnpm test` passes 139 tests: 71 backend/contract/integration tests, 54 UI tests and 14 web tests. The 10-test chat integration suite includes real PostgreSQL/Redis, live WebSocket acknowledgment/delivery, structured channel/thread history, formatted retry conflicts, unsafe-link rejection and rerunning migration. Full backend checks also cover Better Auth, ownership, revocation, legacy upgrades and worker behavior. Migration-count assertions were updated for version 007 after the broader suite exposed their old six-migration expectations.

New contract and client/UI assertions were observed failing before implementation because documents were rejected/dropped and the toolbar was hidden. Review then exposed leading blank code-line loss; its regression failed before the line-joining fix and passes afterward. A failed oversized-document test fixture was corrected to use distinct adjacent links because Quill legitimately merges equal formatting runs. No remaining review blocker was reported.

`pnpm build` passes all 10 tasks, including the rebuilt shared UI and frontend. Monorepo typechecks pass. Existing bundler directive warnings and the Node 25 local-storage-file warning remain non-fatal.

The additive migration was applied to the existing local development database and the owned local API process restarted with its existing auth configuration. No production deployment or auth/membership change was performed.

Browser checks used the separate synthetic UI QA workspace:

- Created and sent a labeled link, a two-item bullet list and a multi-line code block with a leading empty line through the real toolbar.
- Sent an inline-code reply through the thread composer.
- Reloaded the app and confirmed the saved link URL, both list items, exact code whitespace and formatted reply remained intact.
- Searched by the stored link URL rather than its visible label and found the message.
- Verified code mode disables incompatible inline/link controls. At 320px viewport width, document scroll width remains 320px and the toolbar wraps to 64px height. Temporary viewport changes were reset.
- The final checked browser tab captured no console warnings/errors.

Screenshots: `/Users/kai/.codex/visualizations/2026/11/03/01a19f82-8391-7ba3-a409-61a31b7bca6b/space-full-chat-composer.jpg` and `space-full-composer-mobile.jpg`.

These are local functional checks, not a production load claim. Uploads, semantic mention notifications, recording and scheduling are not implemented by this pass.
