# Slack emoji and Space implementation

Observed 2026-11-03. This covers standard Unicode emoji in the web composer, reactions, and profile status.

## Evidence

Live Slack inspection showed an Emoji/GIF tab bar, name search, eight standard categories plus Custom, frequently used/work suggestions, shortcode previews, Add Emoji, and a Skin Tone footer control. Searching `thumbsup` returned the named thumb and a workspace variation. The skin-tone control opens a small horizontal popover with six hand swatches and a radio group; it is not a native text dropdown. No Slack messages were sent, reactions applied, emoji uploaded, or account preferences changed by this inspection.

Slack's public [emoji/reaction guide](https://slack.com/help/articles/202931348-Use-emoji-and-reactions), [emoji preferences](https://slack.com/help/articles/4406393601683-Manage-your-emoji-preferences), and [custom emoji guide](https://slack.com/help/articles/206870177-Add-custom-emoji-and-aliases-to-your-workspace) provide the documented behavior. Browser observation was separate from REA analysis.

REA 6.8.0 analyzed two complete Rspack module factories from the previously captured shipped bundle `gantry-v2-async-client-boot-shared.3ac2d197375862a1.min.js`, SHA-256 `99402e5748575d853aac121a2ee85345a56bea3a30951b1faf6ee18f426faf90`. Modules `9gts` and `kwO3` retain original byte ranges and their own hashes in `emoji-provenance.json`. Evidence `ev_c23dc03e2eadf1a478252d3de71acecef78065b1ce023d214f16b8b902ab8d09` records two parsed files, zero parse failures, 108,678 text bytes and 458 static findings. The `EmojiPickerPopover` factory includes preferred-skin-tone persistence and message focus restoration. The composer factory includes a `+:emoji:` last-message reaction path, with skin-tone suffixes and existing-reaction membership checks. These static paths were not executed by REA; cross-chunk dependencies, feature flags, and complete application behavior remain unresolved.

Complete inert artifacts, provenance and REA JSON are outside the repository at `/Users/kai/.codex-artifacts/space-slack-2026-11-03/emoji-*`. REA MCP was unavailable; analysis used the installed pinned CLI with the existing Node 24 runtime, without changing client configuration or installing native engines.

## Space behavior

- One shared catalog-backed Unicode picker replaces fixed composer, reaction, and status choices. `@emoji-mart/data` 1.2.1 supplies Unicode 15 names, aliases, categories, keywords, and variants. Native platform glyphs replace Slack's proprietary imagery.
- Search recognizes names, aliases (`thumbsup`, `+1`) and keywords. Exact/prefix names rank ahead of keyword matches. Category tabs, previews, local frequent choices, search-empty feedback and a bounded floating panel use Space tokens.
- Six hand swatches replace the initial text dropdown. The selected tone updates eligible emoji and shortcode completion immediately, persists locally, and is shared by composer/reaction/status pickers. A single-tone choice does not reproduce Slack's independent multi-person skin combinations.
- Arrow keys navigate results and tone radios. Enter/Tab accept shortcode suggestions before message sending. Floating panels portal into the closest native dialog when used by status editing, keeping them interactive in the modal top layer. Escape first dismisses tone options, then the picker; focus returns to the appropriate control or saved editor selection. IME input cannot accidentally send.
- Known `:shortcode:` text converts on sending; suggestions are available from two typed characters. Explicit `:skin-tone-2:` through `:skin-tone-6:` overrides the preferred tone. Inline code, code blocks, links, plain URLs and unknown names are retained. Text, rich documents and the stored submitted draft remain consistent, including navigation during an in-flight send. New status validation also accepts flag/keycap emoji from the catalog.
- Real chat persists per-user reactions, with idempotent add/remove, channel/archive authorization, matching counts and current-user state. `message.updated` events share the durable outbox/replay channel. Reaction revisions preserve message order, reject stale snapshots, and update loaded older windows without pulling unrelated messages into view. Access loss suppresses late mutation replies.

Space adaptations: locally remembered preferences (not account-synced), a 24-selection rolling frequency window, eight suggestion rows, and native glyphs. Workspace custom-image emoji/upload/alias management, GIFs, emoticon preferences, jumbo emoji rendering, and `+:emoji:` last-message shortcuts are not implemented. These are explicit remaining gaps, not observed Slack parity.

## Verification and rollout

The shared UI suite passed 90 tests. The affected web suites passed 64 tests, including shortcode/selection behavior, persisted reaction intent, realtime updates, and history ordering. The database-backed chat suite passed 19 tests with real PostgreSQL and Redis, including per-user reaction counts, retry idempotence, history hydration, realtime replay, rejected identity spoofing and denied cross-workspace access. Profile contract tests cover flags, keycaps, families, and toned emoji. Desktop browser checks exercised picker search, all six visible swatches, a selected medium tone, reopening with the remembered preference, arrow selection, and Escape focus restoration. The signed-in status flow was unavailable in the current browser; a temporary synthetic profile harness reached the native status modal, but browser tooling timed out before completing selection there. The portal-host regression is covered by the status test. No mobile viewport validation is claimed.

Migration `023_message_reactions.sql` adds reaction storage and extends event/payload support. It follows the concurrently authored local connector migration `022`; unrelated connector changes are not part of this task. Tests use isolated schemas. The current local database was verified to include migrations 21, 22 and 23, and the local API process had been restarted by the concurrent development session. Other environments require migration and API restart. The picker and composer work in the frontend preview independently of backend reactions.

Preview screenshots are in `/Users/kai/.codex/visualizations/2026/11/03/01a1a1a9-b049-7d53-bead-d0cc96fc219e/space-emoji-picker.png` and `space-skin-tones.png`.

Final frontend build passed. A final repository-wide typecheck was blocked by concurrently added `tests/contracts/mentions.test.ts` fixture types (`kind: string` versus `MentionReference`), outside this emoji change. Earlier scoped UI/web/contracts/postgres/server typechecks passed.
