# Space UI

A shared React design system for the Slack-style Space workplace. The first milestone is reusable foundations and components, with an interactive gallery. The follow-up `/workspace` preview reconstructs Slack-style composer, search, color-token and sidebar interactions; see [the research report](research/slack-workplace.md). The full chat application and backend integration remain separate work.

## Run

```sh
pnpm install --frozen-lockfile
pnpm web
```

Open http://127.0.0.1:5173/design-system. The gallery needs no database, model key, or login. The main app is now at `/` and `/chat`; legacy root hash links continue to open the gallery. `pnpm web` builds the UI package before starting Vite. After changing `packages/ui`, run `pnpm --filter @space/ui build` to refresh its compiled exports. Vite watches the gallery source. `pnpm dev` also includes the existing backend/worker tasks, which need a database.

## Consume the system

`@space/ui` lives in `packages/ui`; `@space/web` in `apps/web` demonstrates it. Add `"@space/ui": "workspace:*"` to another frontend package.

```tsx
import '@fontsource/lato/400.css';
import '@fontsource/lato/700.css';
import '@fontsource/lato/900.css';
import '@space/ui/styles.css';
import { Button, Composer, Message, Badge } from '@space/ui';

<Button variant="primary" onClick={createChannel}>Create channel</Button>
<Badge tone="warning" dot>Needs approval</Badge>
<Message author="Alex Morgan" initials="AM" time="10:42 AM">
  A little consistency goes a long way.
</Message>
<Composer channel="general" onSend={sendMessage} />
```

Consumers load their chosen font. The gallery bundles Lato locally through `@fontsource/lato`; components fall back to system sans-serif. UI CSS does not reset the consuming app's entire document. Components carry `sp-` class names and use `--sp-` tokens. `@space/ui/tokens.css` is available independently. `data-theme="light"` or `data-theme="dark"` on an ancestor sets semantic colors. Use the tokens directly in application CSS:

```css
.channel-header {
  color: var(--sp-text);
  background: var(--sp-surface);
  border-bottom: 1px solid var(--sp-border);
  padding: var(--sp-space-4) var(--sp-space-6);
}
```

### Foundations

| Foundation | Tokens and intent                                                                                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color      | `surface`, `surface-raised`, `surface-subtle`, `surface-hover`; `text`, `text-secondary`, `text-tertiary`; `border`, `border-strong`; `accent`, `success`, `info`, `warning`, `danger`, plus contrasting/soft variants |
| Typography | `font-sans`, `font-mono`; `text-xs` 12, `text-sm` 13, `text-md` 15, `text-lg` 18, `text-xl` 22, `text-display` 36px; body line height 1.46667                                                                          |
| Spacing    | `space-1` 4, `space-2` 8, `space-3` 12, `space-4` 16, `space-5` 20, `space-6` 24, `space-8` 32, `space-10` 40, `space-12` 48px                                                                                         |
| Radius     | `radius-sm` 4, `radius-md` 6, `radius-lg` 8, `radius-xl` 12px, `radius-full`                                                                                                                                           |
| Geometry   | Control sizes 28/36/44px; workspace rail/sidebar/topbar tokens; gallery adds responsive adaptations                                                                                                                    |
| Elevation  | `shadow`, `shadow-modal`, `overlay`; native modal top layer                                                                                                                                                            |
| Motion     | `motion-fast` 120ms, `motion-normal` 180ms; zero-duration transitions and no spinner rotation under reduced motion                                                                                                     |
| Icons      | Phosphor regular SVGs, generally 16–20px; import named icons from `@phosphor-icons/react`                                                                                                                              |

### Components

| Export        | Contract                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`      | Native button props; `variant` primary/secondary/ghost/danger; `size` sm/md/lg; `loading` disables it and exposes `aria-busy`; defaults to `type="button"`                                                                                  |
| `IconButton`  | Requires `label`; retains native button semantics, visible focus, accessible name and title                                                                                                                                                 |
| `Badge`       | Text plus optional `dot`; semantic neutral/accent/success/info/warning/danger tones                                                                                                                                                         |
| `Avatar`      | Required `name` and `initials`; sm/md/lg; purple/blue/green/orange; optional online/away/offline presence included in accessible label                                                                                                      |
| `TextField`   | Native input props plus `label`, `hint`, `error`; generates IDs and description associations; errors expose `aria-invalid`                                                                                                                  |
| `Switch`      | Controlled `checked`, `onChange`, `disabled`, `label`; native button with switch semantics                                                                                                                                                  |
| `Tabs`        | Controlled `value`, `onChange`, `items`, `label`; arrow/Home/End keys, wrapping roving focus; optional `panelId` links each item to a consumer-owned panel                                                                                  |
| `Menu`        | Native details/summary disclosure with action buttons; normal Tab order, outside-click dismissal, Escape dismissal with focus return; intentionally does not claim ARIA menu keyboard behavior                                              |
| `Dialog`      | Controlled `open`, `onClose`, `title`, optional `description`, children; native modal focus containment, Escape and backdrop dismissal, focus restoration                                                                                   |
| `Skeleton`    | Decorative `width`/`height`; caller supplies a single labeled status for a group                                                                                                                                                            |
| `ChannelItem` | Controlled selected/unread state and callback; provide a descriptive icon; does not perform authorization                                                                                                                                   |
| `Message`     | Author/time/initials/content, optional agent badge, controlled reactions, reply count/callback; reply action appears on hover and keyboard focus                                                                                            |
| `Composer`    | `channel`, `onSend`, optional `compact`; trimmed nonempty submissions; plain text with Markdown delimiter shortcuts; Enter sends, Shift+Enter inserts a line; IME Enter does not send; serializes pending sends and preserves failed drafts |

`Composer` clears after its callback resolves; reject the callback to keep the draft and show an error. Drafts and demo messages are held in memory, not persisted. A channel-owning screen should key/remount or explicitly own drafts when switching contexts. Plain text is escaped by React; no HTML or Markdown renderer is included. Formatting buttons insert delimiters and do not claim rich-text editing.

The gallery's form validation is demonstration behavior, not a shared backend channel policy. Created example names appear in the overlay specimen and disappear on reload. Menu/button samples explicitly acknowledge selected demo actions; they do not operate on a real workspace.

## Source evidence and adaptations

On 2026-11-03, the open authenticated Slack web UI in the user's Brave browser was inspected read-only through the connected browser. The capture was one desktop channel in its existing dark custom theme. No Slack messages were sent or edited. No private messages, workspace names, identifiers, account data, scripts, proprietary icon paths or custom font files were copied into the implementation.

Observed computed styles: Slack-Lato/Slack-Fractions stack; body 15px/22px; secondary controls 13px/18px; heading controls 18px/24px; compact 28px icon controls; common 4/6/8px radii; 4px spacing increments; dark primary surface `#1a1d21`; composer surface `#222529`; foreground `#d1d2d3`; secondary foreground `#b9babd`; aubergine palette values including `#611f69` and `#4a154b`.

Authored choices: the Space wordmark and gallery layout; light theme; semantic feedback/accessibility colors; accessible keyboard behavior; mobile adaptations; synthetic participants and agent examples. Open-source Lato substitutes Slack-Lato and Phosphor substitutes Slack's custom icons. This is a Slack-grounded foundation, not an assertion of pixel parity with every Slack theme or feature.

REA's [reverse-engineer-anything skill](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/SKILL.md) was read and installed under `/Users/kai/.agents/skills/reverse-engineer-anything`. Its guidance informed the separation of observations, inferences, and unknowns. **The current design measurements are browser evidence, not REA tool output.** REA 6.8.0 was acquired with a cached Node 24.22.1 runtime because the system Node 25.2.1 is outside REA's supported range. Skill-only setup succeeded. No Codex MCP registration was added and no restart is required for this gallery. A subsequent workplace slice ran actual REA CLI static analysis on two browser-exported loaded bundles; see [the evidence and boundaries](research/slack-workplace.md). Direct REA browser attachment remains unperformed.

The upstream REA [browser guide](https://github.com/morluto/rea/blob/main/docs/browser-observation.md) describes its observation/capture tools. For deeper analysis in a subsequent slice, register the MCP with a supported runtime or use its CLI and a deliberately exposed debugging endpoint; do not claim that installing the skill connects those tools.

## Verification

```sh
pnpm test:ui
pnpm typecheck
pnpm build
pnpm test:contracts
```

The original 11 interaction/regression tests exercise native dialog dismissal, channel draft/thread isolation, loading-button safety, error-description associations, keyboard tabs, whitespace/IME/Shift+Enter handling, trimmed successful sends, draft retention on failure, pending-send deduplication and controlled reactions. Browser checks and their observed outcomes are recorded in `docs/design-system-qa.md`.

Database integration and live agent behavior are outside this design-system slice. Nothing in the gallery is proof of production authorization, networking, durable messaging or agent interoperability.

## Workplace components

The additional exports are `RichComposer`, `RichContent`, `WorkspaceSidebar`, `WorkspaceSearch`, `parseSearch`, `searchMessages`, `normalizeDocument`, `safeLink`, and `documentText`, with their related public types. The original plain `Composer` remains available.

`RichComposer` accepts `channel`, `defaultValue`, `defaultAttachments`, `onDraftChange`, `onAttachmentsChange`, `mentions`, and `onSend(text, document, attachments)`. Key it by conversation and store both draft callbacks in the parent, as `/workspace` does. Rich documents contain text operations with allowed inline and block formatting; render them with `RichContent`. Never inject editor HTML into message display. File entries represent local metadata, not uploaded bytes.

The main chat uses the full composer with stored links, lists, inline formatting, quotes and code blocks in channels and threads. `attachmentsEnabled={false}` keeps uploads unavailable until file transport exists. The optional `plainText` mode remains for consumers with a text-only transport. Shared document types live in `@space/contracts`; the editor preserves oversized drafts and blocks overly large serialized formatting before send. `WorkspaceSidebar` supports optional `workspaceControl`, `footer`, and `onCreateChannel` so the real app can show actual workspaces/profile data without the preview's synthetic profile. `WorkspaceSearch.scope` describes the authorized loaded-history boundary in its dialog.

`WorkspaceSidebar` is controlled through `channels`, `selectedId`, `onSelect`, `width` and `onWidthChange`. Its separator supports 180–450px, in 10px steps. `WorkspaceSearch` takes local message records, current channel, optional `initialQuery`, search/select callbacks and native-dialog open/close state. Message records can carry `links` so labeled rich URLs remain searchable.

The UI build also exports `@space/ui/tokens.json`: 56 resolved colors for each theme, generated from CSS rather than independently maintained. The web tokenizer uses this artifact for filtering/copying/export. Contextual editor, search and sidebar tokens are authored from the documented observations; sidebar transparency is retained as RGBA.

The combined UI/web suite has 115 tests as of the app-chrome pass. The gallery uses `RichComposer` for channel and thread examples at `/design-system#chat-composer`. See [composer research](research/slack-composer.md) and [composer QA](slack-composer-qa.md) for the recovered source behavior, fresh checks and remaining limits; [workplace QA](slack-workplace-qa.md) records the earlier workplace slice.

The main chat shell now has popover workspace controls in the sidebar and rail, in-memory conversation history, and a search field aligned to the sidebar boundary. The sidebar keeps its resized proportion across viewport changes. See [app chrome research](research/slack-app-chrome.md) for source measurements, inferred responsive sizing, verification, and remaining feature gaps.

`Message` accepts `actions: MessageActionHandlers` in addition to the controlled `onReact`/`onReply` callbacks. Only supplied application actions appear in its toolbar and More menu; callers retain authorization, confirmation, and persistence. Main chat currently connects copy and reply. `/design-system#message-actions` demonstrates all callbacks and a rich composer in an explicitly local preview. Both menus support keyboard navigation, outside dismissal, focus restoration, and viewport-clamped portal positioning. See [message and selection action research](research/slack-message-actions.md) for the captured HTML/styles, measured geometry, and implementation limits.

## Motion

The frontend uses [Motion for React](https://motion.dev/docs/react) (`motion/react`). A root `MotionConfig` respects the system motion preference; shared `motionTransition` supplies authored 180ms timing and cubic-bezier `[0.2, 0, 0, 1]`, with 120ms for composer pickers. Dialogs fade/scale in, emoji and mention panels rise in, sidebar groups reposition, the mobile drawer slides in, search results enter from the right, and newly submitted messages fade/rise in. Existing messages do not replay on channel navigation.

Reduced motion sets these durations to zero, removes entrance displacement, and disables sidebar layout animation. Native dialog/picker dismissal and mobile hiding remain immediate to preserve focus and keyboard behavior. CSS still handles small hover/switch feedback. These timings are authored for Space; Slack's exact animation durations and easing have not been measured.

`Message` accepts `arrival` to animate its first appearance. `useMessageArrivals(messages, context)` identifies newly added message IDs regardless of author, including multiple arrivals in one update. Use the active conversation ID as context, or null while its feed is hidden. Initial history, channel switches and revisiting a hidden feed stay still. The workspace uses this shared path for both sent and received entries; a real incoming transport is not connected yet. Replay the visual effect in the gallery at `/#message-motion` with **Receive a message**.

## Work and agent components

The gallery's Work & Agents section demonstrates `TicketCard`, `Alert`, `CodeBlock`, `ToolExecution`, and `AgentApproval`. Their public exports come from `@space/ui`. See [the source evidence and layout research](research/slack-action-components.md) before extending Slack-specific behavior.

| Component | Contract |
| --- | --- |
| TicketCard | Controlled `ticketId`, `title`, `status` (open/in_progress/done), optional description, priority, assignee and onOpen. |
| Alert | Title, children, info/success/warning/danger tone and optional onDismiss; warning/danger announce urgently. |
| CodeBlock | Code and language; language header, copy, line numbers, escaped syntax tokens and horizontal scrolling. JavaScript/TypeScript/JSON/Python/Bash load on demand; other languages remain plain text. |
| ToolExecution | Points with IDs/text/icons and optional in_progress status/substeps, optional summary and completed flag. Expansion/header rules follow the captured timeline. Source callbacks belong to the caller. |
| AgentApproval | Request identity, action title, agent, scope, children, optional tool names/destructive flags and custom button labels; controlled pending/approved/rejected/expired state and onDecide callback. |

Approval state resets per requestId internally. The decision callback returns void or a promise; rejected callbacks preserve the request and show an error. Callers bind decisions to their request identity and update controlled status after authoritative success. Components do not perform authorization, tool execution or persistence.
