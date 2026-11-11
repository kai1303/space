# Space mobile app (first version)

Add `apps/mobile` (`@space/mobile`), an Expo + React Native + TypeScript app for iOS and Android. The first version lets a signed-in member read and send channel messages in realtime. It talks to the existing `apps/server` API and does not change chat behavior.

## Scope

In scope:

1. Sign in with email and password, sign out, and session expiry handling.
2. Workspace channel list for the signed-in member.
3. Channel conversation: load recent history, page older history, send a text message, and receive new messages live.

Out of scope for this version: direct messages, threads, agents and agent sessions, files and previews, mentions UI, search, huddles and calls, push notifications, sign-up and email verification, offline send queue. Each gets its own spec later.

## Workspace layout

```
apps/mobile/
  app.json              Expo config (scheme `space`)
  metro.config.js       pnpm workspace resolution
  app/                  Expo Router routes
    _layout.tsx         session owner + auth gate
    sign-in.tsx
    (app)/index.tsx     channel list
    (app)/channels/[channelId].tsx
  src/
    features/
      auth/             sign-in screen, session store
      channels/         channel list
      chat/             timeline, composer, history paging
    shared/
      api/              fetch wrapper with auth headers and error mapping
      realtime/         socket.io session owner
      storage/          expo-secure-store wrapper
      config.ts         server base URL
  test/
```

It follows the web split: product behavior in `features`, infrastructure in `shared`. `features` must not import from `app`; `shared` must not import `features`. The app does not import `@space/ui` or `apps/web`, because both target the DOM. It may import `@space/contracts` for request and event types. It must not import server-only packages.

`pnpm-workspace.yaml` already includes `apps/*`. Add root scripts `mobile` (`pnpm --filter @space/mobile start`) and wire `typecheck` and `test` into Turbo. Metro needs `watchFolders` set to the repo root and `nodeModulesPaths` for both the app and root `node_modules`, so hoisted pnpm packages resolve. `@space/contracts` must build before the mobile bundle and typecheck; declare it as a `workspace:*` dependency so Turbo orders it.

## Authentication

The server uses Better Auth with a custom JWT session cookie (`apps/server/session-jwt.ts`). `apps/server/api.ts` rejects any cookie-carrying write whose `Origin` is not trusted, and the session plugin checks `Origin` too. Native apps send no `Origin` header by default.

Approach: use Better Auth's Expo integration.

- Server: add the `@better-auth/expo` server plugin to `createAuthentication`. Operators add the app origin (`space://`) to `AUTH_TRUSTED_ORIGINS`; nothing is trusted by default.
- Client: `createAuthClient` with `expoClient({ scheme: 'space', storage: SecureStore })`. The plugin stores the session cookie in the device keychain and attaches it to auth requests.
- Non-auth API calls and the socket handshake go through `shared/api`, which sets `Cookie` from secure storage and `Origin: space://` on every request. The existing origin check then applies unchanged.

The session token lives only in `expo-secure-store`. It is never logged or kept in plain `AsyncStorage`. A 401 from the API, or `session.revoked` from the socket, clears storage and routes to sign-in. Sign-out calls the server sign-out endpoint, then clears storage even if the call fails.

The plan must confirm that the JWT session plugin's origin check and cookie rewriting accept these requests, and adjust only if a test proves they do not.

## Realtime

One socket.io connection per signed-in session, owned by the root layout (the mobile counterpart of the web `SocketSession`). Features subscribe through it and unsubscribe on unmount. Settings mirror the web client: websocket transport, explicit connect, backoff from 1 s to 30 s with jitter, one session recovery attempt before treating the session as expired.

App state handling uses React Native `AppState` events, not a timer:

- Going to background disconnects the socket.
- Returning to foreground reconnects, then refetches history after the newest message the screen holds, through the same paged history API. This is the durable recovery path for anything missed while disconnected.

Incoming events are merged by message id, so a message that arrives both live and from the catch-up fetch shows once.

## Chat

- History: request recent messages for the channel, then older pages on scroll to top. Page size and request shapes match the web `useMessageHistory`.
- Send: the composer emits `message.send` on the socket with a client-generated `client_message_id`, matching the web `message-outbox.ts` contract. The message shows as pending until a server message with the same `client_message_id` and author arrives. A failed send stays in the list with a retry action that reuses the same `client_message_id`.
- Message text renders as plain text in this version. Rich formatting can follow later.
- Payload and list sizes are bounded: one page in flight at a time and a capped number of messages kept in memory per channel.

## Configuration

The server base URL comes from `EXPO_PUBLIC_SPACE_URL`. Development builds may use `http://` against a LAN address; release builds require `https://`. No secrets live in the app bundle.

## Error handling

- Network failure: show an inline banner and keep the last loaded data.
- 401 or revoked session: clear the session and route to sign-in.
- 403 on a channel: show a no-access state and return to the channel list.
- Other server errors: map through a shared error-text helper, like web `error-text.ts`.

## Testing

- Unit tests (Jest with `jest-expo` and React Native Testing Library): session store, API wrapper headers and 401 handling, history merge and dedupe, send pending, failure and retry with a stable `client_message_id`, socket lifecycle on `AppState` changes.
- Server test: a request with `Origin: space://` and a mobile session cookie succeeds when that origin is configured, and fails when it is not.
- Manual check on the iOS simulator and an Android emulator against a local stack: sign in, open a channel, send from mobile and see it on web, send from web and see it on mobile, background the app, send from web, foreground, and confirm the missed message appears once.

## Done when

The app builds with `pnpm mobile` in Expo Go or a development build, all tests above pass in CI, `pnpm typecheck` covers the app, and the manual check passes on both platforms.
