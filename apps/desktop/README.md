# Space for macOS

Electron shell for the existing Space web application. This initial package loads a configured web URL; it does not bundle the React build, start backend services, or embed the local agent connector. Cookies, API calls, and Socket.IO keep the web application's existing origin.

## Run locally

From the repository root:

```sh
pnpm install --frozen-lockfile
# Start Space's backend services as described in the root README.
pnpm web
```

In another terminal:

```sh
pnpm desktop
```

The default URL is `http://127.0.0.1:5173/chat`. Use a different web deployment with:

```sh
SPACE_DESKTOP_URL=https://your-space.example/chat pnpm desktop
```

Use the **web frontend URL**, not a bare API endpoint. HTTPS is required except for HTTP on `localhost`, `127.0.0.1`, or `[::1]`. The web origin must already be configured correctly for authentication and API/WebSocket routing. No CORS or certificate checks are disabled by the desktop client.

## Build an application and installer

```sh
pnpm desktop:package   # Space.app for the current Mac architecture
pnpm desktop:make      # DMG and ZIP for the current Mac architecture
```

Apple Silicon output:

- `apps/desktop/out/Space-darwin-arm64/Space.app`
- `apps/desktop/out/make/Space-arm64.dmg`
- ZIP under `apps/desktop/out/make/zip/darwin/arm64/`

The DMG uses macOS's built-in `hdiutil`; Forge creates the app and ZIP. To request an Intel build, use `pnpm --filter @space/desktop make --arch=x64`. Test it on Intel hardware before distributing it.

Edit `desktop.config.json` before packaging to set the default deployment. A local configuration at `~/Library/Application Support/Space/desktop.json` overrides that default:

```json
{ "url": "https://your-space.example/chat" }
```

`SPACE_DESKTOP_URL` takes precedence over either file. Close Space completely with Command-Q before changing its configuration. A malformed local configuration prevents startup and shows an error rather than silently connecting elsewhere.

## Desktop behavior

- Command-Q quits; closing the window keeps the application running on macOS. Clicking its Dock icon or choosing File → Open Space reopens the window.
- Sessions persist in Electron's `persist:space` partition in the Space application-data directory. Sign-in is independent of browser sessions.
- Standard Edit, View, and Window menus provide copy/paste, reload, zoom, and fullscreen controls.
- Same-origin links stay inside Space; other HTTP(S) and mail links open in the default application. Other protocols and cross-origin redirects are blocked. Browser-based OAuth callbacks and custom deep links are not implemented.
- Space attachment downloads use the authenticated desktop session and follow signed storage redirects through Electron's downloader, keeping the chat window on Space.
- Failed page loads offer a manual Retry action. There is no background resource polling.
- Renderer sandboxing, context isolation, and web security are enabled. The renderer has no Node access, preload bridge, or IPC capabilities. Web permission requests are denied for this first version.

## Verify

```sh
pnpm --filter @space/desktop build
pnpm --filter @space/desktop test
pnpm --filter @space/desktop test:smoke
```

`build` checks the main-process JavaScript syntax. Unit tests cover URL and navigation policy. The smoke test launches real Electron against a temporary local fixture, checks renderer isolation, navigation and popup restrictions, authenticated downloads through storage redirects, and cookie persistence across a full application restart. It cleans up its isolated profile. Run it in a graphical macOS session; it does not authenticate to your actual Space deployment.

For an opt-in integration check against a running local Space deployment:

```sh
SPACE_DESKTOP_TEST_URL=http://127.0.0.1:5174/chat pnpm --filter @space/desktop test:live
```

Use a stable frontend build with API and WebSocket routing (a Vite preview server works); hot reload can interrupt the test. The URL must use loopback HTTP. This test creates synthetic accounts and a private workspace in that local database; those records remain afterward. It uses and deletes a separate Electron profile, and does not touch your open Space window. A bounded test proxy cuts only that profile's connection to check replay after reconnect, message idempotency, and hidden-window unread state. A second process checks persisted login/history and session revocation. It does not invoke a real agent provider or suspend the Mac.

See the [verification record](../../docs/superpowers/plans/2026-11-04-macos-desktop-verification.md) for observed results and remaining checks.

## Release scope

The generated artifacts are development builds, without Developer ID signing or notarization. Distribution to other users needs signing credentials, notarization, and testing on clean machines. No publishing or automatic updates are configured. Notifications, Dock unread badges, window-position persistence, locally bundled UI, desktop-controlled agents, and connector lifecycle management are follow-up work.
