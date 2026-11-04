# macOS desktop setup

**Goal:** Add an installable Electron client for the existing Space web application.

**Architecture:** The first desktop package loads a configured Space web origin. This preserves Better Auth cookies, relative API requests, and Socket.IO without modifying the active web/backend work. The backend and web deployment remain separate services. A locally bundled renderer, connector management, notifications, updates, and release signing are subsequent milestones.

**Tech stack:** Electron, Electron Forge, CommonJS main-process JavaScript, Node's test runner.

## Implementation

- [x] Add `apps/desktop` with package scripts, Forge configuration, and a default development URL. Expose root `desktop`, `desktop:package`, and `desktop:make` commands.
- [x] Test URL policy before implementation: HTTPS deployment origins and loopback HTTP only, no embedded credentials; reject non-web protocols and origin-confusion navigation.
- [x] Implement a sandboxed window with Node integration disabled, persistent session storage, native menus, single-instance activation, external-link handling, and an actionable load failure dialog. No preload or privileged renderer bridge is needed.
- [x] Add a real Electron smoke test using a loopback fixture, isolated temporary profile, renderer isolation assertions, same-origin navigation and popup restrictions.
- [x] Install pinned dependencies, run tests, package the app, create a DMG, and launch the packaged executable against the existing local Space web app.
- [x] Document local startup, deployment configuration, package output, and release limitations. Preserve unrelated changes and leave work uncommitted for review.

## Verification

Run `pnpm --filter @space/desktop test`, `pnpm --filter @space/desktop test:smoke`, `pnpm desktop:package`, and `pnpm desktop:make`. The smoke test must terminate its Electron process and remove its temporary profile. Confirm the actual packaged application loads Space; this alone does not prove authenticated chat or upload behavior.

## Results

- Policy tests: 3 passed; main-process and installer-script syntax checks passed.
- Real Electron smoke test passed both initial and restarted processes, including persisted cookies.
- Apple Silicon application, ZIP, and DMG built successfully. `hdiutil verify` reported a valid DMG checksum.
- Packaged app launched and its native accessibility tree showed the Space sign-in page at the configured local web origin. Actual account authentication, chat, and uploads were not exercised.
- Standard Forge DMG tooling required obsolete native addons on this host; the post-make hook instead uses the macOS system `hdiutil`.
- Dependency installation passed with the frozen lockfile. Unrelated working-tree edits remain in place; no commit or publication was made.
