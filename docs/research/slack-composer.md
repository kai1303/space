# Standard Slack channel / DM composer

Date: 2026-11-03. Target: the standard web composer selected by the user, rather than the distinct Slackbot AI input. This pass combines live browser observations with actual REA static analysis of JavaScript already loaded by that browser. Space uses its own React implementation and public Quill package.

## Evidence

The captured client bundle was `gantry-v2-async-client-boot-shared.3ac2d197375862a1.min.js`, SHA-256 `99402e5748575d853aac121a2ee85345a56bea3a30951b1faf6ee18f426faf90`. An AST extractor selected complete Rspack module factories containing the relevant composer symbols. Each manifest records the original character ranges and exact extracted hashes. The factories were wrapped as inert bundle text; their bootstrap code was not executed.

REA 6.8.0 ran through its pinned CLI with the available Node 24 runtime:

| Selected modules | Scope | Findings | Parent Evidence ID |
| --- | --- | ---: | --- |
| `0nJI`, `sWqg`, `fqr4`, `NmQc` | Link editing, formatting toolbar, MessageInput, send/schedule/frame | 453 | `ev_4568efca4d98da7d4f111e7a3bd787314d0ba64764878d68ef1440617d1952e6` |
| `cVOY`, `SHZE` | Texty autocomplete and customized editor | 358 | `ev_01751df964cb884facad19bdf8be3f9ce10850bb3c9afe9978a2663a589562b8` |
| `pt6O` | Enter/newline policy helper | 2 | `ev_dbcd774ecff107b544d2e6dae1be39991916e09e6418ee447f7e836861f7affc` |

All seven selected modules parsed without failures. Findings are extracted static records, not vulnerabilities or proof of execution. Dependencies across other chunks, feature-flag values, platform/user preferences, server behavior and permissions remain partly unresolved. The helper's small artifact was fully inventoried, which does not imply full application coverage.

Raw scripts, CSS, extraction scripts, provenance manifests and REA JSON remain outside the repository in `/Users/kai/.codex-artifacts/space-slack-2026-11-03/`. The relevant prefixes are `composer-`, `composer-editor-` and `composer-key-policy-`. Browser inspection and REA analysis are separate evidence sources: REA analyzed exported code; it did not operate Slack's UI. No Slack messages were submitted during this composer pass.

## Recovered behavior

| Area | Evidence from Slack | Space behavior |
| --- | --- | --- |
| Editor | Live `.ql-editor` / `.ql-container`; Texty source adds custom keyboard, clipboard, autocomplete and IME handling | Public Quill 2.0.3 with Space toolbar; Slack's exact Quill version is unknown |
| Geometry | Dark shell `#222529`, border `#797c81`, radius 8px; empty shell about 117px; toolbar 38px; editable minimum 38px, padding 8px/12px, type 15px/22px; footer 40px | Shared editor dimensions and theme tokens updated to these observations |
| Formatting | Bold/italic/underline/strike; Paragraph menu; link; numbered/bullet lists/quote; inline code/code block/divider. Source computes adaptive overflow groups | Supported inline/list/quote/code controls use recovered grouping. Code mode disables incompatible inline controls and link. Narrow toolbars wrap |
| Drafts | MessageInput flushes drafts on channel changes, restores cursor, defers composition updates until composition end | Gallery now uses rich documents and separate channel/thread draft and attachment-metadata maps. Drafts remain in memory |
| Send | Split Send now / Schedule for later; empty input disabled; source checks connectivity/send state and may show confirmation | Send now callback, duplicate blocking, retained failure draft. Schedule is visibly unavailable |
| Keys | Texty gives editor/autocomplete bindings first chance, then applies platform, code-context and Enter-newline preferences. Snippet shortcut is separate | Default mode: Enter or Command+Enter sends; Shift/Alt/Ctrl+Enter stays in the editor; composition and key-code 229 cannot send. Shift+Enter inserts a newline |
| Attach | Live plus menu includes file/list/GIF/snippet/workflow/upload choices, some gated | Plus opens local file chooser; attachment metadata only, five-file authored limit |
| Mention | Live button inserts `@` and opens searchable user suggestions with keyboard hints | Small local name picker inserts text; no user identity, notification or autocomplete semantics |
| Emoji | Live searchable categorized picker, skin tones and Add Emoji | Six local emoji choices |
| Other actions | Recording, shortcuts, scheduling; source includes a gated expand control | Recording/shortcuts/scheduling disabled; no expanded editor |

The Enter helper also has special preformatted/triple-backtick paths. Space's default helper does not reproduce those preference-dependent branches. Its key handler is therefore a bounded reconstruction, not Slack's complete keyboard state machine.

## Implementation and remaining gaps

The gallery at `/#chat-composer` and workspace preview at `/workspace` share `packages/ui/src/rich-composer.tsx`. The gallery's former plain textarea was replaced with this editor for channel and thread messages. Rich output is rendered through `RichContent`, with allowed operations and safe links rather than injected HTML. The existing plain `Composer` stays available as a separate component.

This pass corrects the code-block active state for Quill's truthy language value, adds a split send silhouette, and keeps footer controls within narrow desktop threads using container width. Async send settlement checks editor identity so a detached instance cannot erase a newer stored draft or steal focus. Rejected file picks reset the input so users can retry the same selection after removing attachments.

Still absent: heading/divider operations, Slack's adaptive overflow menu and arrow navigation, full searchable emoji and mention suggestions, semantic mentions, creation menu, snippet conversion, platform/preferences/code-context keyboard parity, custom paste processing, composition-aware draft batching, cursor restoration across conversations, scheduling, recording, expand mode and Slack transport. Lato/Phosphor are documented substitutes. The 10,000-character and five-file limits are Space choices. Attachment bytes are neither retained nor uploaded.

This report supersedes the earlier composer overview in [Slack workplace](slack-workplace.md) for the detailed source scope and current limitations. Verification is recorded in [composer QA](../slack-composer-qa.md).
