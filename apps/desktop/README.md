# Space for macOS

Space Desktop loads your Space web deployment and includes the local agent connector. Install the app and your provider CLI on the Mac. In the workspace’s agent setup, select **Local runner**, choose a provider, then **Connect on this Mac**. Confirm the server in the native dialog. Codex opens ChatGPT authorization in your browser. Kiro and Claude display their own sign-in prompts in a local window when needed.

The app keeps each paired provider running when you close the workspace window. Quitting stops the runners. Opening Space restores them for the configured server. Desktop pairings use separate private profiles under the Space application data directory. Pairing grants chat access. Project folders and coding mode still require the connector CLI.

In a Mac browser, **Open Space Desktop** carries the workspace and selected provider into the app. Sign in to Space Desktop if prompted and confirm pairing there. Opening a different server requires native confirmation. Switching servers stops the previous server’s runners.

## Personal browser

Open the globe in the Space top bar or press **⌘T** to open a browser tab. The browser opens beside chat. Drag the vertical divider to resize the panes, or focus it and use the left and right arrow keys. **Enter full view** expands the selected tab, and **Enter split view** brings chat back. **⌘⇧B** shows or hides the panel, or returns from full view to split view. **⌘1** returns to chat. Tabs stay open when you return to Space. Site cookies and local storage persist on this Mac in a browser profile specific to the signed-in Space account and server. Sites control when their sessions expire.

Choose **Ask Codex** on an open page, enter a task and select **Start task**. This uses the locally installed Codex CLI and its sign-in. Space sends the task, visible page text and control labels to Codex. It can follow links within the site, expand sections, switch tabs within a page, change select filters, fill search fields and scroll. **Take over**, switching browser tabs, returning to Space and closing the tab cancel control. Sign-in and payment fields require manual interaction.

Run `pnpm --filter @space/desktop test:browser` for the two-launch Electron test. Set `SPACE_BROWSER_TEST_REAL_AGENT=1` to exercise the installed Codex CLI against the synthetic dashboard.

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

The desktop icon has a curved purple orbit on a white or black tile. Electron updates the Dock icon from the PNGs in `assets/` when the system appearance changes. Forge compiles `Space.icon` for Finder using macOS 26 or later and Xcode 26 or later, and includes `assets/space-icon.icns` for older systems.

Edit `desktop.config.json` before packaging to set the default deployment. A local configuration at `~/Library/Application Support/Space/desktop.json` overrides that default:

```json
{ "url": "https://your-space.example/chat" }
```

`SPACE_DESKTOP_URL` takes precedence over either file. Close Space completely with Command-Q before changing its configuration. A malformed local configuration prevents startup and shows an error rather than silently connecting elsewhere.

## Desktop behavior

- Command-Q quits; closing the window keeps the application running on macOS. Clicking its Dock icon or choosing File → Open Space reopens the window.
- Sessions persist in Electron's `persist:space` partition in the Space application-data directory. Sign-in is independent of browser sessions.
- Standard Edit, View, and Window menus provide copy/paste, reload, zoom, and fullscreen controls.
- Same-origin links stay inside Space; other HTTP(S) and mail links open in the default application. Other protocols and cross-origin redirects are blocked. The registered space-desktop scheme accepts workspace and provider selections for pairing.
- Space attachment downloads use the authenticated desktop session and follow signed storage redirects through Electron's downloader, keeping the chat window on Space.
- Failed page loads offer a manual Retry action. There is no background resource polling.
- Renderer sandboxing, context isolation, and web security are enabled. The sandboxed workspace renderer can request a chat pairing through a single preload method. The main process checks the originating frame and deployment, validates the request and asks for native confirmation. Provider sign-in runs outside the workspace renderer.

## Verify

```sh
pnpm --filter @space/desktop build
pnpm --filter @space/desktop test
pnpm --filter @space/desktop test:smoke
pnpm desktop:package
node --test tests/e2e/desktop-pairing.test.mjs
```

`build` checks the main-process JavaScript syntax. Unit tests cover URL and navigation policy. The smoke test launches real Electron against a temporary local fixture, checks renderer isolation, navigation and popup restrictions, authenticated downloads through storage redirects, and cookie persistence across a full application restart. It cleans up its isolated profile. Run it in a graphical macOS session; it does not authenticate to your actual Space deployment.

For an opt-in integration check against a running local Space deployment:

```sh
SPACE_DESKTOP_TEST_URL=http://127.0.0.1:5174/chat pnpm --filter @space/desktop test:live
```

Use a stable frontend build with API and WebSocket routing (a Vite preview server works); hot reload can interrupt the test. The URL must use loopback HTTP. This test creates synthetic accounts and a private workspace in that local database; those records remain afterward. It uses and deletes a separate Electron profile, and does not touch your open Space window. A bounded test proxy cuts only that profile's connection to check replay after reconnect, message idempotency, and hidden-window unread state. A second process checks persisted login/history and session revocation. It does not invoke a real agent provider or suspend the Mac.

See the [verification record](../../docs/superpowers/plans/2026-11-04-macos-desktop-verification.md) for observed results and remaining checks.

## Release scope

Set `SPACE_SIGN_IDENTITY` to the Developer ID Application identity and `SPACE_NOTARY_PROFILE` to an Apple notarytool keychain profile when preparing a signed and notarized application. Builds without these credentials are development artifacts.

`pnpm desktop:make` stages the architecture-specific DMG and download manifest in `apps/web/public/downloads/`. Build the web frontend after making the installer, or serve those files under `/downloads/` on the deployment. To use a separately hosted download page, set `VITE_SPACE_MAC_DOWNLOAD_URL` when building the web app.
