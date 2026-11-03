# Profile and Status full E2E verification

Tested 2026-11-03 against real React, authentication, Fastify, PostgreSQL and Socket.IO. **60 browser checks and 16 HTTP/database checks passed.** No profile API, image decoder, canvas, clock or database responses were mocked in this E2E run.

## Environment and scope

A fresh synthetic user and a workspace named `Profile E2E 1793702624761` were created through the real app at `http://127.0.0.1:5173/chat`. Existing user profiles were not edited. The shared database was already at migration 014; this run did not apply migrations.

Concurrent development repeatedly reloaded Vite during open-dialog checks. The remaining long-running scenarios used a frozen copy of the production frontend on port 5180 and the actual compiled API on port 5181, with the same real database and normal authentication. This test API also ran real Socket.IO. Final persisted state and chat integration were checked again in the shared app on port 5173. The temporary 5180/5181 processes were stopped afterward.

This verifies the implemented signed-in user's Profile/Status flows. It does not establish production deployment, multi-browser compatibility, load performance, calendar integration, notification pausing or other unimplemented settings.

## Results

| Area | Browser and real-service observations | Result |
| --- | --- | --- |
| Authentication | Real signup, workspace/channel creation, sign-out/sign-in, and profile/status persistence across a new session | Pass |
| Profile | Full/display name, title, pronunciation, phone and timezone saved; whitespace-only display name disables Save; reload preserves values | Pass |
| Photo upload | Real PNG, JPEG and WebP selected through the browser file chooser; real decoding/canvas conversion produces a 192×192 JPEG | Pass |
| Photo persistence | Saved photo survives reload; saving removal restores initials after reload; cancelling removal keeps the previous photo | Pass |
| Invalid photos | Non-image, >5 MB file and corrupt PNG rejected; editor remains usable; SVG/remote URL and request-size constraints checked through HTTP | Pass |
| Cancel | Profile text/photo drafts and status preset/text drafts discarded without overwriting saved state | Pass |
| Save failure | Real browser network offline during save produces an error and retains the draft; reconnect/retry saves successfully | Pass |
| Availability | Manual away persists after reload; switching back to active is reflected in the persisted profile | Pass |
| Presets | Meeting selects one hour, Commuting 30 minutes, Out sick/Working remotely Today, Vacationing never clears | Pass |
| Custom status | Custom text and selected emoji persist after reload; never-clear remains unexpired; both menu Clear status and editor Clear all + Save remove status | Pass |
| Expiration | A native custom date was saved and matched PostgreSQL exactly; real wall-clock expiration clears the open client without reload and stays cleared after reload | Pass |
| Editing an expired status | Existing editor remains usable and reports that the status expired instead of crashing | Pass |
| Timezone | Today with profile timezone America/New_York saved exactly 2026-11-04T05:00:00.000Z, midnight in that timezone, while the browser was in UTC+07 | Pass |
| Keyboard | Ctrl+Shift+Y opens status; Tab stays inside the native modal; Escape dismisses the emoji picker before the modal; profile Escape restores account-button focus | Pass |
| Desktop | 700px profile editor, 44px inputs, 12px input radius; Save footer remains inside the viewport; light and dark themes work | Pass |
| Mobile | Profile pane and editor fit 390px/320px without horizontal overflow; real profile save at 320×568 succeeds and persists after desktop reload | Pass |
| Chat integration | Draft survives profile/name editing; real message uses the saved display name; shared app loads message history after the fix below | Pass |
| Session expiration | Expiring only the synthetic user's sessions removes the open profile and returns to sign-in; draft does not overwrite saved data; a separately expired credential gets HTTP 401 on PATCH | Pass |
| Access boundaries | Unauthenticated GET rejected; unknown target-user and auth/email fields rejected; cross-origin cookie-authenticated writes rejected; invalid timezone/status deadlines rejected | Pass |

The browser date-input adapter needed native arrow-key input after `fill()` to commit React's controlled datetime value. The test used ordinary keyboard actions and then verified the committed value. This was a test-tool interaction adjustment, not a product change. Network emulation and viewport overrides were restored.

## Bug found and fixed

The final shared development app remained stuck on `Loading messages…` with no Socket.IO connection attempt. The new `useMessageHistory` hook invalidated its first request during React StrictMode's effect replay, but left `busy.current` set. The replayed load returned immediately; the cancelled response was discarded, so history never became ready.

The cleanup now releases the busy flag as it invalidates the old request. `apps/web/src/useMessageHistory.test.tsx` reproduced the failure before the fix and passed afterward. The real shared-app browser recheck loaded the stored message and reached Live.

After the fix, all **25 focused history/profile/chat regression tests**, the workspace typecheck (**19 tasks**) and the full build (**11 tasks**) passed. Existing dependency-level build warnings remain.

## Retained evidence

Detailed per-check results and frozen build hashes:

- `/Users/kai/.codex-artifacts/space-profile-e2e-1793702624761/browser-results.json`
- `/Users/kai/.codex-artifacts/space-profile-e2e-1793702624761/server-results.json`
- `/Users/kai/.codex-artifacts/space-profile-e2e-1793702624761/build-manifest.json`
- Native-file fixtures, mobile screenshots and test-server scripts in the same directory. Authentication cookie/token values were not written to these result files.

Final screenshot from the shared app, showing a synthetic profile, saved photo/status and real chat message:

![Completed Profile/Status E2E](/Users/kai/.codex/visualizations/2026/11/03/01a1a0e8-95d9-70f2-acad-e83f479a07e4/profile-status-full-e2e.png)
