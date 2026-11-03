# Full composer in connected chat

Use the existing full RichComposer in channel and thread inputs. Preserve structured formatting through the existing authenticated REST/Socket.IO message path and render it with RichContent. Keep plain text alongside the document for search and older clients. Existing plain-text history and retry IDs must remain valid.

- [x] Add failing contract/client/UI assertions for formatted documents, safe links, retry identity and the visible toolbar.
- [x] Add shared document types and strict server parsing: text-only inserts, allowed attributes, safe URL protocols, bounded characters/UTF-8 bytes and matching plain text.
- [x] Add nullable JSONB document storage and include it in newly created history events. Include formatting in idempotency hashes while retaining the old hash shape for plain sends.
- [x] Forward documents over REST/socket sends, render safely and enable the current toolbar in both composers. Keep uploads unavailable until file transport exists.
- [x] Verify real link/list/code messages and replies through send/reload, run contract/chat/UI tests, typecheck/build, review and capture the result.

No changes to authentication, membership, trusted agent authors or task approval. Message request/frame limits remain bounded and are adjusted for structured formatting. No raw HTML is accepted or injected.
