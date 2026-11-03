# Slack Profile and Status

Inspected 2026-11-03 in the signed-in Slack web client. This pass reads rendered HTML, attributes, computed CSS and downloaded shipped stylesheets. No Slack profile or status was saved. REA MCP was unavailable; these findings are browser/source evidence, not REA static-analysis Evidence.

## Source and measured styles

The source page is `https://app.slack.com/client/T0F6QDEJD/C0F6LPQ69`. Scoped HTML was inspected for the profile pane, Edit Profile Form, and Set a status dialog. Personal values were not copied into this repository.

Three loaded stylesheets, SHA-256 hashes, original URLs and 99 selected rules are retained under `/Users/kai/.codex-artifacts/space-slack-2026-11-03/profile-status/`: `manifest.json`, `selected-rules.css`, and the original CSS files. The sources are Slack's `slack-kit-gantry-v2-styles.594b6e70f477bddd.min.css`, `client-boot-styles.88d120a749e8bc58.min.css`, and `helper-gantry-v2-styles.9aa943ade7971743.min.css`.

| Surface / selector | Observed HTML/CSS |
| --- | --- |
| `.p-view_contents--secondary` | Nonmodal profile dialog; measured 475px width. |
| `.p-flexpane_header` | Approximately 49px height; padding 0 12px 0 16px. |
| `.p-r_member_profile__avatar_content` | Centered flex column, max-width 288px, padding 16px 16px 0. |
| `.p-r_member_profile__avatar__img_container` | Square container, 8px corner radius; photo action at top/right 8px. Visible photo approximately 256px square. |
| `.p-r_member_profile_section` | Flex column, 16px padding, divider between sections. |
| `.p-r_member_profile__name__text` | Lato, 22px/30px, weight 900; Edit button aligned to the right. |
| `.p-r_member_profile_section_header` | 15px/22px, weight 900, 16px bottom margin. |
| `.p-rimeto_member_profile_field__label` | 13px/18px, weight 700, secondary text color. |
| `.p-edit_profile--wide` | 700px dialog; 8px outer radius. |
| `.p-edit_profile__columns` | Main fields beside 192px photo column, 32px separation. |
| `.c-input_text--large` | 44px height, 12px padding and radius, 18px/24px type. |
| `.p-custom_status_modal` | 520px dialog, 8px outer radius. |
| `.p-custom_status_modal__input_action` | 40px-wide emoji prefix and clear action wrapper. |
| `.p-custom_status_modal__preset_container` | 28px rows, blue #1264a3 hover/focus, white text. |
| `.p-custom_status_modal__preset_text` | Weight 700, emoji gap 10px, secondary duration text. |
| Modal action buttons | 36px height, 8px radius, 15px weight 700; primary computed #177e56. |

The observed dark surface is #1a1d21 and text is #d1d2d3. Space uses its existing theme tokens, Lato font and Phosphor icons around these structures. Dimensions above are CSS pixels; fractional measurements were rounded only when they match shipped fixed values.

## Observed behavior

The account menu links to Profile, Update your status, active/away and Account settings. The profile pane separates identity and contact information. Editing exposes full name, display name, title, photo, pronunciation and time zone. Contact fields can be edited separately in Slack.

The status dialog initially shows five presets: In a meeting (1 hour), Commuting (30 minutes), Out sick (Today), Vacationing (scheduled/never-clearing UI), and Working remotely (Today). Choosing In a meeting filled only the unsaved draft and revealed Duration and Pause notifications. Duration options were Don't clear, 30 minutes, 1 hour, 4 hours, Today, This week, and Choose a start and end time. The inspected draft was cancelled. Slack also advertises Cmd+Shift+Y.

## Space implementation boundaries

This first slice implements the signed-in user's profile and manual availability, using existing `/v1/me` authorization. Profile fields, normalized JPEG photo, presence and atomic status persist in PostgreSQL. `013_user_profiles.sql` adds fields without changing existing display names. Status reads hide expired values; the open client also checks its clock. Today is computed in the profile time zone, including DST offset changes. Explicit custom expiration uses the browser time zone and says so in the form.

On wide screens the profile pane reserves 475px beside the chat; on narrower screens it overlays the chat and adapts to the available width. The edit dialog keeps its actions fixed while fields scroll. Contact information shares the profile editor. These are authored Space adaptations. Profiles and status currently belong to the global Space user identity. This does not implement workspace-specific profiles, other people's profile views, idle/offline detection, calendar synchronization, audio pronunciation, future scheduled statuses, or notification pausing. These controls are not advertised as functional.

Photo input accepts JPG/PNG/WebP up to 5 MB, crops to a 192px square in the browser, and persists JPEG data capped at 200 KB. SVG and arbitrary remote URLs are rejected. The existing shared dialog/popover components handle keyboard dismissal and native modal focus. Failed saves retain drafts; cancel never sends a profile patch.


## Verification

The later [full E2E run](../profile-status-e2e.md) supersedes the browser-upload, screenshot and shared-server limitations below: real photo uploads and all implemented Profile/Status flows were exercised against real services, and final state was verified on the shared app. The earlier results remain as the implementation-pass record.

- Full UI suite: 154 tests passed (69 shared UI, 85 web). The seven profile tests cover StrictMode save/photo behavior, failed saves retaining edits, cancel, timed presets, clearing status, manual availability, an existing status expiring during editing, and timezone/DST calculation. Photo decoding/canvas are stubbed in the component regression; API photo limits/validation are real.
- Profile contracts and workspace integration: 10 tests passed in an isolated PostgreSQL schema, including profile/status/photo persistence, expiration and actor isolation.
- Workspace typecheck: 19 tasks passed. Full build passed; Vite reports dependency-level motion directives as warnings.
- Real browser against a separate local PostgreSQL schema and synthetic account: edited full/display name, title, pronunciation and timezone; saved a one-hour status; reloaded and observed both saved profile and status. The desktop pane measured 475px. At 390px the pane measured 338px with document width 390px. At 320px the edit dialog measured 296px with equal scroll/client widths and no horizontal document overflow. Viewport overrides were reset.
- Photo selection through the browser extension was blocked by its file-URL access setting. No extension permissions changed. Automated tests cover the upload/normalization/save path; a real browser photo upload is not claimed.
- A recurring extension popup blocked the last screenshot pass after adding the fixed modal footer. Earlier browser captures and measurements are retained; the final footer adjustment is build-checked, not visually re-verified.

Synthetic-account screenshots are in `/Users/kai/.codex/visualizations/2026/11/03/01a1a0e8-95d9-70f2-acad-e83f479a07e4/`: `space-profile-desktop.png`, `space-profile-mobile.png`, `space-profile-edit-320.png`, `space-profile-edit-desktop.png`, and `space-status-desktop.png`. These show an isolated QA account, not the user's actual profile.

The isolated preview runs at `http://127.0.0.1:5176/chat`. The shared API at port 3000 was not restarted and its database was not migrated by this pass: a concurrent workspace-only change adds migration 014, and applying that unrelated table-removal migration is outside this Profile/Status change. Activating the feature on that shared server requires its normal coordinated migration/build restart. The synthetic preview applies all source migrations only to its own new schema.
