# Workspace transition check — 2026-11-03

Workspace navigation now uses the installed Motion.dev library and the shared 180 ms `motionTransition` easing. This timing is authored Space behavior; it is not a measured Slack timing. Existing Slack-derived chrome and layout remain the reference for appearance.

Channel discovery and initial message history show static skeletons instead of briefly claiming the workspace is empty. The incoming room fades from 0.65 to 1 opacity when history is available. Reduced motion sets opacity directly to 1 and uses zero animation duration. There is no exit retention for the keyed workspace/channel: the old socket and content unmount immediately.

Initial history and older pages seed message arrival tracking without replaying individual message entrances. Live arrivals retain their existing motion. Authorization loss bypasses thread/search exit animation and immediately removes channel memory/source content.

## Verification

- Regression tests first reproduced the false empty state, initial history replay, and retained thread after access loss; each passes after the corresponding fix.
- Browser switched between the local QA workspaces `Space studio` and `Motion QA` at 895 × 853. Sampled room opacity progressed 0.991748 → 0.996844 → 0.999497 → 0.999958 → 1; width stayed 627 px and the historical message opacity stayed 1.
- Snapshot and sample data: `/Users/kai/.codex/visualizations/2026/11/03/01a19f82-8391-7ba3-a409-61a31b7bca6b/space-workspace-motion.jpg` and `workspace-motion-samples.json` in the same folder.
- UI package: 64 tests passed. Web production build passed. Focused chat/navigation/upload/access tests passed; see `/tmp/space-workspace-motion-verified.log` for the final run.

The broad web-suite run had failures in attachment preview recovery, the synthetic Conversation thread switch, and a late memory-connection secret; an onboarding test was also being added concurrently. Those separate changes are outside this transition check. Other active threads were changing overlays and onboarding during this run. The browser check is a visual/style observation, not an FPS or low-end-device performance benchmark. System reduced-motion behavior is covered by the shared timing tests, not a browser preference override.
