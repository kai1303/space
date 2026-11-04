# Spacebot Grokbots renderer

User approved replacing the current Spacebot with the inspected Purple Circle / Attentive Grokbots renderer and preserving the complete avatar behavior.

- Preserve the inspected pure geometry/pose engine locally, including all shape, expression and animation presets. Record source hashes and attribution; no remote script runtime.
- Build one reusable SVG component for NavigationIcon and the Spacebot welcome surface. Preserve clay gradient, masks, 64-point geometry, 240ms gaze easing, 450ms morphs, idle breathing/blinks, cursor tracking and transient poses.
- Keep animation DOM writes inside the avatar; no parent/chat state updates per frame. Pause offscreen/background/reduced-motion and clean up frames, listeners and deadlines.
- Test geometric validity and transitions, component identity/render isolation, prop changes, transient-state completion and lifecycle cleanup. Then run affected UI/web tests, build and browser comparison.

## Verified

- Exact captured pure geometry/preset definitions retained; local renderer uses the Purple Circle / Attentive defaults in the rail, header and welcome screen.
- Original gaze/morph timings and all presets supported. Review caught and fixed minimum-playback deadlines, idle-to-initial-pose entrance and consistent settled static/reduced-motion updates.
- 180 shared UI tests, 24 destination/shell tests and 69 chat tests passed (273 total). Dependency-aware web build and TypeScript checks passed; scoped whitespace checks passed.
- Isolated browser checks at both production preview and regular http://127.0.0.1:5173/chat verified three avatar placements, live eye-matrix changes with cursor movement and no horizontal overflow. No messages were sent. Preview tab/server cleaned up.
- Local API was found stopped and restarted from its existing build with the existing .env; no database or configuration changes were made for this task.
- Source/pose parity and lifecycle fixes independently reviewed with no remaining material findings. Other current backend edits belong to concurrent work and were preserved.
