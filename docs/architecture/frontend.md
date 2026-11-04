# Frontend structure

Space uses a pnpm/Turborepo monorepo with a React/Vite web application and a shared React UI package. The desktop application continues to host the same web UI.

```text
apps/web/src/
  main.tsx                    Browser entry and global styles
  app/
    App.tsx                   Route selection
    AppProviders.tsx          StrictMode and motion configuration
    Chat.tsx                  Authentication and signed-in session boundary
    ChatWorkspace.tsx         Application composition
    navigation/               Destination state and navigation actions
    shell/                    Application chrome and workspace switcher
  features/
    auth/                     Authentication screens and client
    chat/                     Channel/thread rendering and message history
    channels/                 Channel discovery, details, and starring
    composer/                 Drafts, uploads, and message sending
    direct-messages/          DM discovery and recipient selection
    agents/                   Agent requests, sessions, and activity
    mentions/                 Mention search and inbox
    notifications/            Delivery, activity, and unread state
    files/                    Upload transport, lists, and previews
    memory/                   Channel memory and provider connections
    todos/                    Personal tasks and source-message links
    profile/                  Profile and presence settings
    workspace/
      collections/            Workspace collections and destinations
      invitations/            Invitations and acceptance
      members/                Membership and agent access management
      settings/               Workspace settings
  shared/
    api/                      HTTP requests and error presentation
    realtime/                 Shared socket transport and subscriptions
    branding/                 Space logo
    ui/                       Presence and snapshot infrastructure
  gallery/                    Design-system gallery and workspace preview
    examples/                 Interactive component demonstrations

packages/ui/src/
  primitives/                 Buttons, dialogs, menus, and panels
  navigation/                 Sidebar, icons, and search UI
  conversation/               Message presentation and actions
  composer/                   Plain and rich editors
  rich-text/                  Document rendering and code highlighting
  agents/                     Agent response, approval, and work-item UI
  emoji/                      Emoji data and picker
  motion/                     Shared motion behavior
  styles/                     Shared CSS and design tokens
```

## Ownership and dependencies

- `app` composes features and owns navigation. Features receive app-owned chrome through props rather than importing the application shell.
- Features own product behavior, local state, tests, and styles. Keep related files together; create subdirectories when a feature has distinct responsibilities.
- `shared` contains application infrastructure and must not import from `app`, `features`, or `gallery`.
- Features must not import production code from `app` or `gallery`. Integration tests can compose the application to verify user flows.
- `packages/ui` contains reusable presentation and interaction behavior. It does not import application code, call Space endpoints, or own authenticated session state.
- `packages/contracts` remains the shared source for API data and validation. Backend services, adapters, scripts, and integration tests retain their existing locations.

The signed-in `SocketSession` remains keyed by user and session in `Chat.tsx`. Navigation must not create another connection owner. Existing subscription recovery, revocation cleanup, idempotent sending, draft isolation, and bounded history remain part of the behavior contract. The no-polling and no-explicit-lock rules in [principles.md](principles.md) still apply.

## UI package imports

Use the package's declared subpaths, never relative imports into another workspace package:

```tsx
import { Button, Dialog } from '@space/ui/primitives';
import { RichComposer } from '@space/ui/composer';
import { RichContent } from '@space/ui/rich-text';
import { Message } from '@space/ui/conversation';
import '@space/ui/styles.css';
```

The existing `@space/ui` root export remains compatible. Specific leaf exports are also available, such as `@space/ui/rich-text/code-block`. CSS and token package URLs remain unchanged even though their source files now live under `styles/`. Package build output stays under `dist/`.

## Verification and development

```sh
pnpm web
pnpm --filter @space/ui build
pnpm --filter @space/web build
pnpm typecheck
pnpm test:ui
pnpm --filter @space/web exec vitest run src/app/Chat.test.tsx
```

Tests live beside the behavior they exercise; application integration tests live in `app`. Existing research reports and completed historical plans may name pre-migration paths. For current source, use the ownership map above.
