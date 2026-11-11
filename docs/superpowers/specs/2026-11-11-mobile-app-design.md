# Space mobile app (first version)

Add `apps/mobile` (`@space/mobile`), an Expo + React Native + TypeScript app for iOS and Android. The first version lets a signed-in member read and send channel messages in realtime. It talks to the existing `apps/server` API and needs no server change.

## Scope

In scope:

1. Sign in with email and password, sign out, and session expiry handling.
2. Pick a workspace (skipped when the member has exactly one), then list its joined channels.
3. Channel conversation: load recent history, page older history, send a text message, and receive new messages live.

Out of scope for this version: direct messages, threads, agents and agent sessions, files and previews, mentions UI, search, huddles and calls, push notifications, sign-up and email verification, offline send queue. Each gets its own spec later.

## Workspace layout

```
apps/mobile/
  app.json                Expo config (scheme `space`)
  app/                    Expo Router routes
    _layout.tsx           AuthProvider
    sign-in.tsx
    (app)/_layout.tsx     auth gate + realtime session owner
    (app)/index.tsx       workspace list
    (app)/workspaces/[workspaceId].tsx   channel list
    (app)/channels/[channelId].tsx       conversation
  src/
    features/
      auth/               AuthProvider, sign-in screen
      channels/           channel list
      chat/               history window, outbox, conversation screen
      workspaces/         workspace list
    shared/
      api/                cookie jar, session client, request helpers
      realtime/           socket.io session owner
      storage/            expo-secure-store wrapper
      config.ts           server base URL
```

It follows the web split: product behavior in `features`, infrastructure in `shared`. `features` must not import from `app`; `shared` must not import `features`. The app does not import `@space/ui` or `apps/web`, because both target the DOM. It uses `import type` only from `@space/contracts`, so no contracts runtime code enters the bundle. It must not import server-only packages.

`pnpm-workspace.yaml` already includes `apps/*`, and Expo detects pnpm monorepos and configures Metro itself, so the app ships no custom `metro.config.js`. Add a root `mobile` script (`pnpm --filter @space/mobile start`). The app's `typecheck` and `test` scripts join the existing Turbo tasks; `@space/contracts` is a `workspace:*` dependency so Turbo builds its types first.

`src/features/chat/history-window.ts` is a copy of the web file of the same name, with its tests. Moving it into a shared package is a separate change.

## Authentication

The server uses Better Auth with a 15-minute access JWT cookie and a rotating refresh cookie (`apps/server/session-jwt.ts`). Cookie-carrying writes, `/v1/auth/refresh` and the Socket.IO handshake all require an `Origin` in the trusted set, which always contains the server's own origin.

Approach: the app is a native client, so it handles cookies and `Origin` itself. No server plugin and no new trusted origin.

- Every request sends `Origin` equal to the server's own origin (from `EXPO_PUBLIC_SPACE_URL`) and `credentials: 'omit'`, so the platform cookie store is not used.
- A small cookie jar keeps the `Set-Cookie` values from each response and sends them back as a `Cookie` header. The jar is saved in `expo-secure-store` and nowhere else. It is never logged.
- Renewal follows the web `session-fetch.ts` rules: renew before a request once the access deadline (`x-space-access-expires`) has passed, renew once on a 401 with `x-space-auth-required`, and share a single renewal between concurrent callers.
- A failed renewal, or a second socket `unauthorized` after one renewal, clears the jar and routes to sign-in. Sign-out calls the server, then clears the jar even if the call fails.

Why not a custom scheme origin such as `space://`: `new URL('space://').origin` is the string `"null"`, so adding it to `AUTH_TRUSTED_ORIGINS` would also trust `Origin: null`, which sandboxed browser frames send. The `Origin` check protects browsers from cross-site requests. A native app is not a browser, so sending the server's own origin gives up nothing.

## Realtime

One socket.io connection per signed-in session, owned by `app/(app)/_layout.tsx` (the mobile counterpart of the web `SocketSession`). It sends the cookie jar and `Origin` as handshake headers, and rebuilds them before each connect. Features subscribe through it and unsubscribe on unmount. Commands are sent one at a time, because the server answers `busy` to a second command in flight. Settings mirror the web client: websocket transport, explicit connect, backoff from 1 s to 30 s with jitter, one session renewal before treating the session as expired. After any renewal the socket reconnects with the new cookie.

App state handling uses React Native `AppState` events, not a timer:

- Going to background disconnects the socket.
- Returning to foreground reconnects. On `connect` the open channel sends `channel.subscribe` with the last event cursor it saw, and the server replays every event after it. This is the same durable recovery the web client uses.
- If the server answers `invalid_cursor`, the screen reloads the latest history page and subscribes from its `event_cursor`.

Incoming messages are merged by id, so a message that arrives both from replay and from history shows once.

## Chat

- History: `GET /v1/channels/:id/messages`, then older pages with `?before=<older_cursor>`. The screen keeps at most 500 messages (the web `HISTORY_LIMIT`) and loads one page at a time. Thread replies are hidden, as in the web channel view.
- Send: the composer emits `message.send` on the socket with a client-generated `client_message_id`, matching the web `message-sender.ts` contract. The message shows as pending until a server message with the same `client_message_id` and author arrives. A failed send stays in the list with a retry action that reuses the same `client_message_id`. Text is capped at 16,000 characters, the server limit, and at most 50 messages can be pending.
- Message text renders as plain text in this version. Rich formatting can follow later.

## Configuration

The server base URL comes from `EXPO_PUBLIC_SPACE_URL` and must be an origin with no path. Development builds may use `http://` against a LAN address; release builds require `https://`. No secrets live in the app bundle.

## Error handling

- Network failure: show an inline banner and keep the last loaded data. A failed start-up session check shows a retry screen and keeps the stored session.
- 401 or revoked session: clear the session and route to sign-in.
- 403 or 404 on a channel: show a no-access state with a way back to the channel list.
- Other server errors: map through a shared error-text helper, like web `error-text.ts`.

## Testing

- Unit tests (Jest with `jest-expo` and React Native Testing Library): config validation, cookie jar parsing, session client (sign-in, renewal, expiry, shared renewal), request errors, realtime session (headers, renewal, command order), history merge and dedupe, outbox pending, failure and retry with a stable `client_message_id`, sign-in screen.
- Server test in `tests/integration/auth.test.ts`: a client that sends only explicit `Cookie` and same-origin `Origin` headers can sign in, write, renew and open a socket with the renewed cookies.
- Manual check on the iOS simulator and an Android emulator against a local stack: sign in, open a channel, send from mobile and see it on web, send from web and see it on mobile, background the app, send from web, foreground, and confirm the missed message appears once. Sign out and confirm the app cannot read `/v1/me`.

## Done when

The app starts with `pnpm mobile` in Expo Go, all tests above pass, `pnpm typecheck` covers the app, and the manual check passes on both platforms.
