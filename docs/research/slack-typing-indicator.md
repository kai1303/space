# Slack typing indicator rendering

Checked on 2026-11-04 against the previously captured Slack web client bundle and CSS dated 2026-11-03. The live Slack browser tab was in use by another task, so this is static shipped-client evidence, not a newly observed live typing event.

The inspected bundle is `gantry-v2-async-client-boot-shared.3ac2d197375862a1.min.js`, SHA-256 `99402e5748575d853aac121a2ee85345a56bea3a30951b1faf6ee18f426faf90`, retained in `/Users/kai/.codex-artifacts/space-slack-2026-11-03/agent-render-source/`.

Recovered rendering:

- `TypingNames` (`f1G5`) renders bold names and plain text: **Name** is typing; **Name** and **Other name** are typing; Several people are typing. This renderer contains no animated dot prefix or trailing ellipsis.
- `NotificationBar` (`55cV`) renders that text in the left notification section and hides formatting tips while typists are showing.
- The composer parent places `getNotificationOrAiWarning()` after `renderMessageInput()`. The thread branch uses `.p-thread_footer_typing_indicator` below the input.
- Captured CSS gives `.p-notification_bar` a 24px height, 12px left padding, and 8px right padding. Its text is secondary color, `.7em`, with a 1rem line height. Thread footer CSS also uses a 24px row and 12px left padding. Text truncates to a single line.

REA 6.8.0 analyzed complete extracted module factories through its pinned CLI using the existing Node 24 runtime. Parent Evidence ID: `ev_79438cf9aa8e03d8598138312adfb4392ab6a7deff806aaa661cb6eeea511c2e`. Provenance, original character ranges, selected module hashes and complete evidence are in `/Users/kai/.codex-artifacts/space-slack-typing-2026-11-04/`. The selected factories parsed, while the broader semantic graph retained 6,897 unknowns; this establishes the inspected rendering paths, not complete application or transport behavior. No Slack bundle code was executed and no Slack messages were sent.

The user subsequently chose a different placement for Space: the typing line sits just above the composer with a small gap. Names remain bold, the indicator has no dots, and more than two typists collapse to the generic summary. A reserved row keeps the composer steady. This placement is an explicit user preference, separate from the captured Slack rendering described above. Existing transport, permissions and expiry behavior are unchanged.
